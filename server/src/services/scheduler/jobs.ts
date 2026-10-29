import { logger } from "../../lib/logger.js";
import { backups, databases, verifications } from "../../models/repo.js";
import { runBackup } from "../backup/backup.js";
import { enforceRetention } from "../backup/retention.js";
import { runVerification } from "../verify/verify.js";
import { notifyEvent } from "../notify/notify.js";

function dbLabel(databaseId: number): string {
  return databases.get(databaseId)?.name ?? `#${databaseId}`;
}

/**
 * File d'exécution séquentielle en mémoire.
 *
 * Les tâches lourdes (pg_dump, restauration en conteneur) s'exécutent une à la
 * fois pour borner l'usage CPU/disque sur un petit hôte. Pour du parallélisme
 * multi-hôtes, ce sera le rôle de l'agent sortant (évolution ultérieure).
 */
class JobQueue {
  private chain: Promise<unknown> = Promise.resolve();

  enqueue<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      logger.info({ job: name }, "Tâche démarrée");
      try {
        return await fn();
      } catch (err) {
        logger.error({ job: name, err: String(err) }, "Tâche en erreur");
        throw err;
      }
    });
    // La chaîne ne doit pas se rompre sur une erreur de tâche.
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export const jobQueue = new JobQueue();

export interface BackupRequest {
  databaseId: number;
  trigger: "manual" | "schedule";
  encrypt?: boolean;
  verifyAfter?: boolean;
  policyId?: number;
  storageId?: number;
}

/** Crée la sauvegarde, l'exécute, puis enchaîne la vérification si demandé. */
export function requestBackup(req: BackupRequest): { backupId: number } {
  const backup = backups.create(req.databaseId, req.trigger);
  if (req.policyId != null || req.storageId != null) {
    backups.update(backup.id, {
      policy_id: req.policyId ?? null,
      storage_id: req.storageId ?? null,
    });
  }
  const label = dbLabel(req.databaseId);
  jobQueue
    .enqueue(`backup#${backup.id}`, async () => {
      await notifyEvent("start", {
        title: `Sauvegarde lancée — ${label}`,
        message: `Sauvegarde #${backup.id} (${req.trigger}) démarrée.`,
        level: "info",
      });
      await runBackup(backup.id, { encrypt: req.encrypt ?? true });
    })
    .then(async () => {
      const b = backups.get(backup.id);
      await notifyEvent("success", {
        title: `Sauvegarde réussie — ${label}`,
        message:
          `Sauvegarde #${backup.id} terminée` +
          (b?.size_bytes ? ` (${Math.round(b.size_bytes / 1024)} Ko).` : "."),
        level: "success",
      });
      if (req.policyId != null) {
        await enforceRetention(req.policyId).catch(() => undefined);
      }
      if (req.verifyAfter) requestVerification(backup.id, "after_backup");
    })
    .catch(async () => {
      const b = backups.get(backup.id);
      await notifyEvent("failure", {
        title: `Sauvegarde échouée — ${label}`,
        message: `Sauvegarde #${backup.id} : ${b?.error ?? "erreur inconnue"}`,
        level: "error",
      });
    });
  return { backupId: backup.id };
}

/** Crée et exécute une vérification pour une sauvegarde réussie. */
export function requestVerification(
  backupId: number,
  trigger = "manual",
): { verificationId: number } | null {
  const backup = backups.get(backupId);
  if (!backup || backup.status !== "success") {
    logger.warn({ backupId }, "Vérification ignorée: sauvegarde non réussie");
    return null;
  }
  const v = verifications.create(backupId, backup.database_id, trigger);
  const label = dbLabel(backup.database_id);
  jobQueue
    .enqueue(`verify#${v.id}`, async () => {
      await runVerification(v.id);
      // runVerification ne lève pas : on notifie selon le statut final.
      const done = verifications.get(v.id);
      if (done?.status === "success") {
        await notifyEvent("success", {
          title: `Vérification réussie — ${label}`,
          message:
            `Restauration vérifiée (sauvegarde #${backupId}) : ` +
            `${done.schema_count ?? 0} schémas, ${done.table_count ?? 0} tables.`,
          level: "success",
        });
      } else if (done?.status === "failed") {
        await notifyEvent("failure", {
          title: `Vérification échouée — ${label}`,
          message: `Sauvegarde #${backupId} : ${done.root_error ?? "erreur de restauration"}`,
          level: "error",
        });
      }
    })
    .catch(() => undefined);
  return { verificationId: v.id };
}
