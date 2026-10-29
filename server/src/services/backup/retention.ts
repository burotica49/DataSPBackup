import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { backups, policies } from "../../models/repo.js";

/**
 * Applique la rétention d'une politique après une sauvegarde réussie.
 *
 * Une sauvegarde est CONSERVÉE si elle fait partie des `retention_count` plus
 * récentes OU si elle est plus récente que `retention_days`. Les autres sont
 * purgées (fichier + enregistrement, vérifications supprimées en cascade).
 * Si aucun des deux critères n'est défini, rien n'est purgé.
 */
export async function enforceRetention(policyId: number): Promise<void> {
  const policy = policies.get(policyId);
  if (!policy) return;
  const { retention_count, retention_days } = policy;
  if (retention_count == null && retention_days == null) return;

  const list = backups.successfulByPolicy(policyId); // plus récente -> plus ancienne
  const now = Date.now();
  const toDelete = list.filter((b, index) => {
    const keepByCount =
      retention_count != null && index < retention_count;
    let keepByDays = false;
    if (retention_days != null && b.created_at) {
      const ageDays = (now - Date.parse(b.created_at + "Z")) / 86400000;
      keepByDays = ageDays <= retention_days;
    }
    return !(keepByCount || keepByDays);
  });

  for (const b of toDelete) {
    if (b.file_path) {
      await rm(join(config.dataDir, b.file_path), { force: true }).catch(
        (err) =>
          logger.warn(
            { backupId: b.id, err: String(err) },
            "Purge: suppression de fichier échouée",
          ),
      );
    }
    backups.remove(b.id);
  }
  if (toDelete.length) {
    logger.info(
      { policyId, purged: toDelete.length },
      "Rétention appliquée",
    );
  }
}
