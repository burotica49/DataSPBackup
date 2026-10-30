import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  channels,
  databases,
  groups,
  policies,
  settings,
  storages,
} from "../models/repo.js";
import { encryptString } from "../services/crypto/crypto.js";
import { config } from "../config.js";
import { requireAuth } from "../lib/auth.js";

const KEY = "verify_image_map";

const putSchema = z.object({
  map: z.record(z.string(), z.string()),
});

/**
 * Export/import de configuration SANS secrets (règle: aucun password_enc ni
 * jeton renvoyé au client). À l'import, les bases/canaux sont créés sans mot de
 * passe : il faut les re-saisir avant usage.
 */
function buildExport() {
  const dbs = databases.list();
  const strs = storages.list();
  const folderList = groups.list();
  const dbName = new Map(dbs.map((d) => [d.id, d.name]));
  const stName = new Map(strs.map((s) => [s.id, s.name]));
  const groupName = new Map(folderList.map((g) => [g.id, g.name]));
  let imageMap: Record<string, string> = {};
  try {
    const raw = settings.get(KEY);
    if (raw) imageMap = JSON.parse(raw);
  } catch {
    imageMap = {};
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: folderList.map((g) => ({ name: g.name })),
    databases: dbs.map((d) => ({
      name: d.name, host: d.host, port: d.port, db_name: d.db_name,
      username: d.username, ssl_mode: d.ssl_mode, is_supabase: d.is_supabase === 1,
      engine: d.engine === "mysql" ? "mysql" : "postgres",
      included_schemas: JSON.parse(d.included_schemas || "[]"),
      group: d.group_id ? groupName.get(d.group_id) ?? null : null,
    })),
    storages: strs.map((s) => ({ name: s.name, type: s.type })),
    policies: policies.list().map((p) => ({
      database_name: dbName.get(p.database_id) ?? null,
      storage_name: stName.get(p.storage_id) ?? null,
      schedule_cron: p.schedule_cron, retention_count: p.retention_count,
      retention_days: p.retention_days, compression: p.compression,
      encrypt: p.encrypt === 1, verify_after: p.verify_after === 1,
      notify_success: p.notify_success === 1, notify_failure: p.notify_failure === 1,
      enabled: p.enabled === 1,
    })),
    channels: channels.list().map((c) => ({
      type: c.type, name: c.name, on_start: c.on_start === 1,
      on_success: c.on_success === 1, on_failure: c.on_failure === 1, enabled: c.enabled === 1,
    })),
    settings: { verify_image_map: imageMap },
  };
}

const importSchema = z.object({
  groups: z.array(z.any()).optional(),
  databases: z.array(z.any()).optional(),
  storages: z.array(z.any()).optional(),
  policies: z.array(z.any()).optional(),
  channels: z.array(z.any()).optional(),
  settings: z.object({ verify_image_map: z.record(z.string(), z.string()).optional() }).optional(),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Image de vérification par version majeure (réglage persistant + défauts).
  app.get("/api/settings/verify-images", async () => {
    let map: Record<string, string> = {};
    try {
      const raw = settings.get(KEY);
      if (raw) map = JSON.parse(raw);
    } catch {
      map = {};
    }
    return {
      map,
      env_map: config.docker.verifyImageMap,
      default_template: config.docker.verifyImage,
      fallback_template: config.docker.verifyImageFallback,
    };
  });

  app.put("/api/settings/verify-images", async (req, reply) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    settings.set(KEY, JSON.stringify(parsed.data.map));
    return { ok: true, map: parsed.data.map };
  });

  // Export de la configuration (sans secrets).
  app.get("/api/settings/export", async (_req, reply) => {
    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", 'attachment; filename="dataspbackup-config.json"');
    return buildExport();
  });

  // Import de configuration. Crée les entités absentes (par nom). Sans secrets :
  // les bases/canaux importés doivent être complétés (mot de passe, jeton).
  app.post("/api/settings/import", async (req, reply) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Fichier de configuration invalide" });
    const data = parsed.data;
    const summary = { databases: 0, storages: 0, policies: 0, channels: 0, settings: 0, groups: 0 };

    const groupIds = new Map(
      groups.list().map((g) => [g.name.toLocaleLowerCase("fr"), g.id]),
    );
    function ensureGroup(name: unknown): number | null {
      if (typeof name !== "string") return null;
      const trimmed = name.trim();
      if (!trimmed) return null;
      const key = trimmed.toLocaleLowerCase("fr");
      const existing = groupIds.get(key);
      if (existing != null) return existing;
      const created = groups.create(trimmed);
      groupIds.set(key, created.id);
      summary.groups++;
      return created.id;
    }
    for (const g of data.groups ?? []) ensureGroup(g?.name);

    const existingDbNames = new Set(databases.list().map((d) => d.name));
    for (const d of data.databases ?? []) {
      if (!d?.name || existingDbNames.has(d.name)) continue;
      databases.create({
        name: d.name, engine: d.engine === "mysql" ? "mysql" : "postgres",
        host: d.host ?? "", port: Number(d.port) || (d.engine === "mysql" ? 3306 : 5432),
        db_name: d.db_name || (d.engine === "mysql" ? "mysql" : "postgres"),
        username: d.username ?? (d.engine === "mysql" ? "root" : "postgres"),
        password_enc: encryptString(""), ssl_mode: d.ssl_mode ?? "prefer",
        included_schemas: JSON.stringify(Array.isArray(d.included_schemas) ? d.included_schemas : []),
        is_supabase: d.engine === "mysql" ? 0 : d.is_supabase ? 1 : 0,
        group_id: ensureGroup(d.group),
      });
      existingDbNames.add(d.name);
      summary.databases++;
    }

    const existingStNames = new Set(storages.list().map((s) => s.name));
    for (const s of data.storages ?? []) {
      if (!s?.name || existingStNames.has(s.name)) continue;
      storages.create({ name: s.name, type: s.type === "s3" ? "s3" : "local", config_enc: encryptString("{}") });
      existingStNames.add(s.name);
      summary.storages++;
    }

    const dbByName = new Map(databases.list().map((d) => [d.name, d.id]));
    const stByName = new Map(storages.list().map((s) => [s.name, s.id]));
    for (const p of data.policies ?? []) {
      const did = dbByName.get(p?.database_name);
      const sid = stByName.get(p?.storage_name);
      if (did == null || sid == null) continue;
      policies.create({
        database_id: did, storage_id: sid, schedule_cron: p.schedule_cron ?? "0 2 * * *",
        retention_count: p.retention_count ?? null, retention_days: p.retention_days ?? null,
        compression: p.compression ?? "zstd", encrypt: p.encrypt ? 1 : 0,
        verify_after: p.verify_after ? 1 : 0, notify_success: p.notify_success ? 1 : 0,
        notify_failure: p.notify_failure ? 1 : 0, enabled: p.enabled ? 1 : 0,
      });
      summary.policies++;
    }

    const existingChNames = new Set(channels.list().map((c) => c.name));
    for (const c of data.channels ?? []) {
      if (!c?.name || !c?.type || existingChNames.has(c.name)) continue;
      channels.create({
        type: c.type, name: c.name, config_enc: encryptString("{}"),
        on_start: c.on_start ? 1 : 0, on_success: c.on_success ? 1 : 0,
        on_failure: c.on_failure ? 1 : 0, enabled: c.enabled ? 1 : 0,
      });
      existingChNames.add(c.name);
      summary.channels++;
    }

    if (data.settings?.verify_image_map) {
      settings.set(KEY, JSON.stringify(data.settings.verify_image_map));
      summary.settings = 1;
    }

    return { ok: true, summary };
  });
}
