import { logger } from "../../lib/logger.js";
import { databases } from "../../models/repo.js";
import { runAvailabilityCheck } from "../availability/run.js";

const TICK_MS = 15_000;
const PARALLEL = 4;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = databases.list().filter((d) => {
      if (d.avail_enabled !== 1) return false;
      const last = d.avail_last_check_at ? Date.parse(d.avail_last_check_at) : 0;
      return now - last >= d.avail_interval_min * 60_000;
    });
    for (let i = 0; i < due.length; i += PARALLEL) {
      const batch = due.slice(i, i + PARALLEL);
      await Promise.all(
        batch.map(async (d) => {
          try {
            await runAvailabilityCheck(d.id);
          } catch (err) {
            logger.warn(
              { databaseId: d.id, err: String(err) },
              "Surveillance de disponibilité interrompue",
            );
          }
        }),
      );
    }
  } finally {
    ticking = false;
  }
}

/** Contrôle périodique des bases dont la surveillance est activée. */
export function startAvailabilityMonitor(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  logger.info("Surveillance de disponibilité démarrée");
}
