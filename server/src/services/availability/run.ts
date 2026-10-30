import { logger } from "../../lib/logger.js";
import { availability, databases } from "../../models/repo.js";
import type { AvailabilityCheck } from "../../types/models.js";
import { notifyEvent } from "../notify/notify.js";
import { probeDatabase } from "./probe.js";
import { decideAvailability, safeError } from "./state.js";

const inFlight = new Set<number>();

/**
 * Une tentative : SELECT 1, historique, seuil d'indisponibilité, notification.
 * Les appels simultanés pour la même base sont ignorés.
 */
export async function runAvailabilityCheck(databaseId: number): Promise<AvailabilityCheck | null> {
  if (inFlight.has(databaseId)) return null;
  inFlight.add(databaseId);
  const started = Date.now();
  try {
    const source = databases.get(databaseId);
    if (!source) return null;

    let ok = false;
    let error: string | null = null;
    try {
      await probeDatabase(source);
      ok = true;
    } catch (err) {
      error = safeError(err);
      logger.info({ databaseId, err: error }, "Disponibilité : échec de connexion");
    }

    const decision = decideAvailability({
      ok,
      failStreak: source.avail_fail_streak,
      alreadyDown: source.avail_down === 1,
      attempts: source.avail_attempts,
      notify: source.avail_notify === 1,
    });
    const checkedAt = new Date().toISOString();
    const row = availability.insert({
      database_id: databaseId,
      ok: ok ? 1 : 0,
      latency_ms: Date.now() - started,
      error,
      checked_at: checkedAt,
    });
    databases.update(databaseId, {
      avail_fail_streak: decision.failStreak,
      avail_down: decision.down ? 1 : 0,
      avail_last_check_at: checkedAt,
    });
    availability.purge(databaseId, source.avail_history_days);

    if (decision.shouldNotify) {
      await notifyEvent("failure", {
        title: `Base indisponible — ${source.name}`,
        message:
          `${source.name} (${source.host}:${source.port}/${source.db_name}) ` +
          `ne répond plus après ${source.avail_attempts} tentative(s).\n` +
          (error ?? "Connexion impossible"),
        level: "error",
      });
    }
    return row;
  } finally {
    inFlight.delete(databaseId);
  }
}
