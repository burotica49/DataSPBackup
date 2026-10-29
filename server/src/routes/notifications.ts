import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { channels } from "../models/repo.js";
import { encryptString } from "../services/crypto/crypto.js";
import { testChannel } from "../services/notify/notify.js";
import type { NotificationChannel } from "../types/models.js";
import { requireAuth } from "../lib/auth.js";

const createSchema = z.object({
  type: z.enum(["telegram", "email", "webhook"]),
  name: z.string().min(1),
  config: z.record(z.any()).default({}),
  on_start: z.boolean().default(false),
  on_success: z.boolean().default(false),
  on_failure: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.any()).optional(),
  on_start: z.boolean().optional(),
  on_success: z.boolean().optional(),
  on_failure: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** Jamais renvoyer config_enc (jetons/mots de passe) au client. */
function publicView(c: NotificationChannel) {
  const { config_enc, ...rest } = c;
  void config_enc;
  return rest;
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/notifications", async () =>
    channels.list().map(publicView),
  );

  app.post("/api/notifications", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    const c = channels.create({
      type: d.type,
      name: d.name,
      config_enc: encryptString(JSON.stringify(d.config)),
      on_start: d.on_start ? 1 : 0,
      on_success: d.on_success ? 1 : 0,
      on_failure: d.on_failure ? 1 : 0,
      enabled: d.enabled ? 1 : 0,
    });
    return reply.code(201).send(publicView(c));
  });

  app.patch("/api/notifications/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!channels.get(id)) return reply.code(404).send({ error: "Introuvable" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    const patch: Record<string, unknown> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.config !== undefined) {
      patch.config_enc = encryptString(JSON.stringify(d.config));
    }
    if (d.on_start !== undefined) patch.on_start = d.on_start ? 1 : 0;
    if (d.on_success !== undefined) patch.on_success = d.on_success ? 1 : 0;
    if (d.on_failure !== undefined) patch.on_failure = d.on_failure ? 1 : 0;
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    channels.update(id, patch);
    return publicView(channels.get(id)!);
  });

  app.delete("/api/notifications/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    channels.remove(id);
    return { ok: true };
  });

  app.post("/api/notifications/:id/test", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      await testChannel(id);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: String(err) });
    }
  });
}
