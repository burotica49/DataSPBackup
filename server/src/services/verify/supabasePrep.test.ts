import { describe, expect, it } from "vitest";
import { buildPrepPlan } from "./supabasePrep.js";
import type { ArchiveInspection } from "./archive.js";
import type { SourceIntrospection } from "./sourceIntrospect.js";

const archive: ArchiveInspection = {
  schemas: ["public"],
  extensions: [],
  ownerRoles: [],
  raw: "",
};

const source: SourceIntrospection = {
  roles: ["authenticated"],
  extensions: [{ name: "pg_cron", schema: "pg_catalog" }],
};

describe("buildPrepPlan", () => {
  it("crée les rôles plateforme Supabase et rend postgres membre de supabase_admin", () => {
    const plan = buildPrepPlan(source, archive, true);
    expect(plan.roles).toContain("supabase_realtime_admin");
    expect(plan.roles).toContain("supabase_admin");
    expect(plan.sql).toContain('GRANT "supabase_admin" TO postgres WITH ADMIN OPTION;');
    expect(plan.sql).toContain(
      'GRANT "supabase_realtime_admin" TO supabase_admin WITH ADMIN OPTION;',
    );
  });

  it("installe pg_cron dans pg_catalog puis assure le schéma cron", () => {
    const plan = buildPrepPlan(
      { roles: [], extensions: [{ name: "pg_cron", schema: "cron" }] },
      archive,
      true,
    );
    const extAt = plan.sql.indexOf(
      'CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog"',
    );
    const schemaAt = plan.sql.indexOf("CREATE SCHEMA IF NOT EXISTS cron;");
    expect(extAt).toBeGreaterThan(-1);
    expect(schemaAt).toBeGreaterThan(extAt);
    expect(plan.sql).not.toContain('WITH SCHEMA "cron"');
  });

  it("n'ajoute pas les rôles Supabase hors base Supabase", () => {
    const plan = buildPrepPlan(source, archive, false);
    expect(plan.roles).not.toContain("supabase_realtime_admin");
    expect(plan.sql).not.toContain("GRANT");
  });
});
