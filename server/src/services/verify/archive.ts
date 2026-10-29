import { dataMount, runEphemeral } from "../docker/docker.js";

/**
 * Contenu structurel d'une archive pg_dump (format custom), via pg_restore -l.
 *
 * On n'extrait de façon fiable que les entrées SCHEMA et EXTENSION (descripteurs
 * à un seul mot, schéma « - »). Les rôles propriétaires ne sont PAS extraits
 * ici (les descripteurs multi-mots comme « TABLE DATA », « FK CONSTRAINT » ou
 * « DEFAULT ACL » décalent les colonnes) : ils sont obtenus par introspection
 * de la source (voir sourceIntrospect.ts). Pour les bases Supabase, les
 * extensions ne figurent souvent PAS dans le dump — l'introspection source
 * reste la source de vérité.
 */
export interface ArchiveInspection {
  schemas: string[];
  extensions: string[];
  ownerRoles: string[];
  raw: string;
}

const SCHEMA_LINE = /^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)/;
const EXTENSION_LINE = /^\d+;\s+\d+\s+\d+\s+EXTENSION\s+-\s+(\S+)/;
const USER_MAPPING_LINE = /^\d+;\s+\d+\s+\d+\s+USER MAPPING\b/;

/**
 * Commenter les entrées USER MAPPING du TOC (`pg_restore -L` ignore
 * les lignes préfixées par « ; »). La structure FDW reste, pas les
 * correspondances d'utilisateurs.
 */
export function tocExcludingUserMappings(toc: string): string {
  return toc
    .split("\n")
    .map((line) => (USER_MAPPING_LINE.test(line.trimStart()) ? `;${line}` : line))
    .join("\n");
}

export async function inspectArchive(
  image: string,
  archivePathInContainer: string,
  platform?: string,
): Promise<ArchiveInspection> {
  const res = await runEphemeral({
    image,
    entrypoint: "",
    platform,
    cmd: ["pg_restore", "-l", archivePathInContainer],
    binds: [dataMount(true)],
  });
  if (res.exitCode !== 0 && !res.stdout) {
    throw new Error(
      `pg_restore -l a échoué (code ${res.exitCode}): ${res.stderr.slice(-500)}`,
    );
  }
  return parseToc(res.stdout);
}

export function parseToc(toc: string): ArchiveInspection {
  const schemas = new Set<string>();
  const extensions = new Set<string>();

  for (const line of toc.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;
    const s = trimmed.match(SCHEMA_LINE);
    if (s && s[1]) schemas.add(s[1]);
    const e = trimmed.match(EXTENSION_LINE);
    if (e && e[1]) extensions.add(e[1]);
  }

  return {
    schemas: [...schemas].sort(),
    extensions: [...extensions].sort(),
    ownerRoles: [], // obtenus par introspection de la source
    raw: toc,
  };
}
