import type { FastifyInstance } from "fastify";
import { verifications } from "../models/repo.js";
import { requireAuth } from "../lib/auth.js";

/** Étoffe une vérification avec ses champs JSON décodés pour l'UI. */
function expand(v: ReturnType<typeof verifications.get> & object) {
  return {
    ...v,
    row_counts: v.row_counts_json ? JSON.parse(v.row_counts_json) : {},
    errors: v.errors_json ? JSON.parse(v.errors_json) : [],
    report: v.report_json ? JSON.parse(v.report_json) : null,
  };
}

export async function verificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/verifications", async (req) => {
    const q = req.query as { backup_id?: string; database_id?: string };
    return verifications.list({
      backupId: q.backup_id ? Number(q.backup_id) : undefined,
      databaseId: q.database_id ? Number(q.database_id) : undefined,
    });
  });

  app.get("/api/verifications/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const v = verifications.get(id);
    if (!v) return reply.code(404).send({ error: "Introuvable" });
    return expand(v);
  });
}
