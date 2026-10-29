import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

const COOKIE = "dsb_session";
const TTL = "7d";

export interface SessionUser {
  id: number;
  email: string;
  role: string;
}

export function issueToken(user: SessionUser): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: TTL });
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: "/" });
}

function readToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  return cookie ?? null;
}

/** preHandler Fastify : exige une session valide, pose req.user. */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = readToken(req);
  if (!token) {
    reply.code(401).send({ error: "Authentification requise" });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as SessionUser;
    (req as FastifyRequest & { user?: SessionUser }).user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
    };
  } catch {
    reply.code(401).send({ error: "Session invalide ou expirée" });
  }
}
