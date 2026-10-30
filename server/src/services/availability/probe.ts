import { Client } from "pg";
import mysql from "mysql2/promise";
import type { DatabaseSource } from "../../types/models.js";
import { decryptString } from "../crypto/crypto.js";

const TIMEOUT_MS = 8_000;

function modeOf(source: DatabaseSource): string {
  return (source.ssl_mode || "prefer").toLowerCase();
}

function sslUnsupported(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /does not support SSL|does not support secure connection|no encryption|wrong version number|SSL routines|ECONNRESET|HANDSHAKE_NO_SSL/i.test(
    msg,
  );
}

async function probePostgres(source: DatabaseSource, password: string): Promise<void> {
  const mode = modeOf(source);
  const strict = mode === "verify-ca" || mode === "verify-full";
  const attempt = async (ssl: false | { rejectUnauthorized: boolean }) => {
    const client = new Client({
      host: source.host,
      port: source.port,
      user: source.username,
      password,
      database: source.db_name,
      application_name: "dataspbackup-availability",
      connectionTimeoutMillis: TIMEOUT_MS,
      query_timeout: TIMEOUT_MS,
      statement_timeout: TIMEOUT_MS,
      ssl,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  if (mode === "disable") {
    await attempt(false);
    return;
  }
  try {
    await attempt({ rejectUnauthorized: strict });
  } catch (err) {
    if ((mode === "prefer" || mode === "allow") && sslUnsupported(err)) {
      await attempt(false);
      return;
    }
    throw err;
  }
}

async function probeMysql(source: DatabaseSource, password: string): Promise<void> {
  const mode = modeOf(source);
  const strict = mode === "verify-ca" || mode === "verify-full";
  const attempt = async (ssl: { rejectUnauthorized: boolean } | undefined) => {
    const conn = await mysql.createConnection({
      host: source.host,
      port: source.port,
      user: source.username,
      password,
      database: source.db_name,
      connectTimeout: TIMEOUT_MS,
      ssl,
    });
    try {
      await conn.query("SELECT 1");
    } finally {
      await conn.end();
    }
  };

  if (mode === "disable") {
    await attempt(undefined);
    return;
  }
  try {
    await attempt({ rejectUnauthorized: strict });
  } catch (err) {
    if ((mode === "prefer" || mode === "allow") && sslUnsupported(err)) {
      await attempt(undefined);
      return;
    }
    throw err;
  }
}

/** SELECT 1 sur la source. Lève si la base ne répond pas. */
export async function probeDatabase(source: DatabaseSource): Promise<void> {
  const password = decryptString(source.password_enc);
  if (!password) throw new Error("Mot de passe non défini");
  if (source.engine === "mysql") await probeMysql(source, password);
  else await probePostgres(source, password);
}
