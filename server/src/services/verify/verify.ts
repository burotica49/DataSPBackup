import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { backups, databases, verifications } from "../../models/repo.js";
import { decryptString, createDecryptStream } from "../crypto/crypto.js";
import {
  dataMount,
  execInContainer,
  pickVerifyImage,
  removeContainer,
  runEphemeral,
  startDisposablePostgres,
  waitForPostgres,
} from "../docker/docker.js";
import { inspectArchive, tocExcludingUserMappings } from "./archive.js";
import { parseRestoreErrors } from "./errors.js";
import { buildPrepPlan } from "./supabasePrep.js";
import { introspectSource } from "./sourceIntrospect.js";
import { rowCountDiffs } from "./rowCounts.js";

const TARGET_DB = "verifydb";

/** Convertit un chemin relatif (au DATA_DIR) en chemin hôte et conteneur. */
function paths(relPath: string): { host: string; container: string } {
  return {
    host: join(config.dataDir, relPath),
    container: posix.join("/data", relPath.split(/[\\/]/).join("/")),
  };
}

/** Session locale dans la cible jetable. Le mot de passe est hexadécimal. */
interface LocalDb {
  user: string;
  password: string;
  /** Arguments psql/pg_restore : vide (socket) ou `-h 127.0.0.1`. */
  hostArgs: string[];
}

/** Exécute un script SQL (multi-instructions / méta-commandes) via psql. */
async function psql(
  container: Parameters<typeof execInContainer>[0],
  db: string,
  script: string,
  session: LocalDb,
) {
  const host = session.hostArgs.join(" ");
  return execInContainer(container, [
    "bash",
    "-lc",
    `PGPASSWORD=${session.password} psql ${host} -U ${session.user} -d ${db} -w -v ON_ERROR_STOP=0 -At <<'DATASP_EOSQL'\n${script}\nDATASP_EOSQL`,
  ]);
}

/**
 * Sur l'image supabase/postgres, supabase_admin est le superutilisateur
 * et le socket local exige son mot de passe (scram). Le rôle postgres est
 * rétrogradé : il ne peut ni créer les rôles réservés, ni en devenir membre.
 */
async function openLocalDb(
  container: Parameters<typeof execInContainer>[0],
  password: string,
): Promise<LocalDb> {
  const probe = async (hostArgs: string[]): Promise<boolean> => {
    const host = hostArgs.join(" ");
    const res = await execInContainer(container, [
      "bash",
      "-lc",
      `PGPASSWORD=${password} psql ${host} -U supabase_admin -d postgres -w -Atc "SELECT 1"`,
    ]);
    return res.exitCode === 0 && res.stdout.trim() === "1";
  };
  if (await probe([])) return { user: "supabase_admin", password, hostArgs: [] };
  const tcp = ["-h", "127.0.0.1"];
  if (await probe(tcp)) return { user: "supabase_admin", password, hostArgs: tcp };
  return { user: "postgres", password, hostArgs: [] };
}

export interface VerifyReport {
  image: string;
  bundledImage: boolean;
  platform?: string;
  pgMajor: number;
  dbUser: string;
  prep: { roles: string[]; schemas: string[]; extensions: string[] };
  archiveSchemas: string[];
  archiveExtensions: string[];
  restore: { exitCode: number };
  counts: { schemas: number; tables: number; rows: Record<string, number> };
  comparison: {
    source: Record<string, number>;
    diffs: Array<{ table: string; source: number; restored: number }>;
    withinTolerance: boolean;
  };
  timeline: Array<{ step: string; at: string }>;
}

/**
 * Exécute une vérification de restauration complète dans une cible jetable
 * préparée pour Supabase. Ne touche JAMAIS à la base source (lecture seule).
 */
