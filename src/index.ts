import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { authMiddleware } from "./middleware/auth.js";
import usersRouter from "./routes/users.js";
import reposRouter from "./routes/repos.js";
import rulesRouter from "./routes/rules.js";
import webhooksRouter from "./routes/webhooks.js";
import activityRouter from "./routes/activity.js";

const app = express();
const PORT = parseInt(process.env.PORT ?? "8000", 10);

// ── Global Middleware ────────────────────────────────────────
app.use(helmet());

// CORS — whitelist only the frontend origin
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// JSON body parser with raw body capture for webhook HMAC verification.
// The `verify` callback saves the raw buffer on `req.rawBody` so the
// webhook route can compute the HMAC signature against the exact bytes
// GitHub sent, rather than a re-serialized version.
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  } as Parameters<typeof express.json>[0] & { verify: (req: Request, res: Response, buf: Buffer) => void })
);

// ── Health Check (public) ────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Webhook Route (public — uses HMAC, not JWT auth) ─────────
app.use("/api/webhooks", webhooksRouter);

// ── Protected Routes (all go through auth middleware) ────────
app.use("/api/users", authMiddleware, usersRouter);
app.use("/api/repos", authMiddleware, reposRouter);
app.use("/api/rules", authMiddleware, rulesRouter);
app.use("/api/activity", authMiddleware, activityRouter);

// ── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.info(`✦ GITBOT backend running on http://localhost:${PORT}`);
  console.info(`  CORS origin: ${FRONTEND_URL}`);
});

export default app;
