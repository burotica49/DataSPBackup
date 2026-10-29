import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backups, databases } from "../models/repo.js";
import { requestBackup, requestVerification } from "../services/scheduler/jobs.js";
import { requireAuth } from "../lib/auth.js";

const runSchema = z.object({
  database_id: z.number().int().positive(),
  encrypt: z.boolean().default(true),
  verify_after: z.boolean().default(true),
});

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/backups", async (req) => {
    const q = req.query as { database_id?: string };
    return backups.list(q.database_id ? Number(q.database_id) : undefined);
  });

  app.get("/api/backups/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = backups.get(id);
    if (!b) return reply.code(404).send({ error: "Introuvable" });
    return b;
  });

  // Déclenche une sauvegarde manuelle (asynchrone).
  app.post("/api/backups/run", async (req, reply) => {
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!databases.get(parsed.data.database_id)) {
      return reply.code(404).send({ error: "Base introuvable" });
    }
    const { backupId } = requestBackup({
      databaseId: parsed.data.database_id,
      trigger: "manual",
      encrypt: parsed.data.encrypt,
      verifyAfter: parsed.data.verify_after,
    });
    return reply.code(202).send({ backup_id: backupId, status: "queued" });
  });

  // Déclenche une vérification manuelle d'une sauvegarde existante.
  app.post("/api/backups/:id/verify", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const res = requestVerification(id, "manual");
    if (!res) {
      return reply
        .code(409)
        .send({ error: "Sauvegarde introuvable ou non réussie" });
    }
    return reply.code(202).send({ verification_id: res.verificationId });
  });
}
