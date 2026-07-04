import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";

const router = Router();

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? "";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Verify the GitHub webhook signature using HMAC-SHA256.
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 */
function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !WEBHOOK_SECRET) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signatureHeader, "utf8")
    );
  } catch {
    return false;
  }
}

/**
 * Extract field values from webhook payload for rule matching.
 * Now extended to handle issues, pull_request, push, issue_comment, pull_request_review, and pull_request_review_comment.
 */
function extractField(
  payload: Record<string, unknown>,
  eventType: string,
  matchField: string
): string | null {
  if (eventType === "issues") {
    const issue = payload.issue as Record<string, unknown> | undefined;
    if (!issue) return null;
    if (matchField === "title") return (issue.title as string) ?? null;
    if (matchField === "body") return (issue.body as string) ?? null;
    if (matchField === "author") {
      const user = issue.user as Record<string, unknown> | undefined;
      return (user?.login as string) ?? null;
    }
  }

  if (eventType === "pull_request") {
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (!pr) return null;
    if (matchField === "title") return (pr.title as string) ?? null;
    if (matchField === "body") return (pr.body as string) ?? null;
    if (matchField === "author") {
      const user = pr.user as Record<string, unknown> | undefined;
      return (user?.login as string) ?? null;
    }
  }

  if (eventType === "push") {
    // For push events:
    // - "title" matches any commit message
    // - "body" matches all commit messages combined
    // - "author" matches the pusher login or any commit author
    const pusher = payload.pusher as Record<string, unknown> | undefined;
    const commits = (payload.commits as Array<Record<string, unknown>>) ?? [];

    if (matchField === "author") {
      const pusherName = (pusher?.name as string) ?? "";
      if (pusherName) return pusherName;
      // Fallback to commit authors
      return commits.map((c) => (c.author as Record<string, unknown>)?.username ?? "").join(" ");
    }
    if (matchField === "title") {
      return commits.map((c) => c.message as string).join(" | ");
    }
    if (matchField === "body") {
      return commits.map((c) => c.message as string).join("\n");
    }
  }

  if (eventType === "issue_comment") {
    const comment = payload.comment as Record<string, unknown> | undefined;
    const issue = payload.issue as Record<string, unknown> | undefined;
    if (!comment) return null;
    if (matchField === "title") return (issue?.title as string) ?? null;
    if (matchField === "body") return (comment.body as string) ?? null;
    if (matchField === "author") {
      const user = comment.user as Record<string, unknown> | undefined;
      return (user?.login as string) ?? null;
    }
  }

  if (eventType === "pull_request_review" || eventType === "pull_request_review_comment") {
    const review = (payload.review ?? payload.comment) as Record<string, unknown> | undefined;
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (!review) return null;
    if (matchField === "title") return (pr?.title as string) ?? null;
    if (matchField === "body") return ((review.body ?? review.html_url) as string) ?? null;
    if (matchField === "author") {
      const user = review.user as Record<string, unknown> | undefined;
      return (user?.login as string) ?? null;
    }
  }

  return null;
}

/** Check if a field value matches a rule (case-insensitive contains, supports * wildcard for match-all) */
function matchesRule(fieldValue: string | null, matchValue: string): boolean {
  if (matchValue.trim() === "*") return true;
  if (!fieldValue) return false;
  return fieldValue.toLowerCase().includes(matchValue.toLowerCase());
}

/** Add a label to an issue or PR on GitHub */
async function addGitHubLabel(
  repoFullName: string,
  issueNumber: number,
  label: string,
  accessToken: string
): Promise<boolean> {
  const [owner, repo] = repoFullName.split("/");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ labels: [label] }),
    }
  );
  return response.ok;
}

