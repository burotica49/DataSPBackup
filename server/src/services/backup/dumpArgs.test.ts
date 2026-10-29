import { describe, expect, it } from "vitest";
import { pgDumpFilterArgs } from "./dumpArgs.js";

describe("pgDumpFilterArgs", () => {
  it("traduit schémas, tables et données en arguments pg_dump", () => {
    const args = pgDumpFilterArgs({
      included_schemas: JSON.stringify(["public", "auth"]),
      excluded_tables: JSON.stringify(["public.logs"]),
      excluded_table_data: JSON.stringify(["public.history", "audit.*"]),
    });
    expect(args).toEqual([
      "-n",
      "public",
      "-n",
      "auth",
      "--exclude-table=public.logs",
      "--exclude-table-data=public.history",
      "--exclude-table-data=audit.*",
    ]);
  });

  it("omet les filtres vides", () => {
    expect(
      pgDumpFilterArgs({
        included_schemas: "[]",
        excluded_tables: "[]",
        excluded_table_data: "[]",
      }),
    ).toEqual([]);
  });
});
