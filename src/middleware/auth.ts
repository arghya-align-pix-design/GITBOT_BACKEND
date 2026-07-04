import type { Request, Response, NextFunction } from "express";
import { jwtVerify } from "jose";

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

/**
 * Express middleware that verifies a NextAuth JWT (JWS / HS256).
 *
 * - Reads `Authorization: Bearer <token>` header
 * - Verifies signature using the shared NEXTAUTH_SECRET
 * - Attaches decoded payload to `req.user`
 * - Returns 401 if missing or invalid
 *
 * Does NOT perform a database lookup — trusts the JWT.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!NEXTAUTH_SECRET) {
    res.status(500).json({ error: "Server misconfiguration: missing NEXTAUTH_SECRET" });
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    res.status(401).json({ error: "Missing token" });
    return;
  }

  try {
    const secret = new TextEncoder().encode(NEXTAUTH_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    req.user = {
      sub: payload.sub ?? "",
      name: payload.name as string | undefined,
      email: payload.email as string | undefined,
      picture: payload.picture as string | undefined,
      githubLogin: payload.githubLogin as string | undefined,
      iat: payload.iat,
      exp: payload.exp,
    };

    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
