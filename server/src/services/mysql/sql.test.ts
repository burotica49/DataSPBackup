import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  countQuery,
  createStripDefinerStream,
  dumpFlags,
  dumpInvocations,
  imageFor,
  parseServerVersion,
  sqlLiteral,
  sslArgs,
  stripDefiners,
  tableGlobToLike,
} from "./sql.js";

describe("parseServerVersion", () => {
  it("reconnaît MySQL 8.0, 8.4 et MariaDB", () => {
    expect(parseServerVersion("8.0.36")).toMatchObject({ variant: "mysql", series: "8.0" });
    expect(parseServerVersion("8.4.3")).toMatchObject({ variant: "mysql", series: "8.4" });
    expect(parseServerVersion("10.11.6-MariaDB-1")).toMatchObject({
      variant: "mariadb",
      series: "10.11",
    });
    expect(imageFor(parseServerVersion("8.4.3"))).toBe("mysql:8.4");
    expect(imageFor(parseServerVersion("11.4.2-MariaDB"))).toBe("mariadb:11.4");
  });
});

describe("dumpFlags", () => {
  it("omet les options MySQL 8 sur une 5.7 et sur MariaDB", () => {
    const mysql8 = dumpFlags(parseServerVersion("8.0.36"));
    expect(mysql8).toContain("--column-statistics=0");
    expect(mysql8).toContain("--set-gtid-purged=OFF");
    const mysql57 = dumpFlags(parseServerVersion("5.7.44"));
    expect(mysql57).not.toContain("--column-statistics=0");
    expect(mysql57).toContain("--set-gtid-purged=OFF");
    const maria = dumpFlags(parseServerVersion("10.11.6-MariaDB"));
    expect(maria).not.toContain("--set-gtid-purged=OFF");
    expect(maria).not.toContain("--column-statistics=0");
  });

  it("traduit le mode SSL", () => {
    expect(sslArgs("require", "mysql")).toEqual(["--ssl-mode=REQUIRED"]);
    expect(sslArgs("disable", "mariadb")).toEqual(["--skip-ssl"]);
    expect(sslArgs("prefer", "mariadb")).toEqual([]);
  });
});

describe("dumpInvocations", () => {
  it("sépare la structure des tables dont les données sont exclues", () => {
    expect(dumpInvocations("app", ["logs"], ["history"])).toEqual([
      ["--no-data", "--skip-triggers", "app", "history"],
      ["--ignore-table=app.logs", "--ignore-table=app.history", "app"],
    ]);
    expect(dumpInvocations("app", ["logs"], [])).toEqual([["--ignore-table=app.logs", "app"]]);
  });

  it("convertit un joker en LIKE", () => {
    expect(tableGlobToLike("audit_*")).toEqual({ schema: null, like: "audit\\_%" });
    expect(tableGlobToLike("app.logs")).toEqual({ schema: "app", like: "logs" });
    expect(sqlLiteral("a'b")).toBe("'a''b'");
    expect(countQuery(["users"])).toContain("FROM `users`");
  });
});

describe("stripDefiners", () => {
  it("retire DEFINER sans toucher SQL SECURITY DEFINER", () => {
    const sql = "CREATE DEFINER=`root`@`localhost` PROCEDURE p() SQL SECURITY DEFINER BEGIN END";
    const out = stripDefiners(sql);
    expect(out).not.toContain("DEFINER=");
    expect(out).toContain("SQL SECURITY DEFINER");
    expect(out).toContain("PROCEDURE p()");
  });

  it("retire DEFINER même coupé entre deux blocs", async () => {
    const pad = "/* " + "a".repeat(400) + " */\n";
    const sql =
      pad + "CREATE DEFINER=`root`@`localhost` PROCEDURE p() BEGIN END;\n" + pad;
    const chunks: string[] = [];
    for (let i = 0; i < sql.length; i += 50) chunks.push(sql.slice(i, i + 50));
    const out: Buffer[] = [];
    await pipeline(
      Readable.from(chunks),
      createStripDefinerStream(),
      new Writable({
        write(chunk, _enc, cb) {
          out.push(Buffer.from(chunk));
          cb();
        },
      }),
    );
    const text = Buffer.concat(out).toString();
    expect(text).toBe(stripDefiners(sql));
    expect(text).not.toContain("DEFINER=");
  });
});
