/**
 * Journaux de plateforme. Ils grossissent en continu et leur contenu n'est
 * pas une mesure de la sauvegarde applicative (pg_cron, pg_net).
 */
const VOLATILE_TABLES = new Set([
  "cron.job_run_details",
  "net._http_response",
  "net.http_request_queue",
]);

const TOLERANCE_RATIO = 0.1;
const TOLERANCE_ABS = 100;

export interface RowCountDiff {
  table: string;
  source: number;
  restored: number;
}

/** Écarts de lignes qui font échouer la vérification. */
export function rowCountDiffs(
  sourceRows: Record<string, number>,
  restoredRows: Record<string, number>,
): RowCountDiff[] {
  const diffs: RowCountDiff[] = [];
  for (const [table, srcCount] of Object.entries(sourceRows)) {
    if (VOLATILE_TABLES.has(table)) continue;
    const restored = restoredRows[table] ?? 0;
    const allowed = Math.max(TOLERANCE_ABS, srcCount * TOLERANCE_RATIO);
    if (restored < srcCount - allowed) diffs.push({ table, source: srcCount, restored });
  }
  return diffs;
}
