import cron from "node-cron";
import { getDb } from "../../db/index.js";
import { logger } from "../../lib/logger.js";
import type { BackupPolicy } from "../../types/models.js";
import { requestBackup } from "./jobs.js";

/**
 * Planificateur cron. Charge les politiques activées et programme les
 * sauvegardes. Les expressions cron sont interprétées en UTC.
 */
const tasks = new Map<number, cron.ScheduledTask>();

export function startScheduler(): void {
  reloadSchedules();
  logger.info("Planificateur démarré");
}

export function reloadSchedules(): void {
  for (const task of tasks.values()) task.stop();
  tasks.clear();

  const policies = getDb()
    .prepare("SELECT * FROM backup_policies WHERE enabled = 1")
    .all() as BackupPolicy[];

  for (const p of policies) {
    if (!cron.validate(p.schedule_cron)) {
      logger.warn({ policyId: p.id, cron: p.schedule_cron }, "Cron invalide");
      continue;
    }
    const task = cron.schedule(
      p.schedule_cron,
      () => {
        logger.info({ policyId: p.id }, "Sauvegarde planifiée déclenchée");
        requestBackup({
          databaseId: p.database_id,
          trigger: "schedule",
          encrypt: p.encrypt === 1,
          verifyAfter: p.verify_after === 1,
          policyId: p.id,
          storageId: p.storage_id,
        });
      },
      { timezone: "UTC" },
    );
    tasks.set(p.id, task);
  }
  logger.info({ count: tasks.size }, "Planifications chargées");
}
