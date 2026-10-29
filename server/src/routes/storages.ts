import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { storages } from "../models/repo.js";
import { encryptString } from "../services/crypto/crypto.js";
import { requireAuth } from "../lib/auth.js";

const createSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["local", "s3"]),
  config: z.record(z.any()).default({}),
});

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/storages", async () =>
    storages.list().map((s) => ({ id: s.id, name: s.name, type: s.type })),
  );

  app.post("/api/storages", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const s = storages.create({
      name: parsed.data.name,
      type: parsed.data.type,
      config_enc: encryptString(JSON.stringify(parsed.data.config)),
    });
    return reply.code(201).send({ id: s.id, name: s.name, type: s.type });
  });
}
