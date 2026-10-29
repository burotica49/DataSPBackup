import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { backups, databases } from "../../models/repo.js";
import type { DatabaseSource } from "../../types/models.js";
import { createEncryptStream, decryptString } from "../crypto/crypto.js";
import {
  dataMount,
  pullImage,
  resolveImage,
  runEphemeral,
} from "../docker/docker.js";

function hostPath(rel: string): string {
  return join(config.dataDir, rel);
}
function containerPath(rel: string): string {
  return posix.join("/data", rel.split(/[\\/]/).join("/"));
}

/** Détecte la version majeure du serveur source via un conteneur client. */
export async function detectPgMajor(source: DatabaseSource): Promise<number> {
  const image = resolveImage(config.docker.verifyImageFallback, 17);
  await pullImage(image);
  const pw = decryptString(source.password_enc);
  const res = await runEphemeral({
    image,
    entrypoint: "",
    env: { PGPASSWORD: pw },
    cmd: [
      "psql",
      "-h",
      source.host,
      "-p",
      String(source.port),
      "-U",
      source.username,
      "-d",
      source.db_name,
      "-Atc",
      "SHOW server_version_num",
    ],
  });
  const num = Number((res.stdout.match(/\d+/) ?? [])[0]);
  if (!num) {
    throw new Error(
      `Impossible de détecter la version du serveur source: ${res.stderr.slice(-300)}`,
    );
  }
  return Math.floor(num / 10000); // 150004 -> 15
}

/**
 * Exécute une sauvegarde logique (pg_dump format custom) dans un conteneur
 * PostgreSQL de la version EXACTE de la source, puis chiffre le fichier.
 */
export async function runBackup(
  backupId: number,
  opts: { encrypt?: boolean } = {},
): Promise<void> {
  const backup = backups.get(backupId);
  if (!backup) throw new Error(`Sauvegarde ${backupId} introuvable`);
  const source = databases.get(backup.database_id);
  if (!source) throw new Error("Source introuvable");

  backups.update(backupId, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  const encrypt = opts.encrypt ?? true;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const plainRel = posix.join("backups", String(source.id), `${ts}.dump`);
  const finalRel = encrypt ? `${plainRel}.enc` : plainRel;

  try {
    const major = source.pg_major ?? (await detectPgMajor(source));
    if (!source.pg_major) databases.setPgMajor(source.id, major);

    const image = resolveImage(config.docker.verifyImageFallback, major);
    await pullImage(image);

    await mkdir(dirname(hostPath(plainRel)), { recursive: true });

    const includedSchemas: string[] = JSON.parse(source.included_schemas || "[]");
    const schemaArgs = includedSchemas.flatMap((s) => ["-n", s]);
    const pw = decryptString(source.password_enc);

    // pg_dump écrit dans le volume de données partagé.
    const res = await runEphemeral({
      image,
      entrypoint: "",
      env: { PGPASSWORD: pw },
      binds: [dataMount()],
      cmd: [
        "pg_dump",
        "-h",
        source.host,
        "-p",
        String(source.port),
        "-U",
        source.username,
        "-d",
        source.db_name,
        "-Fc",
        "--no-password",
        ...schemaArgs,
        "-f",
        containerPath(plainRel),
      ],
    });
    if (res.exitCode !== 0) {
      throw new Error(`pg_dump a échoué (code ${res.exitCode}): ${res.stderr.slice(-500)}`);
    }

    // Chiffrement + checksum.
    let checksum: string;
    if (encrypt) {
      const hash = createHash("sha256");
      const enc = createEncryptStream();
      const srcStream = createReadStream(hostPath(plainRel));
      srcStream.on("data", (c) => hash.update(c));
      await pipeline(srcStream, enc, createWriteStream(hostPath(finalRel)));
      await rm(hostPath(plainRel), { force: true });
      checksum = hash.digest("hex"); // checksum du contenu en clair
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(hostPath(finalRel))) {
        hash.update(chunk as Buffer);
      }
      checksum = hash.digest("hex");
    }

    const size = (await stat(hostPath(finalRel))).size;

    backups.update(backupId, {
      status: "success",
      finished_at: new Date().toISOString(),
      size_bytes: size,
      file_path: finalRel,
      encrypted: encrypt ? 1 : 0,
      pg_major: major,
      schemas_json: JSON.stringify(includedSchemas),
      checksum,
    });
    logger.info({ backupId, size, major, encrypt }, "Sauvegarde terminée");
  } catch (err) {
    await rm(hostPath(plainRel), { force: true }).catch(() => {});
    backups.update(backupId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: String(err),
    });
    logger.error({ backupId, err: String(err) }, "Sauvegarde échouée");
    throw err;
  }
}
