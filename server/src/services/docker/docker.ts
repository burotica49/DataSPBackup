import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { settings } from "../../models/repo.js";

/** Map image par majeure effective : réglage persistant (UI) > variable d'env. */
function effectiveImageMap(): Record<string, string> {
  const fromEnv = config.docker.verifyImageMap;
  let fromSettings: Record<string, string> = {};
  try {
    const raw = settings.get("verify_image_map");
    if (raw) fromSettings = JSON.parse(raw);
  } catch {
    /* réglage invalide : on ignore */
  }
  return { ...fromEnv, ...fromSettings };
}

/**
 * Enveloppe autour de dockerode pour piloter des conteneurs PostgreSQL
 * jetables (sauvegarde versionnée + vérification de restauration).
 */

let docker: Docker | null = null;

export function getDocker(): Docker {
  if (!docker) docker = new Docker({ socketPath: config.docker.socket });
  return docker;
}

/** Résout un gabarit d'image comme "supabase/postgres:{major}". */
export function resolveImage(template: string, major: number): string {
  return template.replace("{major}", String(major));
}

/**
 * Source à monter sur /data dans les conteneurs jetables.
 *
 * - En déploiement Docker : un volume NOMMÉ (VERIFY_DATA_VOLUME) partagé avec
 *   le serveur conteneurisé.
 * - En développement (serveur sur l'hôte) : un BIND du dossier DATA_DIR réel,
 *   car le serveur et le conteneur doivent voir exactement les mêmes fichiers.
 *
 * Les deux formes s'écrivent pareil dans Binds : `${source}:/data`.
 */
export function dataMount(readOnly = false): {
  volume: string;
  target: string;
  readOnly: boolean;
} {
  const named = config.docker.dataVolume?.trim();
  const source = named && named.length > 0 ? named : config.dataDir;
  return { volume: source, target: "/data", readOnly };
}

/** Pull d'une image ; renvoie false si l'image est introuvable/échoue. */
export async function pullImage(
  image: string,
  platform?: string,
): Promise<boolean> {
  const d = getDocker();
  try {
    await new Promise<void>((resolve, reject) => {
      const cb = (err: unknown, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err ?? new Error("pull sans flux"));
        d.modem.followProgress(stream, (e: unknown) =>
          e ? reject(e) : resolve(),
        );
      };
      if (platform) d.pull(image, { platform }, cb);
      else d.pull(image, cb);
    });
    return true;
  } catch (err) {
    logger.warn({ image, platform, err: String(err) }, "pull d'image échoué");
    return false;
  }
}

export interface PickedImage {
  image: string;
  bundled: boolean;
  /** Plateforme à forcer pour les conteneurs (ex: linux/amd64 en émulation). */
  platform?: string;
}

/**
 * Choisit l'image de vérification : image avec extensions (PostGIS + contrib),
 * en arch native si possible, sinon en linux/amd64 émulé (certaines images
 * PostGIS n'ont pas de build arm64), avec repli ultime sur postgres standard.
 */
export async function pickVerifyImage(major: number): Promise<PickedImage> {
  // Candidats « avec extensions », par ordre de préférence :
  //  1) image mappée pour cette version majeure (ex: image Supabase complète),
  //  2) image postgis par défaut.
  const bundledCandidates: string[] = [];
  const mapped = effectiveImageMap()[String(major)];
  if (mapped) bundledCandidates.push(mapped);
  bundledCandidates.push(resolveImage(config.docker.verifyImage, major));

  for (const image of bundledCandidates) {
    if (await pullImage(image)) return { image, bundled: true };
    if (await pullImage(image, "linux/amd64")) {
      logger.info(
        { image, platform: "linux/amd64" },
        "image de vérification tirée en amd64 émulé (pas de build natif)",
      );
      return { image, bundled: true, platform: "linux/amd64" };
    }
  }

  // Repli ultime : postgres officiel (sans PostGIS ni extensions Supabase).
  const fallback = resolveImage(config.docker.verifyImageFallback, major);
  logger.warn(
    { candidates: bundledCandidates, fallback },
    "aucune image avec extensions disponible, repli sur postgres standard",
  );
  if (await pullImage(fallback)) return { image: fallback, bundled: false };
  await pullImage(fallback, "linux/amd64");
  return { image: fallback, bundled: false, platform: "linux/amd64" };
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  image: string;
  cmd: string[];
  env?: Record<string, string>;
  /** Montages volume -> chemin interne, ex: { "dataspbackup_data": "/data" }. */
  binds?: Array<{ volume: string; target: string; readOnly?: boolean }>;
  entrypoint?: string[] | "";
  workdir?: string;
  platform?: string;
}

