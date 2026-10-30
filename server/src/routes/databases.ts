import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { databases, groups, availability } from "../models/repo.js";
import { decryptString, encryptString } from "../services/crypto/crypto.js";
import { detectPgMajor } from "../services/backup/backup.js";
import { detectMysqlVersion } from "../services/mysql/run.js";
import { runAvailabilityCheck } from "../services/availability/run.js";
import { requireAuth } from "../lib/auth.js";

/** Motif pg_dump : schéma, table ou joker (public, auth.users, audit.*). */
const dumpPattern = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_$.*]+$/);
const dumpList = z.array(dumpPattern).max(200);

const createSchema = z.object({
  name: z.string().min(1),
  engine: z.enum(["postgres", "mysql"]).default("postgres"),
  host: z.string().min(1),
  port: z.number().int().positive().default(5432),
  db_name: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  ssl_mode: z.string().default("prefer"),
  included_schemas: dumpList.default([]),
  excluded_tables: dumpList.default([]),
  excluded_table_data: dumpList.default([]),
  ignore_user_mappings: z.boolean().default(false),
  is_supabase: z.boolean().default(false),
  group_id: z.number().int().positive().nullable().optional(),
});

// Édition : tout optionnel ; mot de passe vide/absent = inchangé.
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  db_name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().optional(),
  ssl_mode: z.string().optional(),
  included_schemas: dumpList.optional(),
  excluded_tables: dumpList.optional(),
  excluded_table_data: dumpList.optional(),
  ignore_user_mappings: z.boolean().optional(),
  is_supabase: z.boolean().optional(),
  group_id: z.number().int().positive().nullable().optional(),
  avail_enabled: z.boolean().optional(),
  avail_notify: z.boolean().optional(),
  avail_interval_min: z.number().int().min(1).max(1440).optional(),
  avail_attempts: z.number().int().min(1).max(30).optional(),
  avail_history_days: z.number().int().min(1).max(365).optional(),
});

function formError(error: z.ZodError): string {
  const pattern = error.issues.some((issue) =>
    issue.path.some((p) =>
      p === "included_schemas" || p === "excluded_tables" || p === "excluded_table_data",
    ),
  );
  return pattern
    ? "Motif invalide : lettres, chiffres, _, $, . et * (ex. public.logs ou audit.*)."
    : "Paramètres invalides";
}

