import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { sendSlackNotification, SLACK_WEBHOOK_URL } from "./webhooks.js";

const router = Router();

/** Shape of a GitHub repo from the API */
interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
}

/**
 * GET /api/repos/list
 *
 * Returns the user's GitHub repos (from GitHub API) + marks which are already connected.
 * Protected by auth middleware.
 */
router.get("/list", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { githubLogin },
      include: { repositories: { select: { repoFullName: true } } },
    });

    if (!user) {
      res.status(404).json({ error: "User not found in database" });
      return;
    }

    const ghResponse = await fetch(
      "https://api.github.com/user/repos?sort=updated&per_page=30",
      {
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!ghResponse.ok) {
      const errBody = await ghResponse.text();
      res.status(ghResponse.status).json({
        error: `GitHub API error: ${ghResponse.status}`,
        detail: errBody,
      });
      return;
    }

    const repos = (await ghResponse.json()) as GitHubRepo[];

    const connectedSet = new Set(user.repositories.map((r) => r.repoFullName));

    const result = repos.map((repo) => ({
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      description: repo.description,
      connected: connectedSet.has(repo.full_name),
    }));

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to list repos: ${message}` });
  }
});

/**
 * GET /api/repos/connected
 *
 * Returns the user's connected repositories from the database.
 * Protected by auth middleware.
 */
router.get("/connected", async (req: Request, res: Response): Promise<void> => {
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

    const repos = await prisma.repository.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        repoName: true,
        repoFullName: true,
        webhookId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(repos);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to list connected repos: ${message}` });
  }
});

/**
 * POST /api/repos/connect
 *
 * Registers a GitHub webhook on the specified repository and saves it to the database.
 * Body: { repoFullName: string }
 * Protected by auth middleware.
 */
router.post("/connect", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;
    const { repoFullName } = req.body as { repoFullName: string };

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    if (!repoFullName) {
      res.status(400).json({ error: "Missing repoFullName in request body" });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { githubLogin },
    });

    if (!user) {
      res.status(404).json({ error: "User not found in database" });
      return;
    }

    const existing = await prisma.repository.findFirst({
      where: { userId: user.id, repoFullName },
    });

    if (existing) {
      res.status(409).json({ error: "Repository is already connected", repository: existing });
      return;
    }

    const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL;
    const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

    if (!BACKEND_PUBLIC_URL || !GITHUB_WEBHOOK_SECRET) {
      res.status(500).json({ error: "Server misconfiguration: missing BACKEND_PUBLIC_URL or GITHUB_WEBHOOK_SECRET" });
      return;
    }

    const [owner, repo] = repoFullName.split("/");

    // Register webhook on GitHub for issues, pull_request, push, comments, reviews
    const ghResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/hooks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: [
            "issues",
            "pull_request",
            "push",
            "issue_comment",
            "pull_request_review",
            "pull_request_review_comment"
          ],
          config: {
            url: `${BACKEND_PUBLIC_URL}/api/webhooks/github`,
            content_type: "json",
            secret: GITHUB_WEBHOOK_SECRET,
            insecure_ssl: "0",
          },
        }),
      }
    );

    if (!ghResponse.ok) {
      const errBody = await ghResponse.text();
      res.status(ghResponse.status).json({
        error: `GitHub webhook registration failed: ${ghResponse.status}`,
        detail: errBody,
      });
      return;
    }

    const webhookData = (await ghResponse.json()) as { id: number };

    const repository = await prisma.repository.create({
      data: {
        userId: user.id,
        repoName: repo ?? repoFullName,
        repoFullName,
        webhookId: String(webhookData.id),
      },
    });

    res.status(201).json({
      id: repository.id,
      repoName: repository.repoName,
      repoFullName: repository.repoFullName,
      webhookId: repository.webhookId,
      createdAt: repository.createdAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to connect repo: ${message}` });
  }
});

/**
 * DELETE /api/repos/:id
 *
 * Disconnects a repository, deletes the GitHub webhook, and removes all local database records.
 * Protected by auth middleware.
 */
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;
    const id = req.params.id as string;

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    // Verify ownership and load user's token
    const repository = (await prisma.repository.findUnique({
      where: { id },
      include: { user: true },
    })) as any;

    if (!repository || repository.user.githubLogin !== githubLogin) {
      res.status(404).json({ error: "Repository not found or access denied" });
      return;
    }

    // Attempt to delete webhook on GitHub
    if (repository.webhookId) {
      const [owner, repo] = repository.repoFullName.split("/");
      try {
        const ghResponse = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/hooks/${repository.webhookId}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${repository.user.accessToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }
        );
        if (!ghResponse.ok && ghResponse.status !== 404) {
          console.warn(`Failed to delete GitHub webhook: ${ghResponse.status}`);
        }
      } catch (err) {
        console.error("Error communicating with GitHub to delete webhook:", err);
      }
    }

    // Clean up dependent database records
    await prisma.$transaction([
      prisma.botAction.deleteMany({ where: { repositoryId: id as any } }),
      prisma.webhookEvent.deleteMany({ where: { repositoryId: id as any } }),
      prisma.rule.deleteMany({ where: { repositoryId: id as any } }),
      prisma.repository.delete({ where: { id: id as any } }),
    ]);

    res.json({ success: true, message: `Successfully disconnected ${repository.repoFullName}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to disconnect repository: ${message}` });
  }
});

/**
 * POST /api/repos/:id/ping
 *
 * Triggers a webhook ping test to verify the connection.
 * Protected by auth middleware.
 */
router.post("/:id/ping", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;
    const id = req.params.id as string;

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    const repository = (await prisma.repository.findUnique({
      where: { id },
      include: { user: true },
    })) as any;

    if (!repository || repository.user.githubLogin !== githubLogin) {
      res.status(404).json({ error: "Repository not found or access denied" });
      return;
    }

    if (!repository.webhookId) {
      res.status(400).json({ error: "Repository does not have a webhook ID registered" });
      return;
    }

    const [owner, repo] = repository.repoFullName.split("/");

    const ghResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/hooks/${repository.webhookId}/tests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${repository.user.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!ghResponse.ok) {
      const errBody = await ghResponse.text();
      res.status(ghResponse.status).json({
        error: `Failed to trigger ping test: ${ghResponse.status}`,
        detail: errBody,
      });
      return;
    }

    res.json({ success: true, message: "Ping test triggered successfully" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to test webhook connection: ${message}` });
  }
});

