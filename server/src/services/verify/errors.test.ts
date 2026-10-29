import { describe, expect, it } from "vitest";
import { parseRestoreErrors } from "./errors.js";

describe("parseRestoreErrors", () => {
  it("classe un rôle Supabase manquant comme bloquant et le retient en erreur d'origine", () => {
    const stderr = [
      'pg_restore: creating POLICY "public.items p"',
      'pg_restore: error: could not execute query: ERROR:  role "authenticated" does not exist',
      "pg_restore: error: could not execute query: ERROR:  relation \"public.items\" does not exist",
      "pg_restore: warning: errors ignored on restore: 2",
    ].join("\n");
    const r = parseRestoreErrors(stderr);
    expect(r.blockingCount).toBeGreaterThanOrEqual(2);
    expect(r.ignoredCount).toBe(2);
    expect(r.rootError).toContain("authenticated");
    const cats = r.categorized.map((c) => c.category);
    expect(cats).toContain("role-missing");
    expect(cats).toContain("relation-cascade");
  });

  it("considère 'already exists' comme bénin (cible préparée)", () => {
    const stderr =
      'pg_restore: error: could not execute query: ERROR:  schema "extensions" already exists';
    const r = parseRestoreErrors(stderr);
    expect(r.blockingCount).toBe(0);
    expect(r.categorized[0]?.category).toBe("already-exists");
    expect(r.categorized[0]?.blocking).toBe(false);
  });

  it("considère les privilèges par défaut Supabase comme bénins", () => {
    const stderr =
      "pg_restore: error: could not execute query: ERROR:  permission denied to change default privileges";
    const r = parseRestoreErrors(stderr);
    expect(r.blockingCount).toBe(0);
    expect(r.rootError).toBeNull();
    expect(r.categorized[0]?.category).toBe("default-privileges");
    expect(r.categorized[0]?.blocking).toBe(false);
  });

  it("détecte le conflit PostGIS / DROP SCHEMA public", () => {
    const stderr =
      "pg_restore: error: ERROR:  cannot drop schema public because other objects depend on it";
    const r = parseRestoreErrors(stderr);
    expect(r.categorized[0]?.category).toBe("drop-schema-public-conflict");
    expect(r.categorized[0]?.blocking).toBe(true);
  });
});
