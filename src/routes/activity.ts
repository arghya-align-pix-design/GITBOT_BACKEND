import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

/** Helper to extract original event timestamp from payload */
function getEventTimestamp(payload: any, eventType: string): Date | null {
  try {
    if (eventType === "push") {
      const commits = payload?.commits as any[];
      if (commits && commits.length > 0 && commits[0].timestamp) {
        return new Date(commits[0].timestamp);
      }
      if (payload?.repository?.pushed_at) {
        const pushedVal = payload.repository.pushed_at;
        return new Date(typeof pushedVal === "number" ? pushedVal * 1000 : pushedVal);
      }
    } else if (eventType === "issues" || eventType === "issue_comment") {
      const target = payload?.issue ?? payload?.comment;
      if (target?.updated_at ?? target?.created_at) {
        return new Date(target.updated_at ?? target.created_at);
      }
    } else if (eventType === "pull_request" || eventType === "pull_request_review" || eventType === "pull_request_review_comment") {
      const target = payload?.pull_request ?? payload?.review ?? payload?.comment;
      if (target?.updated_at ?? target?.created_at) {
        return new Date(target.updated_at ?? target.created_at);
      }
    }
  } catch (err) {
    // Ignore parsing errors
  }
  return null;
}


/**
 * GET /api/activity
 *
 * Returns recent webhook events and associated bot actions for the user's connected repositories.
 * Protected by auth middleware.
 */
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { githubLogin },
    });

    if (!user) {
      res.status(404).json({ error: "User not found in database" });
      return;
    }

    // Find all webhook events for repositories owned by this user
    const limit = parseInt(req.query.limit as string ?? "20", 10);
    const events = await prisma.webhookEvent.findMany({
      where: {
        repository: {
          userId: user.id,
        },
      },
      include: {
        repository: {
          select: {
            repoFullName: true,
            repoName: true,
          },
        },
        botActions: {
          select: {
            id: true,
            actionType: true,
            status: true,
            detail: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        receivedAt: "desc",
      },
      take: Math.min(limit, 100),
    });

    // Format the response payload for notifications/timeline
    const formattedEvents = events.map((event) => {
      const payload = event.payload as Record<string, unknown> | null;
      let author = "unknown";
      let summary = "";
      let targetUrl = "";

      // Extract detailed event metadata based on type
      if (event.eventType === "issues") {
        const issue = payload?.issue as Record<string, unknown> | undefined;
        author = (issue?.user as Record<string, unknown> | undefined)?.login as string ?? "unknown";
        summary = `${event.action ?? "interacted with"} issue #${issue?.number}: "${issue?.title ?? ""}"`;
        targetUrl = (issue?.html_url as string) ?? "";
      } else if (event.eventType === "pull_request") {
        const pr = payload?.pull_request as Record<string, unknown> | undefined;
        author = (pr?.user as Record<string, unknown> | undefined)?.login as string ?? "unknown";
        const isMerged = pr?.merged as boolean | undefined;
        const prAction = isMerged ? "merged" : (event.action ?? "interacted with");
        summary = `${prAction} PR #${pr?.number}: "${pr?.title ?? ""}"`;
        targetUrl = (pr?.html_url as string) ?? "";
      } else if (event.eventType === "push") {
        const pusher = payload?.pusher as Record<string, unknown> | undefined;
        author = (pusher?.name ?? pusher?.login) as string ?? "unknown";
        const ref = (payload?.ref as string) ?? "";
        const branchName = ref.replace("refs/heads/", "");
        const commits = (payload?.commits as Array<Record<string, unknown>>) ?? [];
        summary = `pushed ${commits.length} commit${commits.length !== 1 ? "s" : ""} to ${branchName}`;
        targetUrl = (payload?.compare as string) ?? "";
      } else if (event.eventType === "issue_comment") {
        const comment = payload?.comment as Record<string, unknown> | undefined;
        const issue = payload?.issue as Record<string, unknown> | undefined;
        author = (comment?.user as Record<string, unknown> | undefined)?.login as string ?? "unknown";
        summary = `commented on issue #${issue?.number}: "${issue?.title ?? ""}"`;
        targetUrl = (comment?.html_url as string) ?? "";
      } else if (event.eventType === "pull_request_review") {
        const review = payload?.review as Record<string, unknown> | undefined;
        const pr = payload?.pull_request as Record<string, unknown> | undefined;
        author = (review?.user as Record<string, unknown> | undefined)?.login as string ?? "unknown";
        summary = `reviewed PR #${pr?.number} (${review?.state as string ?? "commented"}): "${pr?.title ?? ""}"`;
        targetUrl = (review?.html_url as string) ?? "";
      } else if (event.eventType === "pull_request_review_comment") {
        const comment = payload?.comment as Record<string, unknown> | undefined;
        const pr = payload?.pull_request as Record<string, unknown> | undefined;
        author = (comment?.user as Record<string, unknown> | undefined)?.login as string ?? "unknown";
        summary = `commented on PR review #${pr?.number}: "${pr?.title ?? ""}"`;
        targetUrl = (comment?.html_url as string) ?? "";
      } else if (event.eventType === "ping") {
        author = "GitHub Webhook";
        summary = `triggered a connection sanity check (ping)`;
        targetUrl = `https://github.com/${event.repository.repoFullName}/settings/hooks`;
      } else if (event.eventType === "slack_ping") {
        author = "GITBOT System";
        summary = `triggered a Slack notification sanity check`;
        targetUrl = "";
      } else {
        summary = `triggered a "${event.eventType}" event`;
      }

      // Check if it is a replayed test webhook event from GitHub
      const eventTime = getEventTimestamp(payload, event.eventType);
      const isReplay = eventTime 
        ? Math.abs(new Date(event.receivedAt).getTime() - eventTime.getTime()) > 5 * 60 * 1000 
        : false;

      if (isReplay && eventTime) {
        if (event.eventType === "push") {
          const branchName = ((payload?.ref as string) ?? "").replace("refs/heads/", "");
          const commits = (payload?.commits as Array<Record<string, any>>) ?? [];
          const commitMsg = commits.length > 0 ? commits[0].message : "";
          const pusherName = ((payload?.pusher as Record<string, any>)?.name ?? "unknown");
          summary = `triggered a connection test replaying a push to ${branchName} (Last commit: ${eventTime.toLocaleString()}, Commits count: ${commits.length}, Message: "${commitMsg}", Pusher: @${pusherName})`;
        } else {
          summary = `triggered a connection test replaying a "${event.eventType}" event originally from ${eventTime.toLocaleString()}`;
        }
        author = `GitHub Test Webhook`;
      }

      return {

        id: event.id,
        deliveryId: event.deliveryId,
        repoFullName: event.repository.repoFullName,
        repoName: event.repository.repoName,
        eventType: event.eventType,
        action: event.action,
        author,
        summary,
        url: targetUrl,
        receivedAt: event.receivedAt,
        processed: event.processed,
        botActions: event.botActions,
      };
    });

    res.json(formattedEvents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to fetch activity logs: ${message}` });
  }
});

export default router;
