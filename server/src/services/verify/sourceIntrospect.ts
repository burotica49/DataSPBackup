import { logger } from "../../lib/logger.js";
import { runEphemeral } from "../docker/docker.js";
import { decryptString } from "../crypto/crypto.js";
import type { DatabaseSource } from "../../types/models.js";

/**
 * Introspection de la base SOURCE en direct.
 *
 * Supabase n'inclut pas les `CREATE EXTENSION` ni la définition des rôles dans
 * le dump (extensions et rôles sont préinstallés sur la plateforme). On ne peut
 * donc PAS les déduire de l'archive : on interroge la source pour connaître les
 * extensions (et leur schéma) et les rôles à recréer dans la cible jetable.
 * Lecture seule, aucune écriture sur la source.
 */
export interface SourceIntrospection {
  roles: string[];
  extensions: Array<{ name: string; schema: string }>;
}

export async function introspectSource(
  image: string,
  source: DatabaseSource,
  platform?: string,
): Promise<SourceIntrospection> {
  const pw = decryptString(source.password_enc);
  const base = `psql -h ${source.host} -p ${source.port} -U ${source.username} -d ${source.db_name} -At`;
  const script =
    `${base} -c "SELECT 'R|'||rolname FROM pg_roles ` +
    `WHERE rolname NOT LIKE 'pg^_%' ESCAPE '^' AND rolname <> 'postgres'";\n` +
    `${base} -c "SELECT 'E|'||e.extname||'|'||n.nspname ` +
    `FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ` +
    `WHERE e.extname <> 'plpgsql'"`;

  const res = await runEphemeral({
    image,
    entrypoint: "",
    platform,
    env: { PGPASSWORD: pw },
    cmd: ["bash", "-lc", script],
  });

  const roles: string[] = [];
  const extensions: Array<{ name: string; schema: string }> = [];
  for (const line of res.stdout.split("\n")) {
    const parts = line.trim().split("|");
    if (parts[0] === "R" && parts[1]) roles.push(parts[1]);
    else if (parts[0] === "E" && parts[1]) {
      extensions.push({ name: parts[1], schema: parts[2] || "public" });
    }
  }

  if (!roles.length && !extensions.length) {
    logger.warn(
      { stderr: res.stderr.slice(-300) },
      "Introspection de la source vide (source injoignable ?)",
    );
  }
  return { roles, extensions };
}