/** Lance un conteneur one-shot, attend sa fin, capture les logs, le supprime. */
export async function runEphemeral(opts: RunOptions): Promise<RunResult> {
  const d = getDocker();
  const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const binds = (opts.binds ?? []).map(
    (b) => `${b.volume}:${b.target}${b.readOnly ? ":ro" : ""}`,
  );

  const createOpts: Docker.ContainerCreateOptions & { platform?: string } = {
    Image: opts.image,
    Cmd: opts.cmd,
    Env: env,
    Entrypoint: opts.entrypoint === "" ? [""] : opts.entrypoint,
    WorkingDir: opts.workdir,
    HostConfig: { Binds: binds, AutoRemove: false },
    Tty: false,
  };
  if (opts.platform) createOpts.platform = opts.platform;
  const container = await d.createContainer(createOpts);

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (c) => (outBuf += c.toString()));
  stderr.on("data", (c) => (errBuf += c.toString()));

  try {
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });
    container.modem.demuxStream(stream, stdout, stderr);
    await container.start();
    const res = await container.wait();
    return { exitCode: res.StatusCode, stdout: outBuf, stderr: errBuf };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/** Crée et démarre un serveur PostgreSQL jetable, renvoie le conteneur. */
export async function startDisposablePostgres(opts: {
  image: string;
  name: string;
  superuserPassword: string;
  binds?: Array<{ volume: string; target: string; readOnly?: boolean }>;
  platform?: string;
}): Promise<Docker.Container> {
  const d = getDocker();
  const binds = (opts.binds ?? []).map(
    (b) => `${b.volume}:${b.target}${b.readOnly ? ":ro" : ""}`,
  );
  const createOpts: Docker.ContainerCreateOptions & { platform?: string } = {
    Image: opts.image,
    name: opts.name,
    Env: [
      `POSTGRES_PASSWORD=${opts.superuserPassword}`,
      "POSTGRES_DB=postgres",
    ],
    HostConfig: { Binds: binds, AutoRemove: false },
    Tty: false,
  };
  if (opts.platform) createOpts.platform = opts.platform;
  const container = await d.createContainer(createOpts);
  await container.start();
  return container;
}

/** Exécute une commande dans un conteneur en marche et capture la sortie. */
export async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  env?: Record<string, string>,
): Promise<RunResult> {
  const exec = await container.exec({
    Cmd: cmd,
    Env: Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`),
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (c) => (outBuf += c.toString()));
  stderr.on("data", (c) => (errBuf += c.toString()));
  container.modem.demuxStream(stream, stdout, stderr);
  await new Promise<void>((resolve) => stream.on("end", () => resolve()));
  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode ?? -1,
    stdout: outBuf,
    stderr: errBuf,
  };
}

export async function removeContainer(
  container: Docker.Container,
): Promise<void> {
  await container.remove({ force: true, v: true }).catch(() => {});
}

/**
 * Attend que le PostgreSQL *définitif* accepte les connexions.
 *
 * L'entrypoint de l'image postgres démarre d'abord un serveur TEMPORAIRE (pour
 * exécuter l'init) qui n'écoute QUE sur le socket Unix, puis l'arrête (« fast
 * shutdown ») avant de lancer le vrai serveur en TCP. On teste donc en TCP
 * (-h 127.0.0.1) pour ne PAS se connecter au serveur temporaire : sinon une
 * restauration lancée pendant l'init serait coupée (« terminating connection
 * due to administrator command »). Double confirmation + délai large (émulation
 * amd64 lente).
 */
export async function waitForPostgres(
  container: Docker.Container,
  timeoutMs = 180000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let okStreak = 0;
  while (Date.now() < deadline) {
    const res = await execInContainer(container, [
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
    ]);
    if (res.exitCode === 0) {
      okStreak += 1;
      if (okStreak >= 2) return;
    } else {
      okStreak = 0;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Le PostgreSQL jetable n'est pas devenu disponible à temps");
}
