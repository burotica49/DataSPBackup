import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

/** Ouvre la base SQLite de métadonnées et applique les migrations. */
export function initDb(): Database.Database {
  if (db) return db;
  mkdirSync(config.dataDir, { recursive: true });
  const file = join(config.dataDir, "dataspbackup.sqlite");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  logger.info({ file }, "Base de métadonnées prête");
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("initDb() doit être appelé avant getDb()");
  return db;
}

function runMigrations(d: Database.Database): void {
  d.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  const dir = join(__dirname, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = new Set(
    d
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    const tx = d.transaction(() => {
      d.exec(sql);
      d.prepare("INSERT INTO _migrations (name) VALUES (?)").run(f);
    });
    tx();
    logger.info({ migration: f }, "Migration appliquée");
  }
}
