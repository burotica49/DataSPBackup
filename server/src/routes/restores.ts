import type { FastifyInstance } from "fastify";
import { restores } from "../models/repo.js";
import { requireAuth } from "../lib/auth.js";

function expand(r: ReturnType<typeof restores.get> & object) {
  return {
    ...r,
    errors: r.errors_json ? JSON.parse(r.errors_json) : [],
    report: r.report_json ? JSON.parse(r.report_json) : null,
  };
}

export async function restoreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/restores", async (req) => {
    const q = req.query as { backup_id?: string };
    return restores.list(q.backup_id ? Number(q.backup_id) : undefined);
  });

  app.get("/api/restores/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = restores.get(id);
    if (!r) return reply.code(404).send({ error: "Introuvable" });
    return expand(r);
  });
}