function parseList(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Ne jamais renvoyer le mot de passe chiffré au client. */
function hasPassword(enc: string): boolean {
  try {
    return decryptString(enc).length > 0;
  } catch {
    return true; // secret illisible ici : on ne prétend pas qu'il manque
  }
}

function groupOrError(
  groupId: number | null | undefined,
): { ok: true; group_id: number | null } | { ok: false } {
  if (groupId == null) return { ok: true, group_id: null };
  if (!groups.get(groupId)) return { ok: false };
  return { ok: true, group_id: groupId };
}

function publicView(d: ReturnType<typeof databases.get> & object) {
  const { password_enc, ...rest } = d;
  return {
    ...rest,
    has_password: hasPassword(password_enc),
    included_schemas: parseList(d.included_schemas),
    excluded_tables: parseList(d.excluded_tables),
    excluded_table_data: parseList(d.excluded_table_data),
  };
}

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/databases", async () =>
    databases.list().map((d) => publicView(d)),
  );

  app.get("/api/databases/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const d = databases.get(id);
    if (!d) return reply.code(404).send({ error: "Introuvable" });
    return publicView(d);
  });

  app.post("/api/databases", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: formError(parsed.error) });
    }
    const d = parsed.data;
    const group = groupOrError(d.group_id);
    if (!group.ok) return reply.code(400).send({ error: "Groupe introuvable" });
    const created = databases.create({
      name: d.name,
      engine: d.engine,
      host: d.host,
      port: d.port,
      db_name: d.db_name,
      username: d.username,
      password_enc: encryptString(d.password),
      ssl_mode: d.ssl_mode,
      included_schemas: JSON.stringify(d.included_schemas),
      excluded_tables: JSON.stringify(d.excluded_tables),
      excluded_table_data: JSON.stringify(d.excluded_table_data),
      ignore_user_mappings: d.engine === "mysql" ? 0 : d.ignore_user_mappings ? 1 : 0,
      is_supabase: d.engine === "mysql" ? 0 : d.is_supabase ? 1 : 0,
      group_id: group.group_id,
    });
    return reply.code(201).send(publicView(created));
  });

  app.patch("/api/databases/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!databases.get(id)) return reply.code(404).send({ error: "Introuvable" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: formError(parsed.error) });
    }
    const d = parsed.data;
    const patch: Record<string, unknown> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.host !== undefined) patch.host = d.host;
    if (d.port !== undefined) patch.port = d.port;
    if (d.db_name !== undefined) patch.db_name = d.db_name;
    if (d.username !== undefined) patch.username = d.username;
    if (d.ssl_mode !== undefined) patch.ssl_mode = d.ssl_mode;
    if (d.included_schemas !== undefined) {
      patch.included_schemas = JSON.stringify(d.included_schemas);
    }
    if (d.excluded_tables !== undefined) {
      patch.excluded_tables = JSON.stringify(d.excluded_tables);
    }
    if (d.excluded_table_data !== undefined) {
      patch.excluded_table_data = JSON.stringify(d.excluded_table_data);
    }
    if (d.ignore_user_mappings !== undefined) {
      patch.ignore_user_mappings = d.ignore_user_mappings ? 1 : 0;
    }
    if (d.is_supabase !== undefined) patch.is_supabase = d.is_supabase ? 1 : 0;
    if (d.avail_enabled !== undefined) patch.avail_enabled = d.avail_enabled ? 1 : 0;
    if (d.avail_notify !== undefined) patch.avail_notify = d.avail_notify ? 1 : 0;
    if (d.avail_interval_min !== undefined) patch.avail_interval_min = d.avail_interval_min;
    if (d.avail_attempts !== undefined) patch.avail_attempts = d.avail_attempts;
    if (d.avail_history_days !== undefined) patch.avail_history_days = d.avail_history_days;
    if (d.group_id !== undefined) {
      const group = groupOrError(d.group_id);
      if (!group.ok) return reply.code(400).send({ error: "Groupe introuvable" });
      patch.group_id = group.group_id;
    }
    // Mot de passe : seulement si fourni et non vide.
    if (d.password && d.password.length > 0) {
      patch.password_enc = encryptString(d.password);
    }
    databases.update(id, patch);
    if (d.avail_enabled === true) void runAvailabilityCheck(id);
    return publicView(databases.get(id)!);
  });

  app.get("/api/databases/:id/availability", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const d = databases.get(id);
    if (!d) return reply.code(404).send({ error: "Introuvable" });
    const sinceRaw = (req.query as { since?: string }).since;
    const oldest = Date.now() - d.avail_history_days * 86_400_000;
    let sinceMs = Date.now() - 86_400_000;
    if (sinceRaw) {
      const parsed = Date.parse(sinceRaw);
      if (Number.isNaN(parsed)) {
        return reply.code(400).send({ error: "Paramètre since invalide" });
      }
      sinceMs = parsed;
    }
    sinceMs = Math.max(sinceMs, oldest);
    return {
      down: d.avail_down === 1,
      fail_streak: d.avail_fail_streak,
      last_check_at: d.avail_last_check_at,
      checks: availability.listSince(id, new Date(sinceMs).toISOString()),
    };
  });

  app.post("/api/databases/:id/availability/check", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!databases.get(id)) return reply.code(404).send({ error: "Introuvable" });
    const check = await runAvailabilityCheck(id);
    if (!check) return reply.code(409).send({ error: "Vérification déjà en cours" });
    const d = databases.get(id)!;
    return {
      check,
      down: d.avail_down === 1,
      fail_streak: d.avail_fail_streak,
      last_check_at: d.avail_last_check_at,
    };
  });

  // Teste la connexion et détecte la version (PostgreSQL ou MySQL).
  app.post("/api/databases/:id/test", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const d = databases.get(id);
    if (!d) return reply.code(404).send({ error: "Introuvable" });
    try {
      if (d.engine === "mysql") {
        const version = await detectMysqlVersion(d);
        databases.setServerVersion(id, version.raw);
        return { ok: true, engine: "mysql", server_version: version.raw };
      }
      const major = await detectPgMajor(d);
      databases.setPgMajor(id, major);
      return { ok: true, engine: "postgres", pg_major: major };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: String(err) });
    }
  });

  app.delete("/api/databases/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    databases.remove(id);
    return { ok: true };
  });
}
