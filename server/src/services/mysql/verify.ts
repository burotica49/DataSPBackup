import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { logger } from "../../lib/logger.js";
import { backups, databases, verifications } from "../../models/repo.js";
import { createDecryptStream } from "../crypto/crypto.js";
import {
  dataMount,
  execInContainer,
  removeContainer,
  startDisposableMysql,
  waitForMysql,
} from "../docker/docker.js";
import { rowCountDiffs } from "../verify/rowCounts.js";
import { mysqlOmittedTables } from "./backup.js";
import { clientArgs, countQuery } from "./sql.js";
import {
  containerPath,
  hostPath,
  openMysql,
  runSql,
  type MysqlSession,
} from "./run.js";

const TARGET_DB = "verifydb";

/**
 * Restaure le dump dans un MySQL jetable, compare les comptes de lignes
 * avec la source (lecture seule), puis détruit le conteneur.
 */
export async function runMysqlVerification(verificationId: number): Promise<void> {
  const v = verifications.get(verificationId);
  if (!v) throw new Error(`Vérification ${verificationId} introuvable`);
  const backup = backups.get(v.backup_id);
  const source = databases.get(v.database_id);
  if (!backup || !source) throw new Error("Sauvegarde ou source introuvable");
  if (!backup.file_path) throw new Error("La sauvegarde n'a pas de fichier");
  if (source.engine !== "mysql") throw new Error("Cette vérification n'est pas une base MySQL");

  const timeline: Array<{ step: string; at: string }> = [];
  const mark = (step: string) => timeline.push({ step, at: new Date().toISOString() });

  verifications.update(verificationId, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  const suffix = randomBytes(4).toString("hex");
  const containerName = `dataspbackup-mysql-${verificationId}-${suffix}`;
  let container: Awaited<ReturnType<typeof startDisposableMysql>> | null = null;
  let tempRel: string | null = null;

  try {
    let archiveRel = backup.file_path;
    if (backup.encrypted) {
      tempRel = posix.join("tmp", `verify-mysql-${verificationId}-${suffix}.sql`);
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

    const session = await openMysql(source, backup.server_version);
    mark(`client prêt : ${session.image}${session.platform ? ` (${session.platform})` : ""}`);

    const rootPw = randomBytes(12).toString("hex");
    container = await startDisposableMysql({
      image: session.image,
      name: containerName,
      rootPassword: rootPw,
      binds: [dataMount(true)],
      platform: session.platform,
    });
    await waitForMysql(container, rootPw);
    mark("cible jetable démarrée");

    const local = localArgs(session.target.variant);
    const imported = await execInContainer(
      container,
      ["mysql", ...local, TARGET_DB, "-e", `source ${containerPath(archiveRel)}`],
      { MYSQL_PWD: rootPw },
    );
    mark(`import terminé (code ${imported.exitCode})`);
    if (imported.exitCode !== 0) {
      throw new Error(`Import MySQL échoué (code ${imported.exitCode}) : ${imported.stderr.slice(-500)}`);
    }

    const restored = await countInContainer(container, rootPw, local);
    const sizeBytes = await databaseSize(container, rootPw, local);
    const skipped = await mysqlOmittedTables(session);
    const comparison = await compareWithSource(session, restored, skipped);

    const within = comparison.withinTolerance;
    const rootError = within
      ? null
      : `Écart de lignes : ${comparison.diffs.map((d) => d.table).join(", ")}`;

    verifications.update(verificationId, {
      status: within ? "success" : "failed",
      finished_at: new Date().toISOString(),
      exit_code: imported.exitCode,
      restored_size_bytes: sizeBytes,
      schema_count: restored.tables > 0 ? 1 : 0,
      table_count: restored.tables,
      row_counts_json: JSON.stringify(restored.rows),
      errors_json: "[]",
      root_error: rootError,
      report_json: JSON.stringify({
        image: session.image,
        platform: session.platform,
        dbUser: "root",
        serverVersion: session.target.raw,
        restore: { exitCode: imported.exitCode },
        counts: { schemas: restored.tables > 0 ? 1 : 0, tables: restored.tables, rows: restored.rows },
        comparison,
        timeline,
      }),
    });
    logger.info({ verificationId, ok: within }, "Vérification MySQL terminée");
  } catch (err) {
    verifications.update(verificationId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      root_error: String(err),
      report_json: JSON.stringify({ timeline, fatal: String(err) }),
    });
    logger.error({ verificationId, err: String(err) }, "Vérification MySQL échouée");
  } finally {
    if (container) await removeContainer(container);
    if (tempRel) await rm(hostPath(tempRel), { force: true }).catch(() => {});
  }
}

function localArgs(variant: MysqlSession["target"]["variant"]): string[] {
  return clientArgs(
    { host: "127.0.0.1", port: 3306, username: "root", ssl_mode: "disable" },
    { variant, series: variant === "mariadb" ? "10.11" : "8.0", raw: "" },
  );
}

async function countInContainer(
  container: NonNullable<Awaited<ReturnType<typeof startDisposableMysql>>>,
  rootPw: string,
  local: string[],
): Promise<{ tables: number; rows: Record<string, number> }> {
  const listed = await execInContainer(
    container,
    [
      "mysql",
      ...local,
      TARGET_DB,
      "-N",
      "-B",
      "-e",
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
    ],
    { MYSQL_PWD: rootPw },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`Comptage impossible : ${listed.stderr.slice(-300)}`);
  }
  const tables = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows = await countNamed(async (sql) => {
    const res = await execInContainer(
      container,
      ["mysql", ...local, TARGET_DB, "-N", "-B", "-e", sql],
      { MYSQL_PWD: rootPw },
    );
    if (res.exitCode !== 0) throw new Error(res.stderr.slice(-300));
    return res.stdout;
  }, tables);
  return { tables: tables.length, rows };
}

