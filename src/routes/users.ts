import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * POST /api/users/upsert
 *
 * Called by the frontend on sign-in to sync the GitHub user into our database.
 * Body: { githubId, githubLogin, accessToken }
 * Protected by auth middleware.
 */
router.post("/upsert", async (req: Request, res: Response): Promise<void> => {
  try {
    const { githubId, githubLogin, accessToken } = req.body as {
      githubId: string;
      githubLogin: string;
      accessToken: string;
    };

    if (!githubId || !githubLogin || !accessToken) {
      res.status(400).json({ error: "Missing required fields: githubId, githubLogin, accessToken" });
      return;
    }

    const user = await prisma.user.upsert({
      where: { githubId },
      update: { githubLogin, accessToken },
      create: { githubId, githubLogin, accessToken },
    });

    // Return user record WITHOUT accessToken
    res.json({
      id: user.id,
      githubId: user.githubId,
      githubLogin: user.githubLogin,
      createdAt: user.createdAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Failed to upsert user: ${message}` });
  }
});

export default router;
