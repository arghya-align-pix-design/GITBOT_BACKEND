import type { JWTPayload } from "jose";

/** Shape of the decoded NextAuth JWT payload attached to req.user */
export interface AuthUser extends JWTPayload {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  githubLogin?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      rawBody?: Buffer;
    }
  }
}
