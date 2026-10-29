/**
 * Restauration « base Supabase » : supprimer les objets applicatifs et
 * rejouer la sauvegarde, sans toucher à ce dont Supabase a besoin.
 *
 * Conservé : schémas internes (auth, storage, realtime…), rôles, extensions
 * et objets qui leur appartiennent (ex. tables PostGIS dans public).
 * Le schéma public lui-même n'est pas supprimé : des extensions en dépendent.
 *
 * Supprimé puis recréé depuis l'archive : tables, vues, fonctions et types
 * applicatifs de public, et les autres schémas applicatifs (private…).
 * Les séquences serial/identity partent avec leur table : DROP SEQUENCE
 * échoue tant que la colonne générée existe. Le type ligne d'une table
 * conservée (extension) n'est pas supprimé non plus.
 */

/** Schémas laissés intacts (structure et données). */
export const SUPABASE_KEEP_SCHEMAS = [
  "auth",
  "storage",
  "realtime",
  "extensions",
  "supabase_functions",
  "supabase_migrations",
  "graphql",
  "graphql_public",
  "vault",
  "pgbouncer",
  "cron",
  "net",
  "pgsodium",
  "pgsodium_masks",
  "_realtime",
  "_analytics",
  "topology",
  "tiger",
  "tiger_data",
  "information_schema",
  "pg_catalog",
  "pg_toast",
] as const;

const KEEP = new Set<string>(SUPABASE_KEEP_SCHEMAS);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** TABLE, pas TABLE DATA ni les autres descripteurs. */
const TABLE_LINE = /^\d+;\s+\d+\s+\d+\s+TABLE\s+(?!DATA\b)(\S+)\s+(\S+)\s+/;
const SCHEMA_LINE = /^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)/;

export interface AppRestorePlan {
  /** Schémas rejoués par pg_restore (-n). */
  schemas: string[];
  tables: Array<{ schema: string; name: string }>;
}

export function appRestorePlan(toc: string): AppRestorePlan {
  const schemas = new Set<string>();
  const tables: Array<{ schema: string; name: string }> = [];
  const seen = new Set<string>();

  for (const line of toc.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;

    const schema = trimmed.match(SCHEMA_LINE);
    if (schema?.[1] && isAppSchema(schema[1])) schemas.add(schema[1]);

    const table = trimmed.match(TABLE_LINE);
    if (!table?.[1] || !table[2]) continue;
    if (!isAppSchema(table[1]) || !IDENT.test(table[2])) continue;
    const key = `${table[1]}.${table[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schemas.add(table[1]);
    tables.push({ schema: table[1], name: table[2] });
  }

  return {
    schemas: [...schemas].sort(),
    tables: tables.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)),
  };
}

function isAppSchema(name: string): boolean {
  return IDENT.test(name) && !KEEP.has(name);
}

function sqlList(names: readonly string[]): string {
  return names.filter((n) => IDENT.test(n)).map((n) => `'${n}'`).join(",");
}

/**
 * Définitions des triggers posés sur un schéma Supabase (souvent auth.users)
 * qui appellent une fonction applicative. À rejouer après le DROP CASCADE.
 */
export function captureTriggersSql(appSchemas: string[]): string {
  const apps = sqlList(appSchemas);
  const kept = sqlList(SUPABASE_KEEP_SCHEMAS);
  if (!apps || !kept) return "";
  return `
SELECT replace(pg_get_triggerdef(t.oid), E'\\n', ' ')
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE NOT t.tgisinternal
  AND n.nspname IN (${kept})
  AND pn.nspname IN (${apps})
ORDER BY 1;
`.trim();
}

/**
 * Supprime tout ce qui n'est pas nécessaire à Supabase.
 * public est vidé de ses objets applicatifs ; les objets d'extension restent.
 */
export function dropAppObjectsSql(): string {
  const kept = sqlList(SUPABASE_KEEP_SCHEMAS);
  return `
DO $dsb$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname
    FROM pg_namespace n
    WHERE n.nspname <> 'public'
      AND n.nspname NOT LIKE 'pg\\_%'
      AND n.nspname NOT IN (${kept})
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = n.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', r.nspname);
  END LOOP;

  -- Vues d'abord, puis tables. CASCADE emporte les séquences serial/identity
  -- (OWNED BY / GENERATED AS IDENTITY) : un DROP SEQUENCE explicite échoue
  -- tant que la colonne existe.
  FOR r IN
    SELECT c.relkind, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('v','m','r','p','f')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY CASE c.relkind WHEN 'v' THEN 0 WHEN 'm' THEN 1 ELSE 2 END, c.relname
  LOOP
    EXECUTE format(
      'DROP %s IF EXISTS public.%I CASCADE',
      CASE r.relkind
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      r.relname
    );
  END LOOP;

  -- Séquences autonomes seulement. Celles liées à une colonne sont déjà
  -- parties avec la table, ou appartiennent à un objet conservé.
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.refclassid = 'pg_class'::regclass
          AND d.refobjsubid <> 0
          AND d.deptype IN ('a', 'i')
      )
  LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.relname);
  END LOOP;

  FOR r IN
    SELECT n.nspname, p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'DROP %s IF EXISTS public.%I(%s) CASCADE',
      CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      r.proname,
      r.args
    );
  END LOOP;

  FOR r IN
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e','c','d')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e'
      )
      -- Le type ligne d'une table (ex. objet d'extension conservé) ne se
      -- supprime pas seul : il part avec la table, ou doit rester avec elle.
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.oid = t.typrelid
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      )
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
END
$dsb$;
`.trim();
}
