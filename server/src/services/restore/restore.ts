import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { backups, databases, restores } from "../../models/repo.js";
import type { DatabaseSource } from "../../types/models.js";
import { createDecryptStream, decryptString } from "../crypto/crypto.js";
import {
  dataMount,
  pullImage,
  resolveImage,
  runEphemeral,
} from "../docker/docker.js";
import { parseRestoreErrors } from "../verify/errors.js";
import { introspectSource } from "../verify/sourceIntrospect.js";
import { inspectArchive, tocExcludingUserMappings } from "../verify/archive.js";
import { buildPrepPlan } from "../verify/supabasePrep.js";
import { appRestorePlan, captureTriggersSql, dropAppObjectsSql } from "./supabaseWipe.js";

export interface RestoreOptions {
  backupId: number;
  mode: "existing" | "new";
  /** mode=existing : base enregistrée cible. */
  targetDatabaseId?: number;
  /** mode=new : serveur (base enregistrée) où créer la nouvelle base. */
  serverDatabaseId?: number;
  newDbName?: string;
  /** mode=new : connexion saisie (non enregistrée). Le mot de passe ne doit pas être journalisé. */
  connection?: {
    host: string;
    port: number;
    username: string;
    password: string;
    dbName: string;
    sslMode: string;
  };
  /** --clean --if-exists (écrase les objets existants). DANGEREUX. */
  clean?: boolean;
  /**
   * Base Supabase existante : supprime les objets applicatifs (tables de
   * public, autres schémas) puis les recrée depuis l'archive. Schémas
   * Supabase, rôles et extensions conservés. Incompatible avec clean.
   */
  wipeData?: boolean;
  /** Préparer rôles + extensions Supabase (mode=new). */
  prepareSupabase?: boolean;
}

interface Conn { host: string; port: number; user: string; pw: string; ssl?: string }

const SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);

function pgEnv(conn: Conn, db: string): Record<string, string> {
  const env: Record<string, string> = {
    PGPASSWORD: conn.pw,
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
    PGDATABASE: db,
  };
  if (conn.ssl && SSL_MODES.has(conn.ssl)) env.PGSSLMODE = conn.ssl;
  return env;
}

function paths(relPath: string) {
  return {
    host: join(config.dataDir, relPath),
    container: posix.join("/data", relPath.split(/[\\/]/).join("/")),
  };
}

function connOf(d: DatabaseSource): Conn {
  return {
    host: d.host, port: d.port, user: d.username,
    pw: decryptString(d.password_enc), ssl: d.ssl_mode || undefined,
  };
}

/** psql sur une cible distante (heredoc). Hôte et identifiants passent par l'environnement, pas le shell. */
async function remotePsql(
  image: string, platform: string | undefined, conn: Conn, db: string, script: string,
  stopOnError = false,
) {
  return runEphemeral({
    image, platform, entrypoint: "", env: pgEnv(conn, db),
    cmd: ["bash", "-lc",
      `psql -v ON_ERROR_STOP=${stopOnError ? "1" : "0"} -At <<'DSB_EOSQL'\n${script}\nDSB_EOSQL`],
  });
}

/**
 * Restaure une sauvegarde vers une base de destination (existante ou nouvelle).
 * ⚠️ Écrit dans une base RÉELLE choisie par l'utilisateur. N'est lancé que sur
 * demande explicite (confirmation côté interface).
 */
