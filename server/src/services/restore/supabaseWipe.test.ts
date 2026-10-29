import { describe, expect, it } from "vitest";
import { appRestorePlan, captureTriggersSql, dropAppObjectsSql } from "./supabaseWipe.js";

const TOC = `
3; 2615 2200 SCHEMA - public pg_database_owner
8; 2615 16500 SCHEMA - auth supabase_auth_admin
9; 2615 16600 SCHEMA - extensions postgres
12; 2615 17000 SCHEMA - private postgres
210; 1259 16456 TABLE public profiles postgres
211; 1259 16460 TABLE auth users supabase_auth_admin
212; 1259 16470 TABLE public clients postgres
213; 1259 16480 TABLE private notes postgres
3456; 0 16456 TABLE DATA public profiles postgres
4890; 2606 16460 FK CONSTRAINT public profiles profiles_id_fkey postgres
`;

describe("appRestorePlan", () => {
  it("rejoue public et private, pas les schémas Supabase", () => {
    const plan = appRestorePlan(TOC);
    expect(plan.schemas).toEqual(["private", "public"]);
    expect(plan.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      "private.notes",
      "public.clients",
      "public.profiles",
    ]);
  });
});

describe("dropAppObjectsSql", () => {
  const sql = dropAppObjectsSql();

  it("supprime les schémas applicatifs et les tables de public", () => {
    expect(sql).toContain("DROP SCHEMA IF EXISTS %I CASCADE");
    expect(sql).toContain("nspname = 'public'");
    expect(sql).toContain("DROP %s IF EXISTS public.%I CASCADE");
    expect(sql).toContain("DROP SEQUENCE IF EXISTS public.%I CASCADE");
    expect(sql).toContain("deptype = 'e'");
    expect(sql).toContain("deptype IN ('a', 'i')");
    expect(sql).toContain("t.typrelid");
    const tableDrop = sql.indexOf("relkind IN ('v','m','r','p','f')");
    const sequenceDrop = sql.indexOf("c.relkind = 'S'");
    expect(tableDrop).toBeGreaterThan(-1);
    expect(sequenceDrop).toBeGreaterThan(tableDrop);
  });

  it("laisse public, auth et les objets d'extension", () => {
    expect(sql).toContain("n.nspname <> 'public'");
    expect(sql).toContain("'auth'");
    expect(sql).toContain("'storage'");
    expect(sql).not.toMatch(/DROP SCHEMA IF EXISTS public/);
  });
});

describe("captureTriggersSql", () => {
  it("cible les triggers Supabase qui appellent une fonction applicative", () => {
    const sql = captureTriggersSql(["public", "private"]);
    expect(sql).toContain("pg_get_triggerdef");
    expect(sql).toContain("'public'");
    expect(sql).toContain("'auth'");
    expect(captureTriggersSql([])).toBe("");
    expect(captureTriggersSql(["public; drop"])).toBe("");
  });
});