/** Send a notification to Slack via incoming webhook */
export async function sendSlackNotification(
  repoFullName: string,
  eventType: string,
  action: string,
  title: string,
  description: string,
  url: string
): Promise<boolean> {
  if (!SLACK_WEBHOOK_URL) return false;

  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🤖 GITBOT — Webhook Notification`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Repository:*\n${repoFullName}` },
          { type: "mrkdwn", text: `*Event:*\n${eventType}.${action}` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Summary:* ${title}\n*Details:* ${description}` },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View on GitHub" },
            url,
          },
        ],
      },
    ],
  };

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return response.ok;
}

// ── Route ───────────────────────────────────────────────────

/**
 * POST /api/webhooks/github
 *
 * Receives webhook events from GitHub.
 * Protected by HMAC signature verification.
 */
router.post("/github", async (req: Request, res: Response): Promise<void> => {
  try {
    // ── Step 1: Verify HMAC Signature ────────────────────
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = req.rawBody;

    if (!rawBody || !verifySignature(rawBody, signature)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    // ── Step 2: Extract Headers ─────────────────────────
    const eventType = req.headers["x-github-event"] as string | undefined;
    const deliveryId = req.headers["x-github-delivery"] as string | undefined;

    if (!eventType || !deliveryId) {
      res.status(400).json({ error: "Missing required GitHub webhook headers" });
      return;
    }

    const payload = req.body as Record<string, unknown>;
    const action = (payload.action as string) ?? null;

    console.info(`[Webhook] event="${eventType}" action="${action ?? "n/a"}" delivery="${deliveryId}"`);

    // ── Step 3: Idempotency Check ───────────────────────
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { deliveryId },
    });

    if (existingEvent) {
      console.info(`[Webhook] Duplicate delivery ${deliveryId}, skipping`);
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    // ── Step 4: Identify Repository ─────────────────────
    const ghRepo = payload.repository as Record<string, unknown> | undefined;
    const repoFullName = (ghRepo?.full_name as string) ?? "";

    const repository = await prisma.repository.findFirst({
      where: { repoFullName },
      include: { user: { select: { accessToken: true } } },
    });

    if (!repository) {
      // We received a webhook for a repo we don't track — acknowledge but skip
      console.info(`[Webhook] Unknown repo ${repoFullName}, skipping`);
      res.status(200).json({ received: true, tracked: false });
      return;
    }

    // ── Step 5: Save Webhook Event ──────────────────────
    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        deliveryId,
        repositoryId: repository.id,
        eventType,
        action,
        payload: payload as object,
      },
    });

    // ── Step 6: Extract Event Metadata ──────────────────
    let eventAuthor = "";
    let eventTitle = "";
    let eventBody = "";
    let issueNumber = 0;
    let htmlUrl = "";

    if (eventType === "issues") {
      const issue = payload.issue as Record<string, unknown> | undefined;
      eventAuthor = (issue?.user as Record<string, unknown> | undefined)?.login as string ?? "";
      eventTitle = (issue?.title as string) ?? "";
      eventBody = (issue?.body as string) ?? "";
      issueNumber = (issue?.number as number) ?? 0;
      htmlUrl = (issue?.html_url as string) ?? "";
    } else if (eventType === "pull_request") {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      eventAuthor = (pr?.user as Record<string, unknown> | undefined)?.login as string ?? "";
      eventTitle = (pr?.title as string) ?? "";
      eventBody = (pr?.body as string) ?? "";
      issueNumber = (pr?.number as number) ?? 0;
      htmlUrl = (pr?.html_url as string) ?? "";
    } else if (eventType === "push") {
      const pusher = payload.pusher as Record<string, unknown> | undefined;
      eventAuthor = (pusher?.name as string) ?? "";
      const commits = (payload.commits as Array<Record<string, unknown>>) ?? [];
      const ref = (payload.ref as string) ?? "";
      const branchName = ref.replace("refs/heads/", "");
      eventTitle = `Pushed to ${branchName}`;
      eventBody = commits.map((c) => `${c.message} (by ${(c.author as Record<string, unknown>)?.name ?? ""})`).join("\n");
      htmlUrl = (payload.compare as string) ?? (ghRepo?.html_url as string) ?? "";
    } else if (eventType === "issue_comment") {
      const comment = payload.comment as Record<string, unknown> | undefined;
      const issue = payload.issue as Record<string, unknown> | undefined;
      eventAuthor = (comment?.user as Record<string, unknown> | undefined)?.login as string ?? "";
      eventTitle = `Comment on issue #${issue?.number}: ${(issue?.title as string) ?? ""}`;
      eventBody = (comment?.body as string) ?? "";
      issueNumber = (issue?.number as number) ?? 0;
      htmlUrl = (comment?.html_url as string) ?? "";
    } else if (eventType === "pull_request_review") {
      const review = payload.review as Record<string, unknown> | undefined;
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      eventAuthor = (review?.user as Record<string, unknown> | undefined)?.login as string ?? "";
      eventTitle = `Review on PR #${pr?.number}: ${(pr?.title as string) ?? ""}`;
      eventBody = `State: ${review?.state as string}. ${(review?.body as string) ?? ""}`;
      issueNumber = (pr?.number as number) ?? 0;
      htmlUrl = (review?.html_url as string) ?? "";
    } else if (eventType === "pull_request_review_comment") {
      const comment = payload.comment as Record<string, unknown> | undefined;
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      eventAuthor = (comment?.user as Record<string, unknown> | undefined)?.login as string ?? "";
      eventTitle = `Comment on PR review #${pr?.number}: ${(pr?.title as string) ?? ""}`;
      eventBody = (comment?.body as string) ?? "";
      issueNumber = (pr?.number as number) ?? 0;
      htmlUrl = (comment?.html_url as string) ?? "";
    } else if (eventType === "ping") {
      // Standard GitHub ping test
      console.info(`[Webhook] Ping received from repository ${repoFullName}`);
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processed: true },
      });
      res.status(200).json({ received: true, processed: true, ping: true });
      return;
    }

    console.info(`[Webhook] Processing event for ${eventAuthor} in ${repoFullName}`);

    // ── Step 7: Rule Matching Engine ────────────────────
    const rules = await prisma.rule.findMany({
      where: { repositoryId: repository.id, eventType },
    });


    let matchCount = 0;

    for (const rule of rules) {
      const fieldValue = extractField(payload, eventType, rule.matchField);
      if (!matchesRule(fieldValue, rule.matchValue)) continue;

      matchCount++;
      console.info(`[Webhook] Rule matched: ${rule.matchField} contains "${rule.matchValue}"`);

      // ── Action: Add Label ─────────────────────────
      if (rule.labelToAdd && issueNumber > 0) {
        const labelSuccess = await addGitHubLabel(
          repoFullName,
          issueNumber,
          rule.labelToAdd,
          repository.user.accessToken
        );

        await prisma.botAction.create({
          data: {
            webhookEventId: webhookEvent.id,
            repositoryId: repository.id,
            actionType: "add_label",
            status: labelSuccess ? "success" : "failed",
            detail: `Label "${rule.labelToAdd}" on #${issueNumber}`,
          },
        });
      }

      // ── Action: Slack Notification ────────────────
      if (rule.slackNotify) {
        const ruleDesc = `${rule.matchField} contains "${rule.matchValue}"`;
        const slackSuccess = await sendSlackNotification(
          repoFullName,
          eventType,
          action ?? "webhook",
          eventTitle,
          `Rule matched: ${ruleDesc}\nEvent Details: ${eventBody.substring(0, 200)}`,
          htmlUrl
        );

        await prisma.botAction.create({
          data: {
            webhookEventId: webhookEvent.id,
            repositoryId: repository.id,
            actionType: "slack_notify",
            status: slackSuccess ? "success" : "failed",
            detail: SLACK_WEBHOOK_URL ? `Slack notification for rule: "${ruleDesc}"` : "Skipped — SLACK_WEBHOOK_URL not configured",
          },
        });
      }
    }

    // Mark event as processed
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processed: true },
    });

    res.status(200).json({ received: true, processed: true, rulesEvaluated: rules.length, rulesMatched: matchCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Webhook] Error processing event: ${message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
