import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Charge un fichier .env si présent (racine du dépôt ou dossier courant).
 * En production Docker, les variables viennent de l'environnement du conteneur
 * et ce chargement est simplement sans effet.
 */
function loadDotEnv(): void {
  if (typeof process.loadEnvFile !== "function") return;
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
  ]) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        /* ignore */
      }
      return;
    }
  }
}
loadDotEnv();

/**
 * Configuration dérivée de l'environnement.
 *
 * Règle de sécurité : aucun secret par défaut. Si MASTER_KEY ou JWT_SECRET
 * manquent, le serveur refuse de démarrer plutôt que d'utiliser une valeur
 * prévisible. En développement on peut générer des valeurs éphémères en
 * posant DEV_ALLOW_EPHEMERAL_SECRETS=1 (jamais en production).
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    if (process.env.DEV_ALLOW_EPHEMERAL_SECRETS === "1") {
      const generated = randomBytes(32).toString("hex");
      // eslint-disable-next-line no-console
      console.warn(
        `[config] ${name} absent — valeur éphémère générée (DEV uniquement).`,
      );
      return generated;
    }
    throw new Error(
      `Variable d'environnement obligatoire manquante: ${name}. ` +
        `Générer avec: openssl rand -hex 32`,
    );
  }
  return v;
}

function parseImageMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[config] VERIFY_PG_IMAGE_MAP invalide (JSON), ignoré.");
    return {};
  }
}

function masterKey(): Buffer {
  const hex = required("MASTER_KEY");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error(
      "MASTER_KEY doit faire 32 octets en hexadécimal (64 caractères). " +
        "Générer avec: openssl rand -hex 32",
    );
  }
  return buf;
}

export const config = {
  port: Number(process.env.PORT ?? 4005),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: process.env.DATA_DIR ?? "/data",
  logLevel: process.env.LOG_LEVEL ?? "info",

  masterKey: masterKey(),
  jwtSecret: required("JWT_SECRET"),

  admin: {
    email: process.env.ADMIN_EMAIL ?? "admin@example.com",
    password: process.env.ADMIN_PASSWORD ?? "",
  },

  docker: {
    socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    /** Volume nommé que les conteneurs jetables montent pour lire les archives. */
    dataVolume: process.env.VERIFY_DATA_VOLUME ?? "",
    // Image jetable : postgis/postgis embarque PostGIS ET les modules contrib
    // (uuid-ossp, pgcrypto…), qui couvrent les extensions Supabase courantes.
    // L'image postgres standard n'a PAS PostGIS, d'où le repli seulement.
    verifyImage: process.env.VERIFY_PG_IMAGE ?? "postgis/postgis:{major}-3.5",
    verifyImageFallback:
      process.env.VERIFY_PG_IMAGE_FALLBACK ?? "postgres:{major}",
    // Image prioritaire PAR VERSION MAJEURE (JSON), pour pointer vers une image
    // Supabase complète couvrant pgsodium/vault/pg_graphql, ex:
    // VERIFY_PG_IMAGE_MAP={"15":"supabase/postgres:15.8.1.060"}
    verifyImageMap: parseImageMap(process.env.VERIFY_PG_IMAGE_MAP),
  },
} as const;

export type Config = typeof config;