export async function runRestore(restoreId: number, opts: RestoreOptions): Promise<void> {
  const r = restores.get(restoreId);
  if (!r) throw new Error(`Restauration ${restoreId} introuvable`);
  const backup = backups.get(opts.backupId);
  const source = backup ? databases.get(backup.database_id) : undefined;
  if (!backup || !source || !backup.file_path) throw new Error("Sauvegarde/source introuvable");

  const timeline: Array<{ step: string; at: string }> = [];
  const mark = (step: string) => timeline.push({ step, at: new Date().toISOString() });
  restores.update(restoreId, { status: "running", started_at: new Date().toISOString() });

  const major = backup.pg_major ?? source.pg_major ?? 15;
  const suffix = randomBytes(4).toString("hex");
  let tempRel: string | null = null;
  let listRel: string | null = null;

  try {
    // Connexion cible + nom de base de destination
    let conn: Conn;
    let targetDb: string;
    if (opts.mode === "existing") {
      const td = opts.targetDatabaseId ? databases.get(opts.targetDatabaseId) : undefined;
      if (!td) throw new Error("Base de destination introuvable");
      conn = connOf(td);
      targetDb = td.db_name;
    } else if (opts.connection) {
      const c = opts.connection;
      if (!c.dbName || !/^[a-zA-Z0-9_]+$/.test(c.dbName)) {
        throw new Error("Nom de nouvelle base invalide (a-z, 0-9, _)");
      }
      if (!c.host || !c.username) throw new Error("Connexion de destination incomplète");
      conn = { host: c.host, port: c.port, user: c.username, pw: c.password, ssl: c.sslMode };
      targetDb = c.dbName;
    } else {
      const sd = opts.serverDatabaseId ? databases.get(opts.serverDatabaseId) : undefined;
      if (!sd) throw new Error("Serveur de destination introuvable");
      if (!opts.newDbName || !/^[a-zA-Z0-9_]+$/.test(opts.newDbName)) {
        throw new Error("Nom de nouvelle base invalide (a-z, 0-9, _)");
      }
      conn = connOf(sd);
      targetDb = opts.newDbName;
    }

    // Archive accessible en clair dans le volume
    let archiveRel = backup.file_path;
    if (backup.encrypted) {
      tempRel = posix.join("tmp", `restore-${restoreId}-${suffix}.dump`);
      const dst = paths(tempRel).host;
      await mkdir(dirname(dst), { recursive: true });
      await pipeline(createReadStream(paths(backup.file_path).host), createDecryptStream(), createWriteStream(dst));
      archiveRel = tempRel;
      mark("archive déchiffrée");
    }
    const archivePath = paths(archiveRel).container;

    // Image client (pg_restore/psql) — natif puis amd64
    let image = resolveImage(config.docker.verifyImageFallback, major);
    let platform: string | undefined;
    if (!(await pullImage(image))) {
      if (await pullImage(image, "linux/amd64")) platform = "linux/amd64";
    }
    mark(`client prêt: ${image}${platform ? ` (${platform})` : ""}`);

    let createdbCode: number | null = null;
    let prep: { roles: string[]; extensions: Array<{ name: string; schema: string }> } | null = null;
    let wiped: { schemas: string[]; triggers: number } | null = null;
    const wipeData = opts.mode === "existing" && opts.wipeData === true && !opts.clean;
    let schemaArgs: string[] = [];
    let replica = false;
    let savedTriggers: string[] = [];

    if (wipeData) {
      const inspection = await inspectArchive(image, archivePath, platform);
      const plan = appRestorePlan(inspection.raw);
      schemaArgs = plan.schemas.flatMap((s) => ["-n", s]);
      const capture = captureTriggersSql(plan.schemas);
      if (capture) {
        const trig = await remotePsql(image, platform, conn, targetDb, capture, true);
        if (trig.exitCode !== 0) {
          throw new Error(`Lecture des triggers impossible: ${trig.stderr.slice(-500)}`);
        }
        savedTriggers = trig.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("CREATE"));
      }
      const dropped = await remotePsql(image, platform, conn, targetDb, dropAppObjectsSql(), true);
      if (dropped.exitCode !== 0) {
        throw new Error(`Suppression des objets applicatifs impossible: ${dropped.stderr.slice(-500)}`);
      }
      const superRes = await remotePsql(
        image, platform, conn, targetDb,
        "SELECT rolsuper FROM pg_roles WHERE rolname = current_user;",
        true,
      );
      replica = superRes.exitCode === 0 && superRes.stdout.trim() === "t";
      wiped = { schemas: plan.schemas, triggers: savedTriggers.length };
      mark(`objets applicatifs supprimés (${plan.schemas.join(", ") || "aucun schéma"})`);
    }

    if (opts.mode === "new") {
      // Création de la base de destination
      const cres = await remotePsql(image, platform, conn, "postgres",
        `CREATE DATABASE "${targetDb}";`);
      createdbCode = cres.exitCode;
      mark(`création base "${targetDb}" (code ${cres.exitCode})`);

      // Préparation Supabase optionnelle (rôles + extensions sur la nouvelle base)
      if (opts.prepareSupabase && source.is_supabase === 1) {
        const inspection = await inspectArchive(image, archivePath, platform);
        const intro = await introspectSource(image, source, platform);
        const plan = buildPrepPlan(intro, inspection, true);
        prep = { roles: plan.roles, extensions: plan.extensions };
        if (plan.sql.trim()) await remotePsql(image, platform, conn, targetDb, plan.sql);
        mark(`cible préparée: ${plan.roles.length} rôles, ${plan.extensions.length} extensions`);
      }
    }

    // Restauration. Correspondances d'utilisateurs (FDW) retirées du TOC
    // quand l'option est cochée sur la base source.
    let listArgs: string[] = [];
    if (source.ignore_user_mappings === 1) {
      const listed = await inspectArchive(image, archivePath, platform);
      listRel = posix.join("tmp", `restore-${restoreId}-${suffix}.list`);
      await mkdir(dirname(paths(listRel).host), { recursive: true });
      await writeFile(paths(listRel).host, tocExcludingUserMappings(listed.raw), "utf8");
      listArgs = ["-L", paths(listRel).container];
      mark("correspondances d'utilisateurs ignorées");
    }

    const restoreRes = await runEphemeral({
      image, platform, entrypoint: "",
      env: {
        ...pgEnv(conn, targetDb),
        ...(replica ? { PGOPTIONS: "-c session_replication_role=replica" } : {}),
      },
      binds: [dataMount(true)],
      cmd: ["pg_restore", "-h", conn.host, "-p", String(conn.port), "-U", conn.user,
        "-d", targetDb, "--no-password", "--verbose",
        ...(opts.clean && !wipeData ? ["--clean", "--if-exists"] : []),
        ...schemaArgs, ...listArgs, archivePath],
    });
    mark(`restauration terminée (code ${restoreRes.exitCode})`);

    if (savedTriggers.length) {
      const replay = await remotePsql(image, platform, conn, targetDb, savedTriggers.join(";\n") + ";", false);
      if (replay.exitCode !== 0 || /ERROR/i.test(replay.stderr)) {
        mark("triggers Supabase non reposés");
        logger.warn({ restoreId, err: replay.stderr.slice(-500) }, "Triggers non reposés");
      } else mark(`${savedTriggers.length} trigger(s) Supabase reposé(s)`);
    }

    const parsed = parseRestoreErrors(restoreRes.stderr);
    const ok = parsed.blockingCount === 0 && (createdbCode === null || createdbCode === 0);

    restores.update(restoreId, {
      status: ok ? "success" : "failed",
      finished_at: new Date().toISOString(),
      exit_code: restoreRes.exitCode,
      root_error: parsed.rootError,
      errors_json: JSON.stringify(parsed.categorized),
      report_json: JSON.stringify({
        mode: opts.mode, targetDb, createdbCode, prep, wipeData, wiped,
        restore: { exitCode: restoreRes.exitCode }, timeline,
      }),
    });
    logger.info({ restoreId, ok, blocking: parsed.blockingCount }, "Restauration terminée");
  } catch (err) {
    restores.update(restoreId, {
      status: "failed", finished_at: new Date().toISOString(),
      root_error: String(err), report_json: JSON.stringify({ timeline, fatal: String(err) }),
    });
    logger.error({ restoreId, err: String(err) }, "Restauration échouée");
  } finally {
    if (tempRel) await rm(paths(tempRel).host, { force: true }).catch(() => {});
    if (listRel) await rm(paths(listRel).host, { force: true }).catch(() => {});
  }
}
