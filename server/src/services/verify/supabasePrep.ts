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
  "supabase_realtime_admin",
  "supabase_replication_admin",
  "supabase_read_only_user",
  "supabase_etl_admin",
  "dashboard_user",
  "pgbouncer",
  "pgsodium_keyholder",
  "pgsodium_keyiduser",
  "pgsodium_keymaker",
];

/**
 * Rôles cités par ALTER DEFAULT PRIVILEGES et par GRANT … GRANTED BY.
 * Depuis PostgreSQL 15, même un superutilisateur doit en être membre.
 */
const MEMBERSHIP_ROLES = [
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_functions_admin",
  "supabase_realtime_admin",
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
  // pg_cron des images Supabase n'est pas déplaçable : il s'installe dans
  // pg_catalog et crée lui-même le schéma cron. WITH SCHEMA cron échoue.
  extensions = extensions.map((e) =>
    e.name === "pg_cron" ? { name: e.name, schema: "pg_catalog" } : e,
  );
  const hasPgCron = extensions.some((e) => e.name === "pg_cron");

  // --- Schémas hôtes des extensions (public et pg_catalog existent déjà) --
  const schemaSet = new Set<string>();
  for (const e of extensions) {
    if (e.schema === "public" || e.schema === "pg_catalog") continue;
    schemaSet.add(e.schema);
  }

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
  // Si CREATE EXTENSION a échoué, le dump référence quand même le schéma.
  if (hasPgCron) parts.push(`CREATE SCHEMA IF NOT EXISTS cron;`);
  if (isSupabase) {
    for (const role of MEMBERSHIP_ROLES) {
      parts.push(`GRANT "${role}" TO postgres WITH ADMIN OPTION;`);
      if (role !== "supabase_admin") {
        parts.push(`GRANT "${role}" TO supabase_admin WITH ADMIN OPTION;`);
      }
    }
  }

  return {
    roles: [...roleSet],
    schemas: [...schemaSet],
    extensions,
    sql: parts.join("\n"),
  };
}
