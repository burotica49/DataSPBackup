import { defineStore } from "pinia";
import { api } from "../lib/api";
import { useToasts } from "./toasts";

interface Backup {
  id: number;
  database_id: number;
  status: string;
  error: string | null;
}
interface Verif {
  id: number;
  backup_id: number;
  database_id: number;
  status: string;
  root_error: string | null;
}
interface Restore {
  id: number;
  status: string;
  target_label: string;
  root_error: string | null;
}

const TERMINAL = new Set(["success", "failed", "canceled"]);

/**
 * Sonde l'état des sauvegardes et vérifications et émet un toast quand l'une
 * d'elles atteint un état final. Évite les doublons et ne notifie pas
 * l'historique déjà terminé au démarrage (phase d'amorçage).
 */
export const useActivity = defineStore("activity", () => {
  const toasts = useToasts();
  const backupStatus = new Map<number, string>();
  const verifStatus = new Map<number, string>();
  const restoreStatus = new Map<number, string>();
  let primed = false;
  let timer: number | undefined;

  async function tick(): Promise<void> {
    try {
      const [backups, verifs, rests] = await Promise.all([
        api.get<Backup[]>("/api/backups"),
        api.get<Verif[]>("/api/verifications"),
        api.get<Restore[]>("/api/restores"),
      ]);

      for (const b of backups) {
        const prev = backupStatus.get(b.id);
        backupStatus.set(b.id, b.status);
        if (!primed || prev === b.status) continue;
        if (b.status === "success") {
          toasts.success(`Sauvegarde #${b.id} réussie`, {
            to: `/?db=${b.database_id}&tab=backups&detail=backup&id=${b.id}`,
            label: "Voir",
          });
        } else if (b.status === "failed") {
          toasts.error(
            `Sauvegarde #${b.id} échouée${b.error ? " : " + b.error : ""}`,
            { to: `/?db=${b.database_id}&tab=backups&detail=backup&id=${b.id}`, label: "Voir" },
          );
        }
      }

      for (const v of verifs) {
        const prev = verifStatus.get(v.id);
        verifStatus.set(v.id, v.status);
        if (!primed || prev === v.status || !TERMINAL.has(v.status)) continue;
        if (v.status === "success") {
          toasts.success(`Vérification #${v.id} réussie`, {
            to: `/?db=${v.database_id}&tab=verifs&detail=verification&id=${v.id}`,
            label: "Voir le rapport",
          });
        } else if (v.status === "failed") {
          toasts.error(`Vérification #${v.id} échouée`, {
            to: `/?db=${v.database_id}&tab=verifs&detail=verification&id=${v.id}`,
            label: "Voir le rapport",
          });
        }
      }

      for (const r of rests) {
        const prev = restoreStatus.get(r.id);
        restoreStatus.set(r.id, r.status);
        if (!primed || prev === r.status || !TERMINAL.has(r.status)) continue;
        if (r.status === "success") {
          toasts.success(`Restauration réussie → ${r.target_label}`, { to: `/?detail=restore&id=${r.id}`, label: "Voir" });
        } else if (r.status === "failed") {
          toasts.error(`Restauration échouée → ${r.target_label}`, { to: `/?detail=restore&id=${r.id}`, label: "Voir" });
        }
      }

      primed = true;
    } catch {
      /* hors ligne / non authentifié : on réessaiera au prochain tick */
    }
  }

  function start(): void {
    if (timer) return;
    void tick();
    timer = window.setInterval(tick, 3000);
  }
  function stop(): void {
    if (timer) window.clearInterval(timer);
    timer = undefined;
    primed = false;
    backupStatus.clear();
    verifStatus.clear();
    restoreStatus.clear();
  }

  return { start, stop };
});
