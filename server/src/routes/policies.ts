import type { FastifyInstance } from "fastify";
import cron from "node-cron";
import { z } from "zod";
import { databases, policies, storages } from "../models/repo.js";
import { reloadSchedules } from "../services/scheduler/scheduler.js";
import { requestBackup } from "../services/scheduler/jobs.js";
import { requireAuth } from "../lib/auth.js";

const base = {
  storage_id: z.number().int().positive(),
  schedule_cron: z.string().min(1),
  retention_count: z.number().int().positive().nullable().optional(),
  retention_days: z.number().int().positive().nullable().optional(),
  compression: z.enum(["none", "gzip", "zstd"]).optional(),
  encrypt: z.boolean().optional(),
  verify_after: z.boolean().optional(),
  enabled: z.boolean().optional(),
};
const createSchema = z.object({
  database_id: z.number().int().positive(),
  ...base,
});
const updateSchema = z.object(base).partial();

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/policies", async () => policies.list());

  app.post("/api/policies", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (!cron.validate(d.schedule_cron)) {
      return reply.code(400).send({ error: "Expression cron invalide" });
    }
    if (!databases.get(d.database_id)) {
      return reply.code(404).send({ error: "Base introuvable" });
    }
    if (!storages.get(d.storage_id)) {
      return reply.code(404).send({ error: "Stockage introuvable" });
    }
    const p = policies.create({
      database_id: d.database_id,
      storage_id: d.storage_id,
      schedule_cron: d.schedule_cron,
      retention_count: d.retention_count ?? null,
      retention_days: d.retention_days ?? null,
      compression: d.compression ?? "zstd",
      encrypt: (d.encrypt ?? true) ? 1 : 0,
      verify_after: (d.verify_after ?? true) ? 1 : 0,
      enabled: (d.enabled ?? true) ? 1 : 0,
    });
    reloadSchedules();
    return reply.code(201).send(p);
  });

  app.patch("/api/policies/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!policies.get(id)) return reply.code(404).send({ error: "Introuvable" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (d.schedule_cron && !cron.validate(d.schedule_cron)) {
      return reply.code(400).send({ error: "Expression cron invalide" });
    }
    const patch: Record<string, unknown> = {};
    if (d.storage_id !== undefined) patch.storage_id = d.storage_id;
    if (d.schedule_cron !== undefined) patch.schedule_cron = d.schedule_cron;
    if (d.retention_count !== undefined) patch.retention_count = d.retention_count;
    if (d.retention_days !== undefined) patch.retention_days = d.retention_days;
    if (d.compression !== undefined) patch.compression = d.compression;
    if (d.encrypt !== undefined) patch.encrypt = d.encrypt ? 1 : 0;
    if (d.verify_after !== undefined) patch.verify_after = d.verify_after ? 1 : 0;
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    policies.update(id, patch);
    reloadSchedules();
    return policies.get(id);
  });

  app.delete("/api/policies/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    policies.remove(id);
    reloadSchedules();
    return { ok: true };
  });

  // Exécute immédiatement une politique (sauvegarde + vérification + rétention).
  app.post("/api/policies/:id/run", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const p = policies.get(id);
    if (!p) return reply.code(404).send({ error: "Introuvable" });
    const { backupId } = requestBackup({
      databaseId: p.database_id,
      trigger: "schedule",
      encrypt: p.encrypt === 1,
      verifyAfter: p.verify_after === 1,
      policyId: p.id,
      storageId: p.storage_id,
    });
    return reply.code(202).send({ backup_id: backupId });
  });
}