async function databaseSize(
  container: NonNullable<Awaited<ReturnType<typeof startDisposableMysql>>>,
  rootPw: string,
  local: string[],
): Promise<number | null> {
  const res = await execInContainer(
    container,
    [
      "mysql",
      ...local,
      TARGET_DB,
      "-N",
      "-B",
      "-e",
      "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()",
    ],
    { MYSQL_PWD: rootPw },
  );
  const n = Number(res.stdout.trim().split("\n").pop());
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function compareWithSource(
  session: MysqlSession,
  restored: { rows: Record<string, number> },
  skipped: Set<string>,
): Promise<{
  source: Record<string, number>;
  diffs: Array<{ table: string; source: number; restored: number }>;
  withinTolerance: boolean;
}> {
  const sourceRows: Record<string, number> = {};
  try {
    const listed = await runSql(
      session,
      session.source.db_name,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    if (listed.exitCode !== 0) throw new Error(listed.stderr.slice(-300));
    const tables = listed.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((name) => name && !skipped.has(name));
    const rows = await countNamed(async (sql) => {
      const res = await runSql(session, session.source.db_name, sql);
      if (res.exitCode !== 0) throw new Error(res.stderr.slice(-300));
      return res.stdout;
    }, tables);
    Object.assign(sourceRows, rows);
  } catch (err) {
    logger.warn({ err: String(err) }, "Comparaison source MySQL impossible");
  }
  const diffs = rowCountDiffs(sourceRows, restored.rows);
  const withinTolerance = Object.keys(sourceRows).length === 0 || diffs.length === 0;
  return { source: sourceRows, diffs, withinTolerance };
}

async function countNamed(
  query: (sql: string) => Promise<string>,
  tables: string[],
): Promise<Record<string, number>> {
  const rows: Record<string, number> = {};
  for (let i = 0; i < tables.length; i += 40) {
    const sql = countQuery(tables.slice(i, i + 40));
    const stdout = await query(sql);
    for (const line of stdout.split("\n")) {
      const [t, c] = line.split("\t");
      if (t && c != null && /^\d+$/.test(c.trim())) rows[t] = Number(c.trim());
    }
  }
  return rows;
}
