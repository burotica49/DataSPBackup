import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { users } from "../models/repo.js";
import { verifyPassword } from "../services/crypto/crypto.js";
import {
  clearSessionCookie,
  issueToken,
  requireAuth,
  setSessionCookie,
  type SessionUser,
} from "../lib/auth.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Requête invalide" });
    }
    const user = users.findByEmail(parsed.data.email);
    if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
      return reply.code(401).send({ error: "Identifiants invalides" });
    }
    const token = issueToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });
    setSessionCookie(reply, token);
    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    return { user: (req as { user?: SessionUser }).user };
  });
}
