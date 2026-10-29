import type { FastifyInstance } from "fastify";
import { getDocker } from "../services/docker/docker.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    let docker = false;
    try {
      await getDocker().ping();
      docker = true;
    } catch {
      docker = false;
    }
    return { ok: true, docker, time: new Date().toISOString() };
  });
}
