import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { settings } from "../models/repo.js";
import { config } from "../config.js";
import { requireAuth } from "../lib/auth.js";

const KEY = "verify_image_map";

const putSchema = z.object({
  map: z.record(z.string(), z.string()),
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
}
