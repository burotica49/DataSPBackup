import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { backups, databases } from "../models/repo.js";
import { createDecryptStream } from "../services/crypto/crypto.js";
import { requestBackup, requestRestore, requestVerification } from "../services/scheduler/jobs.js";
import { requireAuth } from "../lib/auth.js";

const restoreSchema = z.object({
  mode: z.enum(["existing", "new"]),
  targetDatabaseId: z.number().int().positive().optional(),
  serverDatabaseId: z.number().int().positive().optional(),
  newDbName: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
  clean: z.boolean().default(false),
  wipeData: z.boolean().default(false),
  prepareSupabase: z.boolean().default(true),
});

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

  // Télécharge l'archive (déchiffrée à la volée si nécessaire).
  app.get("/api/backups/:id/download", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = backups.get(id);
    if (!b || !b.file_path) {
      return reply.code(404).send({ error: "Sauvegarde introuvable" });
    }
    const path = join(config.dataDir, b.file_path);
    if (!existsSync(path)) {
      return reply.code(404).send({ error: "Fichier d'archive absent" });
    }
    reply.header("Content-Type", "application/octet-stream");
    reply.header(
      "Content-Disposition",
      `attachment; filename="backup-${b.id}.dump"`,
    );
    const src = createReadStream(path);
    return reply.send(b.encrypted ? src.pipe(createDecryptStream()) : src);
  });

  // Supprime une sauvegarde (fichier + enregistrement ; vérifications en cascade).
  app.delete("/api/backups/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = backups.get(id);
    if (!b) return reply.code(404).send({ error: "Introuvable" });
    if (b.file_path) {
      await rm(join(config.dataDir, b.file_path), { force: true }).catch(
        () => {},
      );
    }
    backups.remove(id); // ON DELETE CASCADE supprime les vérifications liées
    return { ok: true };
  });

  // Restaure une sauvegarde vers une base de destination (existante ou nouvelle).
  app.post("/api/backups/:id/restore", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = backups.get(id);
    if (!b || b.status !== "success") {
      return reply.code(409).send({ error: "Sauvegarde introuvable ou non réussie" });
    }
    const parsed = restoreSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    if (d.mode === "existing" && !d.targetDatabaseId) {
      return reply.code(400).send({ error: "Base de destination requise" });
    }
    if (d.mode === "new" && (!d.serverDatabaseId || !d.newDbName)) {
      return reply.code(400).send({ error: "Serveur et nom de nouvelle base requis" });
    }
    if (d.clean && d.wipeData) {
      return reply.code(400).send({ error: "Choisir soit --clean, soit le vidage Supabase" });
    }
    const res = requestRestore({ backupId: id, ...d });
    return reply.code(202).send({ restore_id: res.restoreId });
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
