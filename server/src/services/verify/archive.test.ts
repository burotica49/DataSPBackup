import { describe, expect, it } from "vitest";
import { parseToc } from "./archive.js";

// Extrait réaliste de `pg_restore -l` d'une archive Supabase.
const TOC = `;
; Archive created at 2026-01-01 00:00:00 UTC
;     dbname: postgres
;
; Selected TOC Entries:
;
3; 2615 2200 SCHEMA - public pg_database_owner
8; 2615 16500 SCHEMA - auth supabase_auth_admin
9; 2615 16600 SCHEMA - extensions postgres
4; 3079 16400 EXTENSION - postgis
5; 3079 16410 EXTENSION - uuid-ossp
210; 1259 16456 TABLE public items postgres
211; 1259 16460 TABLE auth users supabase_auth_admin
`;

describe("parseToc", () => {
  it("extrait schémas et extensions des entrées SCHEMA/EXTENSION", () => {
    const r = parseToc(TOC);
    expect(r.schemas).toContain("auth");
    expect(r.schemas).toContain("extensions");
    expect(r.extensions).toEqual(["postgis", "uuid-ossp"]);
    // Les rôles viennent de l'introspection source, pas du TOC.
    expect(r.ownerRoles).toEqual([]);
  });

  it("ne confond pas les descripteurs multi-mots (TABLE DATA, FK CONSTRAINT)", () => {
    const toc = `210; 1259 16456 TABLE public items postgres
3456; 0 16456 TABLE DATA public items postgres
4890; 2606 16460 FK CONSTRAINT public items items_fk postgres
5001; 0 0 DEFAULT ACL - public postgres`;
    const r = parseToc(toc);
    // Aucune de ces lignes ne doit polluer schémas/extensions.
    expect(r.schemas).toEqual([]);
    expect(r.extensions).toEqual([]);
  });
});