export async function runVerification(verificationId: number): Promise<void> {
  const v = verifications.get(verificationId);
  if (!v) throw new Error(`Vérification ${verificationId} introuvable`);
  const backup = backups.get(v.backup_id);
  const source = databases.get(v.database_id);
  if (!backup || !source) throw new Error("Sauvegarde ou source introuvable");
  if (!backup.file_path) throw new Error("La sauvegarde n'a pas de fichier");

  const timeline: VerifyReport["timeline"] = [];
  const mark = (step: string) =>
    timeline.push({ step, at: new Date().toISOString() });

  verifications.update(verificationId, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  const major = backup.pg_major ?? source.pg_major ?? 15;
  const suffix = randomBytes(4).toString("hex");
  const containerName = `dataspbackup-verify-${verificationId}-${suffix}`;
  let container: Awaited<ReturnType<typeof startDisposablePostgres>> | null =
    null;
  let tempRel: string | null = null;
  let listRel: string | null = null;

  try {
    // 1. Rendre l'archive accessible en clair dans le volume de données.
    let archiveRel = backup.file_path;
    if (backup.encrypted) {
      tempRel = posix.join("tmp", `verify-${verificationId}-${suffix}.dump`);
      const dst = paths(tempRel).host;
      await mkdir(dirname(dst), { recursive: true });
      await pipeline(
        createReadStream(paths(backup.file_path).host),
        createDecryptStream(),
        createWriteStream(dst),
      );
      archiveRel = tempRel;
      mark("archive déchiffrée");
    }
    const archiveContainerPath = paths(archiveRel).container;

    // 2. Choix de l'image (PostGIS + contrib ; amd64 émulé si pas d'arm64).
    const { image, bundled, platform } = await pickVerifyImage(major);
    mark(`image prête: ${image}${platform ? ` (${platform})` : ""}`);

    // 3. Introspection de l'archive (schémas, extensions, rôles).
    const inspection = await inspectArchive(image, archiveContainerPath, platform);
    mark(
      `archive inspectée: ${inspection.schemas.length} schémas, ` +
        `${inspection.extensions.length} extensions`,
    );

    // Introspection de la source en direct : rôles + extensions (source de
    // vérité, car Supabase ne les met pas dans le dump).
    const sourceIntro = await introspectSource(image, source, platform);
    mark(
      `source introspectée: ${sourceIntro.roles.length} rôles, ` +
        `${sourceIntro.extensions.length} extensions`,
    );

    // 4. Démarrer la cible jetable.
    const superPw = randomBytes(12).toString("hex");
    container = await startDisposablePostgres({
      image,
      name: containerName,
      superuserPassword: superPw,
      binds: [dataMount(true)],
      platform,
      // pg_cron refuse de s'installer ailleurs que dans cron.database_name,
      // qui vaut « postgres » par défaut. La restauration vise verifydb.
      postgresArgs: image.includes("supabase/postgres")
        ? ["-c", `cron.database_name=${TARGET_DB}`]
        : undefined,
    });
    await waitForPostgres(container);
    const session = await openLocalDb(container, superPw);
    mark(`cible jetable démarrée (${session.user})`);

    // 5. Base cible VIDE (pas de --clean, pas de DROP SCHEMA public).
    await psql(
      container,
      "postgres",
      `DROP DATABASE IF EXISTS ${TARGET_DB};\nCREATE DATABASE ${TARGET_DB};`,
      session,
    );

    // 6. Préparer rôles / schéma extensions / extensions AVANT restauration.
    const prep = buildPrepPlan(sourceIntro, inspection, source.is_supabase === 1);
    if (prep.sql.trim()) {
      const prepRes = await psql(container, TARGET_DB, prep.sql, session);
      if (/ERROR/i.test(prepRes.stderr)) {
        logger.warn(
          { stderr: prepRes.stderr.slice(-500) },
          "Préparation SQL avec erreurs",
        );
        mark("préparation SQL : certaines commandes ont échoué");
      }
    }
    mark(
      `cible préparée: ${prep.roles.length} rôles, ` +
        `${prep.extensions.length} extensions`,
    );

    // 7. Restauration (on continue sur erreurs pour les catégoriser).
    if (source.ignore_user_mappings === 1) {
      listRel = posix.join("tmp", `verify-${verificationId}-${suffix}.list`);
      await mkdir(dirname(paths(listRel).host), { recursive: true });
      await writeFile(
        paths(listRel).host,
        tocExcludingUserMappings(inspection.raw),
        "utf8",
      );
      mark("correspondances d'utilisateurs ignorées");
    }
    const restore = await execInContainer(container, [
      "env",
      `PGPASSWORD=${session.password}`,
      "pg_restore",
      ...session.hostArgs,
      "-U",
      session.user,
      "-d",
      TARGET_DB,
      "--no-password",
      "--verbose",
      ...(listRel ? ["-L", paths(listRel).container] : []),
      archiveContainerPath,
    ]);
    mark(`restauration terminée (code ${restore.exitCode})`);

    const parsed = parseRestoreErrors(restore.stderr);

    // 8. Comptages dans la cible restaurée.
    const counts = await countRestored(container, session);

    // 9. Comparaison avec la source (vivante → tolérance).
    const comparison = await compareWithSource(image, source, counts.rows, platform);

    const report: VerifyReport = {
      image,
      bundledImage: bundled,
      platform,
      pgMajor: major,
      dbUser: session.user,
      prep: {
        roles: prep.roles,
        schemas: prep.schemas,
        extensions: prep.extensions.map((e) => e.name),
      },
      archiveSchemas: inspection.schemas,
      archiveExtensions: inspection.extensions,
      restore: { exitCode: restore.exitCode },
      counts,
      comparison,
      timeline,
    };

    // Succès décidé par les erreurs BLOQUANTES, pas par le code de sortie 1.
    const ok = parsed.blockingCount === 0 && comparison.withinTolerance;
    verifications.update(verificationId, {
      status: ok ? "success" : "failed",
      finished_at: new Date().toISOString(),
      exit_code: restore.exitCode,
      restored_size_bytes: counts.sizeBytes ?? null,
      schema_count: counts.schemas,
      table_count: counts.tables,
      row_counts_json: JSON.stringify(counts.rows),
      errors_json: JSON.stringify(parsed.categorized),
      root_error: parsed.rootError,
      report_json: JSON.stringify(report),
    });
    logger.info(
      {
        verificationId,
        ok,
        blocking: parsed.blockingCount,
        ignored: parsed.ignoredCount,
      },
      "Vérification terminée",
    );
  } catch (err) {
    verifications.update(verificationId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      root_error: String(err),
      report_json: JSON.stringify({ timeline, fatal: String(err) }),
    });
    logger.error({ verificationId, err: String(err) }, "Vérification échouée");
  } finally {
    if (container) await removeContainer(container);
    if (tempRel) await rm(paths(tempRel).host, { force: true }).catch(() => {});
    if (listRel) await rm(paths(listRel).host, { force: true }).catch(() => {});
  }
}

