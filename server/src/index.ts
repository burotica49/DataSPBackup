import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { initDb } from "./db/index.js";
import { storages, users } from "./models/repo.js";
import { encryptString, hashPassword } from "./services/crypto/crypto.js";
import { startScheduler } from "./services/scheduler/scheduler.js";
import { startAvailabilityMonitor } from "./services/scheduler/availability.js";
import { authRoutes } from "./routes/auth.js";
import { databaseRoutes } from "./routes/databases.js";
import { groupRoutes } from "./routes/groups.js";
import { backupRoutes } from "./routes/backups.js";
import { verificationRoutes } from "./routes/verifications.js";
import { restoreRoutes } from "./routes/restores.js";
import { storageRoutes } from "./routes/storages.js";
import { policyRoutes } from "./routes/policies.js";
import { settingsRoutes } from "./routes/settings.js";
import { notificationRoutes } from "./routes/notifications.js";
import { healthRoutes } from "./routes/health.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Crée le compte propriétaire au premier démarrage, si configuré. */
function seedAdmin(): void {
  if (users.count() > 0) return;
  if (!config.admin.password) {
    logger.warn(
      "Aucun utilisateur et ADMIN_PASSWORD vide : définissez-le pour créer le compte initial.",
    );
    return;
  }
  users.create(config.admin.email, hashPassword(config.admin.password));
  logger.info({ email: config.admin.email }, "Compte propriétaire créé");
}

/** Crée un stockage local par défaut si aucun n'existe. */
function seedDefaultStorage(): void {
  if (storages.list().length > 0) return;
  storages.create({
    name: "Local",
    type: "local",
    config_enc: encryptString(JSON.stringify({})),
  });
  logger.info("Stockage local par défaut créé");
}

async function main(): Promise<void> {
  initDb();
  seedAdmin();
  seedDefaultStorage();

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cookie);

  await app.register(authRoutes);
  await app.register(databaseRoutes);
  await app.register(groupRoutes);
  await app.register(backupRoutes);
  await app.register(verificationRoutes);
  await app.register(restoreRoutes);
  await app.register(storageRoutes);
  await app.register(policyRoutes);
  await app.register(settingsRoutes);
  await app.register(notificationRoutes);
  await app.register(healthRoutes);

  // Interface Vue (build statique), avec repli SPA.
  const publicDir = join(__dirname, "public");
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) {
        return reply.code(404).send({ error: "Route introuvable" });
      }
      return reply.sendFile("index.html");
    });
  }

  startScheduler();
  startAvailabilityMonitor();

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, "dataspbackup démarré");
}

main().catch((err) => {
  logger.error({ err: String(err) }, "Échec du démarrage");
  process.exit(1);
});
