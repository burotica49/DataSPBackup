import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { groups } from "../models/repo.js";
import { requireAuth } from "../lib/auth.js";

const nameSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/groups", async () => groups.list());

  app.post("/api/groups", async (req, reply) => {
    const parsed = nameSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Nom de groupe invalide" });
    }
    if (groups.nameTaken(parsed.data.name)) {
      return reply.code(409).send({ error: "Un groupe porte déjà ce nom" });
    }
    return reply.code(201).send(groups.create(parsed.data.name));
  });

  app.patch("/api/groups/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!groups.get(id)) return reply.code(404).send({ error: "Introuvable" });
    const parsed = nameSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Nom de groupe invalide" });
    }
    if (groups.nameTaken(parsed.data.name, id)) {
      return reply.code(409).send({ error: "Un groupe porte déjà ce nom" });
    }
    groups.rename(id, parsed.data.name);
    return groups.get(id);
  });

  app.delete("/api/groups/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!groups.get(id)) return reply.code(404).send({ error: "Introuvable" });
    groups.remove(id);
    return { ok: true };
  });
}
