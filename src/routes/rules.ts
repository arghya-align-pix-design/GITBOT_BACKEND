import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * GET /api/rules?repositoryId=<id>
 *
 * List all rules for a given connected repository.
 * Validates that the requesting user owns the repository.
 */
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const { repositoryId } = req.query as { repositoryId?: string };
    const githubLogin = req.user?.githubLogin;

    if (!repositoryId) {
      res.status(400).json({ error: "Missing repositoryId query parameter" });
      return;
    }

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    // Verify user owns this repository
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId },
      include: { user: { select: { githubLogin: true } } },
    });

    if (!repo || repo.user.githubLogin !== githubLogin) {
      res.status(404).json({ error: "Repository not found or access denied" });
      return;
    }

    const rules = await prisma.rule.findMany({
      where: { repositoryId },
      orderBy: { createdAt: "desc" },
    });

    res.json(rules);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to list rules: ${message}` });
  }
});

/**
 * POST /api/rules
 *
 * Create a new automation rule for a repository.
 * Body: { repositoryId, eventType, matchField, matchValue, labelToAdd?, slackNotify? }
 */
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;
    const { repositoryId, eventType, matchField, matchValue, labelToAdd, slackNotify } = req.body as {
      repositoryId: string;
      eventType: string;
      matchField: string;
      matchValue: string;
      labelToAdd?: string;
      slackNotify?: boolean;
    };

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    if (!repositoryId || !eventType || !matchField || !matchValue) {
      res.status(400).json({ error: "Missing required fields: repositoryId, eventType, matchField, matchValue" });
      return;
    }

    // Validate eventType
    const validEvents = ["issues", "pull_request", "push"];
    if (!validEvents.includes(eventType)) {
      res.status(400).json({ error: `Invalid eventType. Must be one of: ${validEvents.join(", ")}` });
      return;
    }

    // Validate matchField
    const validFields = ["title", "body", "author"];
    if (!validFields.includes(matchField)) {
      res.status(400).json({ error: `Invalid matchField. Must be one of: ${validFields.join(", ")}` });
      return;
    }

    // Verify user owns this repository
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId },
      include: { user: { select: { githubLogin: true } } },
    });

    if (!repo || repo.user.githubLogin !== githubLogin) {
      res.status(404).json({ error: "Repository not found or access denied" });
      return;
    }

    const rule = await prisma.rule.create({
      data: {
        repositoryId,
        eventType,
        matchField,
        matchValue,
        labelToAdd: labelToAdd ?? null,
        slackNotify: slackNotify ?? true,
      },
    });

    res.status(201).json(rule);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to create rule: ${message}` });
  }
});

/**
 * DELETE /api/rules/:id
 *
 * Delete an automation rule. Validates ownership via repository → user chain.
 */
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const githubLogin = req.user?.githubLogin;
    const id = req.params.id as string;

    if (!githubLogin) {
      res.status(400).json({ error: "GitHub login not found in token" });
      return;
    }

    // Find rule and verify ownership
    const rule = await prisma.rule.findUnique({ where: { id } });

    if (!rule) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }

    const repo = await prisma.repository.findFirst({
      where: { id: rule.repositoryId },
      include: { user: { select: { githubLogin: true } } },
    });

    if (!repo || repo.user.githubLogin !== githubLogin) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    await prisma.rule.delete({ where: { id } });

    res.json({ deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to delete rule: ${message}` });
  }
});

export default router;
