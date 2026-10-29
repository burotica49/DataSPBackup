import type { ArchiveInspection } from "./archive.js";
import type { SourceIntrospection } from "./sourceIntrospect.js";

/**
 * Rôles Supabase standards. Pour une vraie base Supabase ils remontent déjà
 * de l'introspection de la source ; on les garde en filet de sécurité (ils
 * sont cités par les GRANT/POLICY et peuvent manquer selon la configuration).
 */
const SUPABASE_ROLES = [
  "anon",
  "authenticated",
  "service_role",
  "authenticator",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_functions_admin",
  "dashboard_user",
  "pgbouncer",
];

/** Schéma par défaut pour une extension si sa localisation est inconnue. */
const EXTENSION_SCHEMA_FALLBACK: Record<string, string> = {
  "uuid-ossp": "extensions",
  pgcrypto: "extensions",
  pgjwt: "extensions",
  citext: "extensions",
  postgis: "public",
};

export interface PrepPlan {
  roles: string[];
  schemas: string[];
  extensions: Array<{ name: string; schema: string }>;
  sql: string;
}

/**
 * Construit le SQL de préparation de la cible jetable.
 *
 * Source de vérité : l'introspection de la base SOURCE (rôles + extensions avec
 * leur schéma exact). L'archive sert uniquement de repli si la source est
 * injoignable. On n'utilise PAS --clean (base vide), donc pas de conflit
 * DROP SCHEMA public avec PostGIS.
 */
export function buildPrepPlan(
  source: SourceIntrospection,
  archive: ArchiveInspection,
  isSupabase: boolean,
): PrepPlan {
  // --- Rôles ---------------------------------------------------------------
  const roleSet = new Set<string>();
  for (const r of source.roles) if (r !== "postgres") roleSet.add(r);
  if (isSupabase) for (const r of SUPABASE_ROLES) roleSet.add(r);
  for (const r of archive.ownerRoles) if (r !== "postgres") roleSet.add(r);

  // --- Extensions (source d'abord, repli archive) --------------------------
  let extensions = source.extensions;
  if (!extensions.length && archive.extensions.length) {
    extensions = archive.extensions.map((name) => ({
      name,
      schema: EXTENSION_SCHEMA_FALLBACK[name] ?? "extensions",
    }));
  }

  // --- Schémas hôtes des extensions (public existe déjà) -------------------
  const schemaSet = new Set<string>();
  for (const e of extensions) if (e.schema !== "public") schemaSet.add(e.schema);

  // --- SQL (idempotent) ----------------------------------------------------
  const parts: string[] = [];
  for (const role of roleSet) {
    parts.push(
      `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE "${role}" NOLOGIN NOINHERIT;
  END IF;
END $$;`,
    );
  }
  for (const schema of schemaSet) {
    parts.push(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);
  }
  for (const ext of extensions) {
    parts.push(
      `CREATE EXTENSION IF NOT EXISTS "${ext.name}" WITH SCHEMA "${ext.schema}";`,
    );
  }

  return {
    roles: [...roleSet],
    schemas: [...schemaSet],
    extensions,
    sql: parts.join("\n"),
  };
}
