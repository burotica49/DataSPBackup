import { join, posix } from "node:path";
import { config } from "../../config.js";
import type { DatabaseSource } from "../../types/models.js";
import { decryptString } from "../crypto/crypto.js";
import {
  dataMount,
  pullImageResult,
  runEphemeral,
  type RunResult,
} from "../docker/docker.js";
import {
  clientArgs,
  dumpFlags,
  imageFor,
  parseServerVersion,
  type MysqlTarget,
} from "./sql.js";

export function hostPath(rel: string): string {
  return join(config.dataDir, rel);
}

export function containerPath(rel: string): string {
  return posix.join("/data", rel.split(/[\\/]/).join("/"));
}

export function requirePassword(source: DatabaseSource): string {
  const pw = decryptString(source.password_enc);
  if (!pw) {
    throw new Error(
      "Mot de passe non défini pour cette base (import sans secret ?). " +
        "Renseignez-le via « Modifier » avant de tester ou sauvegarder.",
    );
  }
  return pw;
}

/** Docker ne répond pas : inutile d'essayer une autre image. */
export function dockerUnavailable(error: string): boolean {
  return /ECONNREFUSED|ENOENT|EACCES|EPERM|Cannot connect to the Docker daemon|connect ENOENT/i.test(
    error,
  );
}

export async function pullWithPlatform(image: string): Promise<string | undefined> {
  const native = await pullImageResult(image);
  if (native.ok) return undefined;
  if (dockerUnavailable(native.error)) {
    throw new Error(
      "Docker n'est pas démarré. Ouvrez Docker Desktop, attendez qu'il soit prêt, puis réessayez.",
    );
  }
  const amd = await pullImageResult(image, "linux/amd64");
  if (amd.ok) return "linux/amd64";
  if (dockerUnavailable(amd.error)) {
    throw new Error(
      "Docker n'est pas démarré. Ouvrez Docker Desktop, attendez qu'il soit prêt, puis réessayez.",
    );
  }
  throw new Error(`Image cliente introuvable (${image}) : ${native.error}`);
}

/** Client Oracle d'abord. MariaDB seulement si le serveur s'annonce comme tel. */
const PROBE_IMAGES = ["mysql:8.4", "mysql:8.0"];

export interface MysqlSession {
  pw: string;
  target: MysqlTarget;
  image: string;
  platform?: string;
  source: DatabaseSource;
}

/** Client de la même série que le serveur (mysqldump compatible). */
export async function openMysql(source: DatabaseSource, known?: string | null): Promise<MysqlSession> {
  const pw = requirePassword(source);
  let target: MysqlTarget | null = null;
  const stored = known || source.server_version;
  if (stored) {
    try {
      target = parseServerVersion(stored);
    } catch {
      target = null;
    }
  }
  if (!target) target = await detectMysqlVersion(source);
  const image = imageFor(target);
  const platform = await pullWithPlatform(image);
  return { pw, target, image, platform, source };
}

/** SELECT VERSION() via un client MySQL, puis MariaDB si le premier échoue. */
export async function detectMysqlVersion(source: DatabaseSource): Promise<MysqlTarget> {
  const pw = requirePassword(source);
  let last = "aucune image cliente n'a pu joindre le serveur";
  for (const image of PROBE_IMAGES) {
    let platform: string | undefined;
    try {
      platform = await pullWithPlatform(image);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Docker n'est pas démarré")) throw new Error(message);
      last = message;
      continue;
    }
    const variant = image.startsWith("mariadb") ? "mariadb" : "mysql";
    const probe = parseServerVersion(variant === "mariadb" ? "11.4.0-MariaDB" : "8.4.0");
    const res = await runEphemeral({
      image,
      platform,
      entrypoint: "",
      env: { MYSQL_PWD: pw },
      cmd: ["mysql", ...clientArgs(source, probe), "-N", "-B", "-e", "SELECT VERSION()"],
    });
    const raw = res.stdout.trim().split("\n").filter(Boolean).pop()?.trim() ?? "";
    if (res.exitCode === 0 && /\d+\.\d+/.test(raw)) return parseServerVersion(raw);
    last = (res.stderr || res.stdout || `code ${res.exitCode}`).slice(-400);
  }
  throw new Error(`Impossible de détecter la version MySQL : ${last}`);
}

export async function runDump(
  session: MysqlSession,
  args: string[],
  outRel: string,
): Promise<void> {
  const res = await runEphemeral({
    image: session.image,
    platform: session.platform,
    entrypoint: "",
    env: { MYSQL_PWD: session.pw },
    binds: [dataMount()],
    cmd: [
      "mysqldump",
      ...clientArgs(session.source, session.target),
      ...dumpFlags(session.target),
      `--result-file=${containerPath(outRel)}`,
      ...args,
    ],
  });
  if (res.exitCode !== 0) {
    throw new Error(`mysqldump a échoué (code ${res.exitCode}) : ${res.stderr.slice(-500)}`);
  }
}

export async function runSql(
  session: Pick<MysqlSession, "image" | "platform" | "pw" | "source" | "target">,
  database: string | undefined,
  sql: string,
): Promise<RunResult> {
  return runEphemeral({
    image: session.image,
    platform: session.platform,
    entrypoint: "",
    env: { MYSQL_PWD: session.pw },
    cmd: [
      "mysql",
      ...clientArgs(session.source, session.target),
      ...(database ? [database] : []),
      "-N",
      "-B",
      "-e",
      sql,
    ],
  });
}

export async function importSqlFile(
  session: Pick<MysqlSession, "image" | "platform" | "pw" | "source" | "target">,
  database: string,
  fileRel: string,
): Promise<RunResult> {
  return runEphemeral({
    image: session.image,
    platform: session.platform,
    entrypoint: "",
    env: { MYSQL_PWD: session.pw },
    binds: [dataMount(true)],
    cmd: [
      "mysql",
      ...clientArgs(session.source, session.target),
      database,
      "-e",
      `source ${containerPath(fileRel)}`,
    ],
  });
}

/** Même hôte, même port, même nom de base : c'est la source, on n'y écrit pas. */
export function isSourceDatabase(
  source: { host: string; port: number; db_name: string },
  host: string,
  port: number,
  db: string,
): boolean {
  return source.host === host && source.port === port && source.db_name === db;
}
