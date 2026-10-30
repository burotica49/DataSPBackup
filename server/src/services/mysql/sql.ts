/**
 * Pur : images, arguments mysqldump, identifiants SQL.
 * Aucun appel Docker ici.
 */
import { Transform } from "node:stream";

export interface MysqlTarget {
  variant: "mysql" | "mariadb";
  /** Série d'image, ex. "8.0" ou "10.11". */
  series: string;
  /** Chaîne VERSION() brute. */
  raw: string;
}

export function parseServerVersion(raw: string): MysqlTarget {
  const text = raw.trim();
  const match = text.match(/(\d+)\.(\d+)/);
  if (!match) throw new Error(`Version MySQL illisible : ${text}`);
  const variant = /mariadb/i.test(text) ? "mariadb" : "mysql";
  return { variant, series: `${match[1]}.${match[2]}`, raw: text };
}

export function imageFor(target: MysqlTarget): string {
  const repo = target.variant === "mariadb" ? "mariadb" : "mysql";
  return `${repo}:${target.series}`;
}

export function sslArgs(sslMode: string, variant: MysqlTarget["variant"]): string[] {
  const mode = (sslMode || "prefer").toLowerCase();
  if (variant === "mariadb") {
    if (mode === "disable") return ["--skip-ssl"];
    if (mode === "require" || mode.startsWith("verify")) return ["--ssl"];
    return [];
  }
  const mapped: Record<string, string> = {
    disable: "DISABLED",
    allow: "PREFERRED",
    prefer: "PREFERRED",
    require: "REQUIRED",
    "verify-ca": "VERIFY_CA",
    "verify-full": "VERIFY_IDENTITY",
  };
  return [`--ssl-mode=${mapped[mode] ?? "PREFERRED"}`];
}

/** Options communes de mysqldump, selon la famille et la série. */
export function dumpFlags(target: MysqlTarget): string[] {
  const flags = [
    "--single-transaction",
    "--routines",
    "--events",
    "--triggers",
    "--hex-blob",
    "--default-character-set=utf8mb4",
  ];
  if (target.variant !== "mysql") return flags;
  flags.push("--set-gtid-purged=OFF");
  const major = Number(target.series.split(".")[0]);
  if (major >= 8) flags.push("--column-statistics=0", "--no-tablespaces");
  return flags;
}

export interface MysqlConn {
  host: string;
  port: number;
  username: string;
  ssl_mode: string;
}

/** Arguments client. --protocol=TCP évite le socket Unix quand l'hôte est localhost. */
export function clientArgs(conn: MysqlConn, target: MysqlTarget): string[] {
  return [
    "--protocol=TCP",
    "-h",
    conn.host,
    "-P",
    String(conn.port),
    "-u",
    conn.username,
    ...sslArgs(conn.ssl_mode, target.variant),
  ];
}

export function quoteIdent(value: string): string {
  return "`" + value.replace(/`/g, "``") + "`";
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** Motif (logs, db.logs, audit_*) → schéma optionnel + motif LIKE. */
export function tableGlobToLike(pattern: string): { schema: string | null; like: string } {
  const dot = pattern.indexOf(".");
  const schema = dot >= 0 ? pattern.slice(0, dot) : null;
  const table = dot >= 0 ? pattern.slice(dot + 1) : pattern;
  let like = "";
  for (const ch of table) {
    if (ch === "*") like += "%";
    else if (ch === "%" || ch === "_" || ch === "\\") like += `\\${ch}`;
    else like += ch;
  }
  return { schema, like };
}

export function isGlob(pattern: string): boolean {
  return pattern.includes("*");
}

/**
 * Invocations mysqldump pour une base.
 * Les tables « données exclues » sont d'abord vidées de leur contenu
 * (structure seule), puis omises du dump complet.
 */
export function dumpInvocations(
  db: string,
  excluded: string[],
  dataExcluded: string[],
): string[][] {
  const skipData = dataExcluded.filter((t) => !excluded.includes(t));
  const ignore = [...excluded, ...skipData].map((t) => `--ignore-table=${db}.${t}`);
  const full = [...ignore, db];
  if (!skipData.length) return [full];
  return [["--no-data", "--skip-triggers", db, ...skipData], full];
}

/** SELECT t, COUNT(*) pour un lot de tables de la base courante. */
export function countQuery(tables: string[]): string {
  return tables
    .map((t) => `SELECT ${sqlLiteral(t)} AS t, COUNT(*) AS c FROM ${quoteIdent(t)}`)
    .join(" UNION ALL ");
}

function definerRe(): RegExp {
  return /DEFINER\s*=\s*(?:`[^`]*`|'[^']*'|[A-Za-z0-9_]+)@(?:`[^`]*`|'[^']*'|[A-Za-z0-9_.%]+)/gi;
}

/** Retire DEFINER= pour qu'un import n'exige pas les comptes d'origine. */
export function stripDefiners(sql: string): string {
  return sql.replace(definerRe(), "");
}

/** Flux qui retire DEFINER, y compris si le motif est coupé entre deux blocs. */
export function createStripDefinerStream(): Transform {
  let carry = "";
  const keep = 200;
  const prefix = "DEFINER";
  const holdIndex = (text: string): number => {
    const marker = text.lastIndexOf(prefix);
    let idx = text.length;
    if (marker >= 0 && marker > text.length - keep) idx = marker;
    else if (text.length > keep) idx = text.length - keep;
    for (let n = prefix.length - 1; n >= 1; n--) {
      if (text.endsWith(prefix.slice(0, n)) && text.length - n < idx) {
        idx = text.length - n;
        break;
      }
    }
    return idx;
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = carry + chunk.toString();
      const cut = holdIndex(text);
      if (cut >= text.length) {
        carry = text;
        cb();
        return;
      }
      carry = text.slice(cut);
      cb(null, stripDefiners(text.slice(0, cut)));
    },
    flush(cb) {
      const rest = stripDefiners(carry);
      carry = "";
      cb(null, rest);
    },
  });
}
