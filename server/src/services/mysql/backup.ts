import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { logger } from "../../lib/logger.js";
import { backups, databases } from "../../models/repo.js";
import { parseNameList } from "../backup/dumpArgs.js";
import { createEncryptStream } from "../crypto/crypto.js";
import {
  createStripDefinerStream,
  dumpInvocations,
  isGlob,
  sqlLiteral,
  tableGlobToLike,
} from "./sql.js";
import { hostPath, openMysql, runDump, runSql, type MysqlSession } from "./run.js";

/**
 * Sauvegarde logique MySQL (mysqldump) dans un client de la même série
 * que le serveur, puis chiffrement AES-256-GCM. N'utilise pas pg_dump.
 */
export async function runMysqlBackup(
  backupId: number,
  opts: { encrypt?: boolean } = {},
): Promise<void> {
  const backup = backups.get(backupId);
  if (!backup) throw new Error(`Sauvegarde ${backupId} introuvable`);
  const source = databases.get(backup.database_id);
  if (!source) throw new Error("Source introuvable");
  if (source.engine !== "mysql") throw new Error("Cette sauvegarde n'est pas une base MySQL");

  backups.update(backupId, { status: "running", started_at: new Date().toISOString() });

  const encrypt = opts.encrypt ?? true;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const plainRel = posix.join("backups", String(source.id), `${ts}.sql`);
  const finalRel = encrypt ? `${plainRel}.enc` : plainRel;
  const partRels: string[] = [];

  try {
    const session = await openMysql(source);
    databases.setServerVersion(source.id, session.target.raw);

    const excluded = await resolveTables(session, parseNameList(source.excluded_tables));
    const dataExcluded = await resolveTables(session, parseNameList(source.excluded_table_data));
    const invocations = dumpInvocations(source.db_name, excluded, dataExcluded);

    await mkdir(dirname(hostPath(plainRel)), { recursive: true });
    for (let i = 0; i < invocations.length; i++) {
      const rel = posix.join("tmp", `mysql-${backupId}-${i}.sql`);
      partRels.push(rel);
      await mkdir(dirname(hostPath(rel)), { recursive: true });
      await runDump(session, invocations[i]!, rel);
    }

    await pipeline(
      async function* () {
        for (const rel of partRels) yield* createReadStream(hostPath(rel));
      },
      createStripDefinerStream(),
      createWriteStream(hostPath(plainRel)),
    );

    const plainSize = (await stat(hostPath(plainRel))).size;
    if (plainSize < 32) throw new Error("mysqldump n'a rien écrit");

    let checksum: string;
    if (encrypt) {
      const hash = createHash("sha256");
      const srcStream = createReadStream(hostPath(plainRel));
      srcStream.on("data", (c) => hash.update(c));
      await pipeline(srcStream, createEncryptStream(), createWriteStream(hostPath(finalRel)));
      await rm(hostPath(plainRel), { force: true });
      checksum = hash.digest("hex");
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(hostPath(finalRel))) hash.update(chunk as Buffer);
      checksum = hash.digest("hex");
    }

    const size = (await stat(hostPath(finalRel))).size;
    backups.update(backupId, {
      status: "success",
      finished_at: new Date().toISOString(),
      size_bytes: size,
      file_path: finalRel,
      encrypted: encrypt ? 1 : 0,
      server_version: session.target.raw,
      schemas_json: JSON.stringify([source.db_name]),
      checksum,
    });
    logger.info(
      { backupId, size, version: session.target.series, variant: session.target.variant, encrypt },
      "Sauvegarde MySQL terminée",
    );
  } catch (err) {
    await rm(hostPath(plainRel), { force: true }).catch(() => {});
    await rm(hostPath(finalRel), { force: true }).catch(() => {});
    backups.update(backupId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: String(err),
    });
    logger.error({ backupId, err: String(err) }, "Sauvegarde MySQL échouée");
    throw err;
  } finally {
    for (const rel of partRels) await rm(hostPath(rel), { force: true }).catch(() => {});
  }
}

/** Tables absentes du dump (exclues, ou données exclues) — à ignorer dans la comparaison. */
export async function mysqlOmittedTables(session: MysqlSession): Promise<Set<string>> {
  const excluded = await resolveTables(session, parseNameList(session.source.excluded_tables));
  const dataExcluded = await resolveTables(session, parseNameList(session.source.excluded_table_data));
  return new Set([...excluded, ...dataExcluded]);
}

/** Résout les motifs (nom exact ou joker *) en noms de tables de la base source. */
async function resolveTables(session: MysqlSession, patterns: string[]): Promise<string[]> {
  const names: string[] = [];
  const db = session.source.db_name;
  for (const pattern of patterns) {
    const { schema, like } = tableGlobToLike(pattern);
    if (schema && schema !== db) continue;
    const table = pattern.includes(".") ? pattern.slice(pattern.indexOf(".") + 1) : pattern;
    if (!isGlob(pattern)) {
      if (!names.includes(table)) names.push(table);
      continue;
    }
    const sql =
      `SELECT table_name FROM information_schema.tables ` +
      `WHERE table_schema = ${sqlLiteral(db)} AND table_type = 'BASE TABLE' ` +
      `AND table_name LIKE ${sqlLiteral(like)} ESCAPE '\\\\'`;
    const res = await runSql(session, db, sql);
    if (res.exitCode !== 0) {
      throw new Error(`Lecture des tables impossible : ${res.stderr.slice(-300)}`);
    }
    for (const line of res.stdout.split("\n")) {
      const name = line.trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}
