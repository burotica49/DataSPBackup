import { describe, expect, it } from "vitest";
import { rowCountDiffs } from "./rowCounts.js";

describe("rowCountDiffs", () => {
  it("ignore l'historique pg_cron et les réponses pg_net", () => {
    const diffs = rowCountDiffs(
      {
        "public.clients": 84,
        "cron.job_run_details": 10602,
        "net._http_response": 54,
        "net.http_request_queue": 3,
      },
      { "public.clients": 84 },
    );
    expect(diffs).toEqual([]);
  });

  it("signale une table applicative trop courte", () => {
    const diffs = rowCountDiffs(
      { "public.chantiers": 500 },
      { "public.chantiers": 10 },
    );
    expect(diffs).toEqual([{ table: "public.chantiers", source: 500, restored: 10 }]);
  });
});
