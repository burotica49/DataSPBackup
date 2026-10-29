import type { CategorizedError } from "../../types/models.js";

/**
 * Catalogue des erreurs de restauration (dérivé du §3 du cahier des charges).
 *
 * Objectif : distinguer les erreurs *bloquantes* (la restauration n'est pas
 * fiable) des erreurs *bénignes* (objet déjà présent, DROP impossible dans une
 * cible préparée), au lieu de tout marquer en échec parce que pg_restore sort
 * en code 1. On remonte aussi l'erreur d'ORIGINE et un diagnostic en clair.
 */

interface Rule {
  category: string;
  /** Regex recherchée dans une ligne de stderr de pg_restore. */
  test: RegExp;
  hint: (m: RegExpMatchArray) => string;
  blocking: boolean;
}

const RULES: Rule[] = [
  {
    category: "role-missing",
    test: /role "([^"]+)" does not exist/i,
    hint: (m) =>
      `Rôle « ${m[1]} » manquant dans la cible. Il doit être créé avant la restauration ` +
      `(rôles Supabase: anon, authenticated, service_role, authenticator, ou rôle propriétaire de l'archive).`,
    blocking: true,
  },
  {
    category: "schema-missing",
    test: /schema "([^"]+)" does not exist/i,
    hint: (m) =>
      `Schéma « ${m[1]} » référencé mais non présent (souvent auth/private/extensions non sauvegardés). ` +
      `Inclure ce schéma dans la sauvegarde ou le créer dans la cible.`,
    blocking: true,
  },
  {
    category: "extension-type-missing",
    test: /type "([^"]+)" does not exist/i,
    hint: (m) =>
      `Type « ${m[1]} » absent — extension manquante dans la cible (ex: PostGIS pour geography/geometry).`,
    blocking: true,
  },
  {
    category: "extension-function-missing",
    test: /function ([a-z0-9_.]+\([^)]*\)) does not exist/i,
    hint: (m) =>
      `Fonction « ${m[1]} » absente — extension manquante (ex: uuid-ossp pour uuid_generate_v4, pgcrypto).`,
    blocking: true,
  },
  {
    category: "drop-schema-public-conflict",
    test: /cannot drop schema public because other objects depend on it/i,
    hint: () =>
      `DROP SCHEMA public impossible car des objets en dépendent (extension préinstallée dans public). ` +
      `Restaurer dans une base VIDE sans --clean, ou installer les extensions après les DROP.`,
    blocking: true,
  },
  {
    category: "ownership",
    test: /must be owner of (table|schema|relation|type) ([^\s]+)/i,
    hint: (m) =>
      `Droits insuffisants sur ${m[1]} « ${m[2]} ». Restaurer en superutilisateur dans la cible jetable.`,
    blocking: true,
  },
  {
    category: "permission-denied",
    test: /permission denied for (schema|table|relation) ([^\s]+)/i,
    hint: (m) =>
      `Permission refusée sur ${m[1]} « ${m[2]} ». Propriétaires Supabase attendus ` +
      `(supabase_auth_admin, supabase_storage_admin) ; restaurer en superutilisateur.`,
    blocking: true,
  },
  {
    category: "column-missing",
    test: /column "([^"]+)" (of relation "[^"]+" )?does not exist/i,
    hint: (m) =>
      `Colonne « ${m[1]} » absente pendant un COPY : la version de la cible est plus ancienne ` +
      `que la source (schémas auth/storage). Exiger une cible de version ≥ source.`,
    blocking: true,
  },
  {
    category: "relation-cascade",
    test: /relation "([^"]+)" does not exist/i,
    hint: (m) =>
      `Relation « ${m[1]} » absente : un CREATE TABLE a probablement échoué plus haut. ` +
      `Voir l'erreur d'origine.`,
    blocking: true,
  },
  // --- Bénignes (cible préparée) -------------------------------------------
  {
    category: "already-exists",
    test: /(already exists|déjà existant)/i,
    hint: () =>
      `Objet déjà présent (rôle/extension/schéma préparé avant la restauration). Sans conséquence.`,
    blocking: false,
  },
  {
    category: "drop-noop",
    test: /does not exist, skipping/i,
    hint: () => `DROP d'un objet absent, ignoré. Sans conséquence.`,
    blocking: false,
  },
  {
    category: "default-privileges",
    test: /permission denied to change default privileges/i,
    hint: () =>
      `Le rôle connecté ne peut pas modifier les privilèges par défaut ` +
      `(ALTER DEFAULT PRIVILEGES, souvent ceux de supabase_admin). ` +
      `Les tables et les données sont restaurées ; sur une base Supabase ces privilèges sont déjà en place.`,
    blocking: false,
  },
];

export interface ParsedErrors {
  categorized: CategorizedError[];
  rootError: string | null;
  blockingCount: number;
  ignoredCount: number;
}

/**
 * Analyse la sortie d'erreur complète de pg_restore (pas seulement la fin).
 */
export function parseRestoreErrors(stderr: string): ParsedErrors {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const byCategory = new Map<string, CategorizedError>();
  let rootError: string | null = null;
  let ignoredCount = 0;

  for (const line of lines) {
    const ignoredMatch = line.match(/errors ignored on restore:\s*(\d+)/i);
    if (ignoredMatch) {
      ignoredCount = Number(ignoredMatch[1]);
      continue;
    }
    // On ne catégorise que les lignes d'erreur réelles.
    if (!/error|erreur|does not exist|permission|must be owner|cannot/i.test(line)) {
      continue;
    }
    let matched = false;
    for (const rule of RULES) {
      const m = line.match(rule.test);
      if (!m) continue;
      matched = true;
      const existing = byCategory.get(rule.category);
      if (existing) {
        existing.count += 1;
      } else {
        byCategory.set(rule.category, {
          category: rule.category,
          count: 1,
          sample: line,
          hint: rule.hint(m),
          blocking: rule.blocking,
        });
      }
      if (rule.blocking && rootError === null) rootError = line;
      break;
    }
    if (!matched && rootError === null && /error|cannot/i.test(line)) {
      // Erreur non cataloguée : la retenir comme erreur d'origine candidate.
      byCategory.set("other", {
        category: "other",
        count: (byCategory.get("other")?.count ?? 0) + 1,
        sample: line,
        hint: "Erreur non cataloguée, à examiner.",
        blocking: true,
      });
      rootError = line;
    }
  }

  const categorized = [...byCategory.values()];
  const blockingCount = categorized
    .filter((c) => c.blocking)
    .reduce((s, c) => s + c.count, 0);

  return { categorized, rootError, blockingCount, ignoredCount };
}
