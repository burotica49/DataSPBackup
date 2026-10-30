import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

process.loadEnvFile(new URL("./.env", import.meta.url));
const db = new Database("./data/dataspbackup.sqlite", { readonly: true });
const email = db.prepare("select email from users limit 1").get().email;
const password = process.env.ADMIN_PASSWORD ?? "";
const login = await fetch("http://127.0.0.1:5173/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) {
  console.log(JSON.stringify({ login: login.status }));
  process.exit(1);
}
const raw = login.headers.getSetCookie().find((c) => c.startsWith("dsb_session="));
const token = decodeURIComponent(raw.split(";")[0].slice("dsb_session=".length));
const backupId = db.prepare("select id from backups where status = 'success' order by id desc limit 1").get().id;

async function post(body) {
  const res = await fetch(`http://127.0.0.1:5173/api/backups/${backupId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `dsb_session=${encodeURIComponent(token)}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, error: typeof data.error === "string" ? data.error : "non-string" };
}
const base = { clean: false, wipeData: false, prepareSupabase: true };
const api = {
  badHost: await post({ ...base, mode: "new", connection: { host: "bad host", port: 5432, username: "postgres", password: "secret", dbName: "postgres", sslMode: "disable" } }),
  newline: await post({ ...base, mode: "new", connection: { host: "db.example.com", port: 5432, username: "postgres", password: "a\nb", dbName: "postgres", sslMode: "disable" } }),
  missing: await post({ ...base, mode: "new" }),
};
console.log(JSON.stringify({ api }));

const userData = await mkdtemp(join(tmpdir(), "dsb-ui-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new",
  "--remote-debugging-port=9333",
  `--user-data-dir=${userData}`,
  "--no-first-run",
  "--disable-gpu",
  "--window-size=1400,1000",
  "about:blank",
], { stdio: "ignore" });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let version;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch("http://127.0.0.1:9333/json/version");
    if (r.ok) { version = await r.json(); break; }
  } catch { /* retry */ }
  await sleep(100);
}
if (!version) throw new Error("chrome debug indisponible");
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(JSON.stringify(msg.error)));
  else resolve(msg.result);
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalPage(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "eval error");
  return result.result.value;
}

try {
  await send("Network.setCookie", {
    name: "dsb_session", value: token, url: "http://127.0.0.1:5173/", httpOnly: true,
  });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  const opened = await evalPage(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wait = async (sel, ms = 8000) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        const el = document.querySelector(sel);
        if (el) return el;
        await sleep(100);
      }
      throw new Error("missing " + sel + " :: " + document.body.innerText.slice(0, 200));
    };
    (await wait(".db-card")).click();
    await sleep(500);
    [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Sauvegardes")).click();
    await sleep(300);
    (await wait('button[title="Restaurer"]')).click();
    await sleep(200);
    const sel = document.querySelector(".restore-modal select");
    sel.value = "new";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(250);
    const modal = document.querySelector(".restore-modal");
    return {
      labels: [...modal.querySelectorAll(".conn-grid label")].map((l) => l.textContent),
      placeholders: [...modal.querySelectorAll("input")].map((i) => i.getAttribute("placeholder")),
      db: document.querySelector("#rconn-db")?.value ?? null,
      ssl: document.querySelector("#rconn-ssl")?.selectedOptions?.[0]?.textContent ?? null,
      clip: document.querySelector(".clip-fill")?.textContent?.trim() ?? null,
    };
  })()`);
  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  await writeFile("/tmp/restore-new.png", Buffer.from(shot1.data, "base64"));

  const filled = await evalPage(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (id, value) => {
      const el = document.querySelector(id);
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("#rconn-host", "db.exemple.supabase.co");
    set("#rconn-user", "postgres");
    set("#rconn-pw", "mot-de-passe-test");
    document.querySelector(".pw-eye").click();
    await sleep(100);
    const box = document.querySelector(".restore-modal input[type=checkbox]");
    const checks = [...document.querySelectorAll(".restore-modal input[type=checkbox]")];
    const confirm = checks[checks.length - 1];
    confirm.checked = true;
    confirm.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector(".restore-modal .btn.danger").click();
    await sleep(150);
    return {
      pwType: document.querySelector("#rconn-pw").type,
      error: document.querySelector(".restore-modal .err")?.textContent ?? null,
    };
  })()`);
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  await writeFile("/tmp/restore-filled.png", Buffer.from(shot2.data, "base64"));

  let clipboard = null;
  try {
    clipboard = await evalPage(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await navigator.clipboard.writeText("postgresql://postgres.ref:s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/app_db?sslmode=require");
      document.querySelector(".clip-fill").click();
      await sleep(400);
      return {
        host: document.querySelector("#rconn-host").value,
        port: document.querySelector("#rconn-port").value,
        user: document.querySelector("#rconn-user").value,
        db: document.querySelector("#rconn-db").value,
        ssl: document.querySelector("#rconn-ssl").value,
        pwLen: document.querySelector("#rconn-pw").value.length,
        toast: document.querySelector(".toast")?.innerText ?? null,
      };
    })()`);
  } catch (err) {
    clipboard = { error: String(err).slice(0, 180) };
  }
  console.log(JSON.stringify({ opened, filled, clipboard }));
} finally {
  chrome.kill("SIGKILL");
  ws.close();
  await rm(userData, { recursive: true, force: true }).catch(() => {});
}
