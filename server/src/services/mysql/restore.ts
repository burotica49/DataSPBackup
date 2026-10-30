import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { logger } from "../../lib/logger.js";
import { backups, databases, restores } from "../../models/repo.js";
import type { DatabaseSource } from "../../types/models.js";
import { createDecryptStream, encryptString } from "../crypto/crypto.js";
import type { RestoreOptions } from "../restore/restore.js";
import { quoteIdent } from "./sql.js";
import {
  hostPath,
  importSqlFile,
  isSourceDatabase,
  openMysql,
  runSql,
  type MysqlSession,
} from "./run.js";

/**
 * Restaure un dump MySQL vers une base choisie (existante ou nouvelle).
 * N'écrit jamais dans la base source. Ne passe pas par pg_restore.
 */
export async function runMysqlRestore(restoreId: number, opts: RestoreOptions): Promise<void> {
  const rec = restores.get(restoreId);
  if (!rec) throw new Error(`Restauration ${restoreId} introuvable`);
  const backup = backups.get(opts.backupId);
  const source = backup ? databases.get(backup.database_id) : undefined;
  if (!backup || !source || !backup.file_path) throw new Error("Sauvegarde/source introuvable");
  if (source.engine !== "mysql") throw new Error("Cette sauvegarde n'est pas une base MySQL");

  const timeline: Array<{ step: string; at: string }> = [];
  const mark = (step: string) => timeline.push({ step, at: new Date().toISOString() });
  restores.update(restoreId, { status: "running", started_at: new Date().toISOString() });

  const suffix = randomBytes(4).toString("hex");
  let tempRel: string | null = null;

  try {
    const target = resolveTarget(opts);
    if (isSourceDatabase(source, target.record.host, target.record.port, target.db)) {
      throw new Error("Refus : la restauration MySQL ne peut pas viser la base source.");
    }

    let archiveRel = backup.file_path;
    if (backup.encrypted) {
      tempRel = posix.join("tmp", `restore-mysql-${restoreId}-${suffix}.sql`);
      const dst = hostPath(tempRel);
      await mkdir(dirname(dst), { recursive: true });
      await pipeline(
        createReadStream(hostPath(backup.file_path)),
        createDecryptStream(),
        createWriteStream(dst),
      );
      archiveRel = tempRel;
      mark("archive déchiffrée");
    }

    const session = await openMysql(target.record);
    mark(`client prêt : ${session.image}`);

    let created = false;
    if (opts.mode === "new") {
      const create = await runSql(
        session,
        undefined,
        `CREATE DATABASE ${quoteIdent(target.db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      if (create.exitCode !== 0) {
        throw new Error(`Création de la base impossible : ${create.stderr.slice(-500)}`);
      }
      created = true;
      mark(`base « ${target.db} » créée`);
    } else if (opts.clean) {
      await dropTargetTables(session, target.db);
      mark("tables de la cible supprimées");
    }

    const imported = await importSqlFile(session, target.db, archiveRel);
    mark(`import terminé (code ${imported.exitCode})`);
    const ok = imported.exitCode === 0;
    const rootError = ok
      ? null
      : `Import MySQL échoué (code ${imported.exitCode}) : ${imported.stderr.slice(-500)}`;

    restores.update(restoreId, {
      status: ok ? "success" : "failed",
      finished_at: new Date().toISOString(),
      exit_code: imported.exitCode,
      root_error: rootError,
      errors_json: "[]",
      report_json: JSON.stringify({
        mode: opts.mode,
        targetDb: target.db,
        created,
        clean: opts.clean === true,
        image: session.image,
        timeline,
      }),
    });
    logger.info({ restoreId, ok }, "Restauration MySQL terminée");
  } catch (err) {
    restores.update(restoreId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      root_error: String(err),
      report_json: JSON.stringify({ timeline, fatal: String(err) }),
    });
    logger.error({ restoreId, err: String(err) }, "Restauration MySQL échouée");
  } finally {
    if (tempRel) await rm(hostPath(tempRel), { force: true }).catch(() => {});
  }
}

function resolveTarget(opts: RestoreOptions): { record: DatabaseSource; db: string } {
  if (opts.mode === "existing") {
    const record = opts.targetDatabaseId ? databases.get(opts.targetDatabaseId) : undefined;
    if (!record) throw new Error("Base de destination introuvable");
    if (record.engine !== "mysql") throw new Error("La destination doit être une base MySQL");
    return { record, db: record.db_name };
  }
  if (opts.connection) {
    const c = opts.connection;
    if (!c.dbName || !/^[a-zA-Z0-9_]+$/.test(c.dbName)) {
      throw new Error("Nom de nouvelle base invalide (a-z, 0-9, _)");
    }
    if (!c.host || !c.username) throw new Error("Connexion de destination incomplète");
    const record: DatabaseSource = {
      id: 0,
      name: c.dbName,
      engine: "mysql",
      host: c.host,
      port: c.port,
      db_name: c.dbName,
      username: c.username,
      password_enc: encryptString(c.password),
      ssl_mode: c.sslMode || "prefer",
      included_schemas: "[]",
      excluded_tables: "[]",
      excluded_table_data: "[]",
      ignore_user_mappings: 0,
      is_supabase: 0,
      pg_major: null,
      server_version: null,
      group_id: null,
      avail_enabled: 0,
      avail_notify: 0,
      avail_interval_min: 1,
      avail_attempts: 3,
      avail_history_days: 7,
      avail_fail_streak: 0,
      avail_down: 0,
      avail_last_check_at: null,
      created_at: "",
      updated_at: "",
    };
    return { record, db: c.dbName };
  }
  const record = opts.serverDatabaseId ? databases.get(opts.serverDatabaseId) : undefined;
  if (!record) throw new Error("Serveur de destination introuvable");
  if (record.engine !== "mysql") throw new Error("La destination doit être une base MySQL");
  if (!opts.newDbName || !/^[a-zA-Z0-9_]+$/.test(opts.newDbName)) {
    throw new Error("Nom de nouvelle base invalide (a-z, 0-9, _)");
  }
  return { record, db: opts.newDbName };
}

/** Supprime les tables et vues de la cible. Jamais DROP DATABASE, jamais la source. */
async function dropTargetTables(session: MysqlSession, db: string): Promise<void> {
  const listed = await runSql(
    session,
    db,
    "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  if (listed.exitCode !== 0) {
    throw new Error(`Lecture des tables cible impossible : ${listed.stderr.slice(-400)}`);
  }
  const tables: string[] = [];
  const views: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    const [name, type] = line.split("\t");
    if (!name) continue;
    if ((type ?? "").includes("VIEW")) views.push(name);
    else tables.push(name);
  }
  const statements: string[] = ["SET FOREIGN_KEY_CHECKS=0"];
  for (const name of views) statements.push(`DROP VIEW IF EXISTS ${quoteIdent(name)}`);
  for (const name of tables) statements.push(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  if (statements.length === 1) return;
  const dropped = await runSql(session, db, statements.join("; "));
  if (dropped.exitCode !== 0) {
    throw new Error(`Suppression des tables impossible : ${dropped.stderr.slice(-400)}`);
  }
}