interface RestoredCounts {
  schemas: number;
  tables: number;
  rows: Record<string, number>;
  sizeBytes: number | null;
}

async function countRestored(
  container: Parameters<typeof execInContainer>[0],
  session: LocalDb,
): Promise<RestoredCounts> {
  // Compte exact par table via génération dynamique (\gexec).
  const res = await psql(
    container,
    TARGET_DB,
    `SELECT 'SELECT '''||schemaname||'.'||tablename||''' AS t, count(*) AS c FROM '||quote_ident(schemaname)||'.'||quote_ident(tablename)
     FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')
     ORDER BY 1 \\gexec`,
    session,
  );
  const rows: Record<string, number> = {};
  for (const line of res.stdout.split("\n")) {
    const [t, c] = line.split("|");
    if (t && c != null && /^\d+$/.test(c.trim())) rows[t] = Number(c.trim());
  }
  const schemas = new Set(Object.keys(rows).map((k) => k.split(".")[0])).size;
  const size = await psql(
    container,
    TARGET_DB,
    `SELECT pg_database_size('${TARGET_DB}')`,
    session,
  );
  const sizeBytes = Number((size.stdout.match(/\d+/) ?? ["0"])[0]) || null;
  return { schemas, tables: Object.keys(rows).length, rows, sizeBytes };
}

async function compareWithSource(
  image: string,
  source: ReturnType<typeof databases.get> & object,
  restoredRows: Record<string, number>,
  platform?: string,
): Promise<VerifyReport["comparison"]> {
  const sourceRows: Record<string, number> = {};
  try {
    const pw = decryptString(source.password_enc);
    const res = await runEphemeral({
      image,
      entrypoint: "",
      platform,
      env: { PGPASSWORD: pw },
      cmd: [
        "bash",
        "-lc",
        `psql -h ${source.host} -p ${source.port} -U ${source.username} -d ${source.db_name} -At <<'EOSQL'
SELECT 'SELECT '''||schemaname||'.'||tablename||''' AS t, count(*) AS c FROM '||quote_ident(schemaname)||'.'||quote_ident(tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1 \\gexec
EOSQL`,
      ],
    });
    for (const line of res.stdout.split("\n")) {
      const [t, c] = line.split("|");
      if (t && c != null && /^\d+$/.test(c.trim())) sourceRows[t] = Number(c.trim());
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Comparaison source impossible");
  }

  const diffs = rowCountDiffs(sourceRows, restoredRows);
  // Si la source est injoignable, ne pas invalider sur la seule comparaison.
  const withinTolerance = Object.keys(sourceRows).length === 0 || diffs.length === 0;
  return { source: sourceRows, diffs, withinTolerance };
}