/**
 * POST /api/repos/:id/slack-ping
 *
 * Triggers a test notification directly to the user's Slack webhook.
 * Protected by auth middleware.
 */
router.post("/:id/slack-ping", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;
    const id = req.params.id as string;

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    const repository = (await prisma.repository.findUnique({
      where: { id },
      include: { user: true },
    })) as any;

    if (!repository || repository.user.githubLogin !== githubLogin) {
      res.status(404).json({ error: "Repository not found or access denied" });
      return;
    }

    if (!SLACK_WEBHOOK_URL) {
      res.status(400).json({ error: "Slack Webhook URL is not configured in backend .env file" });
      return;
    }

    const message = `Slack connection check: The delivery pipeline from GITBOT to Slack for repository ${repository.repoFullName} is active and healthy! 🚀`;

    const slackSuccess = await sendSlackNotification(
      repository.repoFullName,
      "sanity_check",
      "ping",
      "Slack Ping Check",
      message,
      `https://github.com/${repository.repoFullName}`
    );

    // Save as WebhookEvent and BotAction so it shows up in the timeline stream
    const deliveryId = `slack-ping-${Date.now()}`;
    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        deliveryId,
        repositoryId: repository.id,
        eventType: "slack_ping",
        action: "ping",
        payload: { status: slackSuccess ? "success" : "failed", message },
        processed: true,
      },
    });

    await prisma.botAction.create({
      data: {
        webhookEventId: webhookEvent.id,
        repositoryId: repository.id,
        actionType: "slack_notify",
        status: slackSuccess ? "success" : "failed",
        detail: `Slack ping status: ${slackSuccess ? "Sent" : "Failed"}. Message: "${message}"`,
      },
    });

    if (!slackSuccess) {
      res.status(502).json({ error: "Failed to send notification to Slack webhook" });
      return;
    }

    res.json({ success: true, message: "Slack ping notification sent successfully!" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to trigger Slack ping test: ${message}` });
  }
});

export default router;

