/** Liste JSON stockée en base → motifs pg_dump, dans l'ordre, sans doublon. */
export function parseNameList(raw: string | null | undefined): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * Arguments de filtre de pg_dump.
 * - schémas inclus : `-n`
 * - tables exclues entièrement : `--exclude-table`
 * - données exclues (structure conservée) : `--exclude-table-data`
 */
export function pgDumpFilterArgs(source: {
  included_schemas?: string | null;
  excluded_tables?: string | null;
  excluded_table_data?: string | null;
}): string[] {
  const args: string[] = [];
  for (const schema of parseNameList(source.included_schemas)) {
    args.push("-n", schema);
  }
  for (const table of parseNameList(source.excluded_tables)) {
    args.push(`--exclude-table=${table}`);
  }
  for (const table of parseNameList(source.excluded_table_data)) {
    args.push(`--exclude-table-data=${table}`);
  }
  return args;
}
