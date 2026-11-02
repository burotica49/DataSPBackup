<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import TagSelect from "../components/TagSelect.vue";
import BackupDetail from "./BackupDetailView.vue";
import VerificationDetail from "./VerificationView.vue";
import RestoreDetail from "./RestoreDetailView.vue";
import { api } from "../lib/api";
import { useToasts } from "../store/toasts";

const toasts = useToasts();
const route = useRoute();
const router = useRouter();

const TABS = ["config", "backups", "verifs", "availability", "restores"] as const;
type Tab = (typeof TABS)[number];

function queryValue(raw: unknown): string {
  return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
}
function queryDb(raw: unknown): number | null {
  const n = Number(queryValue(raw));
  return Number.isInteger(n) && n > 0 ? n : null;
}
function queryTab(raw: unknown): Tab {
  const v = queryValue(raw);
  return (TABS as readonly string[]).includes(v) ? (v as Tab) : "config";
}

const PLACE_KEY = "dataspbackup.place";
function readPlace(): { db: number | null; tab: Tab } {
  try {
    const raw = sessionStorage.getItem(PLACE_KEY);
    if (!raw) return { db: null, tab: "config" };
    const parsed = JSON.parse(raw) as { db?: unknown; tab?: unknown };
    return { db: queryDb(parsed.db), tab: queryTab(parsed.tab) };
  } catch {
    return { db: null, tab: "config" };
  }
}
const storedPlace = readPlace();

interface Db {
  id: number; name: string; engine: string; host: string; port: number; db_name: string;
  username: string; ssl_mode: string; is_supabase: number; pg_major: number | null;
  server_version: string | null;
  included_schemas: string[];
  excluded_tables: string[];
  excluded_table_data: string[];
  ignore_user_mappings: number;
  has_password: boolean;
  group_id: number | null;
  avail_enabled: number;
  avail_notify: number;
  avail_interval_min: number;
  avail_attempts: number;
  avail_history_days: number;
  avail_fail_streak: number;
  avail_down: number;
  avail_last_check_at: string | null;
}
interface Group { id: number; name: string; position: number }
interface Backup {
  id: number; database_id: number; status: string; trigger: string;
  size_bytes: number | null; pg_major: number | null; created_at: string;
  started_at: string | null; finished_at: string | null; encrypted: number; error: string | null;
}
interface Verif {
  id: number; backup_id: number; database_id: number; status: string; trigger: string;
  created_at: string; started_at: string | null; finished_at: string | null;
  root_error: string | null;
}
interface Restore {
  id: number; backup_id: number; mode: string; target_label: string; status: string;
  root_error: string | null; started_at: string | null; finished_at: string | null; created_at: string;
}
interface Policy {
  id: number; database_id: number; storage_id: number; schedule_cron: string;
  retention_count: number | null; retention_days: number | null;
  encrypt: number; verify_after: number; enabled: number;
  notify_success: number; notify_failure: number;
}
interface Store { id: number; name: string; type: string }
interface Channel { id: number; type: string; name: string; on_failure: number; on_success: number; on_start: number }

const dbs = ref<Db[]>([]);
const groups = ref<Group[]>([]);
const stores = ref<Store[]>([]);
const channels = ref<Channel[]>([]);
const allBackups = ref<Backup[]>([]);
const allVerifs = ref<Verif[]>([]);
const selectedId = ref<number | null>(queryDb(route.query.db) ?? storedPlace.db);
const showMobileList = ref(queryDb(route.query.db) == null && queryValue(route.query.detail) === "");
const tab = ref<Tab>(queryValue(route.query.tab) ? queryTab(route.query.tab) : storedPlace.tab);

const backups = ref<Backup[]>([]);
const verifs = ref<Verif[]>([]);
const restores = ref<Restore[]>([]);
const policy = ref<Policy | null>(null);

const selected = computed(() => dbs.value.find((d) => d.id === selectedId.value) ?? null);
const restoreSource = computed(() => {
  const backup = backups.value.find((b) => b.id === restoreBackupId.value);
  const id = backup?.database_id ?? selected.value?.id;
  return dbs.value.find((d) => d.id === id) ?? null;
});
const restoreCandidates = computed(() => {
  const engine = restoreSource.value?.engine || "postgres";
  return dbs.value.filter((d) => (d.engine || "postgres") === engine);
});
function engineLabel(d: { engine?: string; is_supabase: number }): string {
  if (d.engine === "mysql") return "MySQL";
  return d.is_supabase ? "Supabase" : "PostgreSQL";
}
function ouiNon(n: number | undefined): string { return n ? "Oui" : "Non"; }
function dbBadge(d: Db): { cls: string; label: string } {
  if (!d.avail_enabled) return { cls: "neutral", label: "Non suivi" };
  if (!d.avail_last_check_at) return { cls: "neutral", label: "En attente" };
  if (d.avail_down) return { cls: "failed", label: "Indisponible" };
  if (d.avail_fail_streak > 0) return { cls: "warn", label: "Échec" };
  return { cls: "available", label: "Disponible" };
}
function availTitle(d: Db): string {
  if (!d.avail_enabled) return "Suivi de disponibilité inactif";
  if (!d.avail_last_check_at) return "Aucune vérification de disponibilité pour l'instant";
  if (d.avail_down) return "La base ne répond pas";
  if (d.avail_fail_streak > 0) return `Échec de connexion ${d.avail_fail_streak}/${d.avail_attempts || 3}`;
  return `Disponible — dernier contrôle ${fmtAgo(d.avail_last_check_at)}`;
}
function jobAlerts(dbId: number): { key: string; label: string; title: string }[] {
  const out: { key: string; label: string; title: string }[] = [];
  const backup = allBackups.value.find((b) => b.database_id === dbId);
  if (backup?.status === "failed") {
    out.push({
      key: "backup",
      label: "Sauvegarde échouée",
      title: backup.error?.trim() || "La dernière sauvegarde a échoué",
    });
  }
  const verif = allVerifs.value.find((v) => v.database_id === dbId);
  if (verif?.status === "failed") {
    out.push({
      key: "verif",
      label: "Vérification échouée",
      title: verif.root_error?.trim() || "La dernière vérification a échoué",
    });
  }
  return out;
}

// ---- helpers ----
// created_at = "YYYY-MM-DD HH:MM:SS" (UTC, sans Z) → +Z ; started/finished = ISO (déjà Z)
function parse(d: string | null) { if (!d) return NaN; return Date.parse(/[TZ]/.test(d) ? d : d + "Z"); }
function fmtDate(d: string | null): string { const t = parse(d); return isNaN(t) ? "—" : new Date(t).toLocaleString(); }
function fmtAgo(d: string | null): string {
  const t = parse(d); if (isNaN(t)) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "il y a quelques secondes";
  const m = Math.floor(s / 60); if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}
function fmtDuration(a: string | null, b: string | null): string {
  const s = parse(a), e = parse(b); if (isNaN(s) || isNaN(e)) return "—";
  const d = Math.max(0, Math.round((e - s) / 1000));
  return d >= 60 ? `${Math.floor(d / 60)}m ${d % 60}s` : `${d}s`;
}
function fmtSize(n: number | null): string {
  if (!n) return "—";
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(2)} Mo` : `${(n / 1024).toFixed(0)} Ko`;
}
function lastBackup(dbId: number): Backup | undefined {
  return allBackups.value.filter((b) => b.database_id === dbId && b.status === "success")[0];
}
function verifFor(backupId: number): Verif | undefined {
  return verifs.value.find((v) => v.backup_id === backupId);
}
function statusLabel(s: string): string {
  return s === "success" ? "Réussie" : s === "failed" ? "Échouée" : s === "running" ? "En cours" : s === "pending" ? "En attente" : s === "canceled" ? "Annulée" : s;
}
const SSL_MODES = [
  { value: "disable", label: "Désactivé" },
  { value: "prefer", label: "Préféré" },
  { value: "require", label: "Requis" },
];
function sslLabel(v: string): string {
  return SSL_MODES.find((m) => m.value === v)?.label ?? v;
}
const TIP_TABLES = "La table est absente de la sauvegarde (schéma et données). Ex. public.logs ou audit.*";
const TIP_DATA = "La structure est sauvegardée, pas les lignes. Ex. public.history";
const TIP_MAPPINGS = "Les correspondances d'utilisateurs (USER MAPPING des serveurs distants) ne sont pas restaurées.";

// ---- groupes (dossiers) ----
const FOLDER_KEY = "dataspbackup.folders";
const openIds = ref<number[]>([]);
const knownFolderIds = ref<number[]>([]);
let folderStateLoaded = false;

function readFolders(): { open: number[]; known: number[] } | null {
  try {
    const raw = localStorage.getItem(FOLDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { open?: unknown; known?: unknown };
    const nums = (v: unknown) =>
      Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    return { open: nums(parsed.open), known: nums(parsed.known) };
  } catch {
    return null;
  }
}
function writeFolders() {
  localStorage.setItem(
    FOLDER_KEY,
    JSON.stringify({ open: openIds.value, known: knownFolderIds.value }),
  );
}
function syncFolders(list: Group[]) {
  const ids = list.map((g) => g.id);
  const idSet = new Set(ids);
  if (!folderStateLoaded) {
    folderStateLoaded = true;
    const saved = readFolders();
    if (!saved) {
      openIds.value = [...ids];
    } else {
      const known = new Set(saved.known);
      const open = new Set(saved.open);
      for (const id of ids) if (!known.has(id)) open.add(id);
      openIds.value = [...open].filter((id) => idSet.has(id));
    }
  } else {
    const known = new Set(knownFolderIds.value);
    const open = new Set(openIds.value);
    for (const id of ids) if (!known.has(id)) open.add(id);
    openIds.value = [...open].filter((id) => idSet.has(id));
  }
  knownFolderIds.value = ids;
  writeFolders();
}
function isOpen(id: number) { return openIds.value.includes(id); }
function toggleFolder(id: number) {
  openIds.value = isOpen(id)
    ? openIds.value.filter((x) => x !== id)
    : [...openIds.value, id];
  writeFolders();
}
function ensureOpen(id: number) {
  if (!isOpen(id)) toggleFolder(id);
}

const sortedGroups = computed(() =>
  [...groups.value].sort(
    (a, b) => (a.position - b.position) || a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
  ),
);
function dbsInGroup(id: number): Db[] {
  return dbs.value.filter((d) => d.group_id === id);
}
const ungrouped = computed(() => dbs.value.filter((d) => d.group_id == null));

const showNewGroup = ref(false);
const groupName = ref("");
const groupNameInput = ref<HTMLInputElement | null>(null);
const editingGroupId = ref<number | null>(null);
const editingGroupName = ref("");
const skipGroupBlur = ref(false);
const draggingId = ref<number | null>(null);
const draggingGroupId = ref<number | null>(null);
const groupInsert = ref<{ index: number; after: boolean } | null>(null);
const dropTarget = ref<number | "root" | null>(null);

const draggingFromGroup = computed(() => {
  const id = draggingId.value;
  if (id == null) return false;
  return dbs.value.find((d) => d.id === id)?.group_id != null;
});
function canDropOn(groupId: number | null): boolean {
  const id = draggingId.value;
  if (id == null) return false;
  const current = dbs.value.find((d) => d.id === id)?.group_id ?? null;
  return current !== groupId;
}

// ---- loading ----
async function loadAll() {
  [dbs.value, groups.value, stores.value, channels.value, allBackups.value, allVerifs.value] = await Promise.all([
    api.get<Db[]>("/api/databases"),
    api.get<Group[]>("/api/groups"),
    api.get<Store[]>("/api/storages"),
    api.get<Channel[]>("/api/notifications"),
    api.get<Backup[]>("/api/backups"),
    api.get<Verif[]>("/api/verifications"),
  ]);
  syncFolders(groups.value);
  const known = (id: number | null) => id != null && dbs.value.some((d) => d.id === id);
  const preferred = queryDb(route.query.db) ?? (known(pendingDb.value) ? pendingDb.value : selectedId.value);
  const next = known(preferred) ? preferred : (dbs.value[0]?.id ?? null);
  if (next === selectedId.value) {
    if (next != null) loadDetail(next);
    syncPlace();
  } else {
    selectedId.value = next;
  }
}
function syncPlace() {
  if (route.name !== "databases" || selectedId.value == null) return;
  const db = String(selectedId.value);
  const t = tab.value;
  sessionStorage.setItem(PLACE_KEY, JSON.stringify({ db: selectedId.value, tab: t }));
  const query: Record<string, string> = { db, tab: t };
  const detail = queryValue(route.query.detail);
  const detailId = queryValue(route.query.id);
  if (detail && detailId) {
    query.detail = detail;
    query.id = detailId;
  }
  if (
    queryValue(route.query.db) === db &&
    queryValue(route.query.tab) === t &&
    queryValue(route.query.detail) === (query.detail ?? "") &&
    queryValue(route.query.id) === (query.id ?? "")
  ) return;
  router.replace({ name: "databases", query });
}
watch([selectedId, tab], syncPlace);
watch(() => route.fullPath, () => { if (route.name === "databases") syncPlace(); });
watch(() => route.query.detail, (d) => { if (queryValue(d)) showMobileList.value = false; });

type DetailKind = "backup" | "verification" | "restore";
const detail = computed(() => {
  const kind = queryValue(route.query.detail);
  const id = queryDb(route.query.id);
  if ((kind === "backup" || kind === "verification" || kind === "restore") && id) {
    return { kind: kind as DetailKind, id };
  }
  return null;
});
function openDetail(kind: DetailKind, id: number) {
  const query: Record<string, string> = { tab: tab.value, detail: kind, id: String(id) };
  if (selectedId.value != null) query.db = String(selectedId.value);
  router.push({ name: "databases", query });
}
function closeDetail() {
  const back = window.history.state?.back;
  if (typeof back === "string" && (back === "/" || back.startsWith("/?"))) {
    router.back();
    return;
  }
  const query: Record<string, string> = { tab: tab.value };
  if (selectedId.value != null) query.db = String(selectedId.value);
  router.replace({ name: "databases", query });
}
const pendingDb = ref<number | null>(null);
function onFocusDb(id: number) {
  pendingDb.value = id;
  if (dbs.value.some((d) => d.id === id) && selectedId.value !== id) selectedId.value = id;
  else if (selectedId.value === id) syncPlace();
}
function onDetailKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !detail.value || showRestore.value || confirmState.value.show) return;
  if (document.querySelectorAll(".modal-overlay").length > 1) return;
  closeDetail();
}
function applyDetail(id: number, bs: Backup[], vs: Verif[], ps: Policy[], rs: Restore[]) {
  backups.value = bs;
  verifs.value = vs;
  policy.value = ps.find((p) => p.database_id === id) ?? null;
  const ids = new Set(bs.map((b) => b.id));
  restores.value = rs.filter((r) => ids.has(r.backup_id));
  const others = allBackups.value.filter((b) => b.database_id !== id);
  allBackups.value = [...bs, ...others].sort((a, b) => parse(b.created_at) - parse(a.created_at));
  const otherVerifs = allVerifs.value.filter((v) => v.database_id !== id);
  allVerifs.value = [...vs, ...otherVerifs].sort((a, b) => parse(b.created_at) - parse(a.created_at));
}

const ACTIVE = new Set(["pending", "running"]);
let detailSeq = 0;
let refreshTimer: number | undefined;

function jobsInProgress(): boolean {
  if (backups.value.some((b) => ACTIVE.has(b.status))) return true;
  if (verifs.value.some((v) => ACTIVE.has(v.status))) return true;
  if (restores.value.some((r) => ACTIVE.has(r.status))) return true;
  // La vérification automatique démarre juste après la sauvegarde.
  if (policy.value?.verify_after === 1) {
    const latest = backups.value[0];
    if (latest?.status === "success" && latest.finished_at) {
      const age = Date.now() - parse(latest.finished_at);
      const hasVerif = verifs.value.some((v) => v.backup_id === latest.id);
      if (age >= 0 && age < 20_000 && !hasVerif) return true;
    }
  }
  return false;
}
function armRefresh() {
  window.clearTimeout(refreshTimer);
  if (!jobsInProgress() || selectedId.value == null) return;
  const id = selectedId.value;
  refreshTimer = window.setTimeout(() => { void loadDetail(id); }, 2000);
}
async function loadDetail(id: number) {
  const gen = ++detailSeq;
  try {
    const [bs, vs, ps, rs] = await Promise.all([
      api.get<Backup[]>(`/api/backups?database_id=${id}`),
      api.get<Verif[]>(`/api/verifications?database_id=${id}`),
      api.get<Policy[]>("/api/policies"),
      api.get<Restore[]>("/api/restores"),
    ]);
    if (gen !== detailSeq) return;
    applyDetail(id, bs, vs, ps, rs);
  } catch {
    /* nouvel essai au prochain tick si une tâche est encore affichée en cours */
  }
  if (gen === detailSeq) armRefresh();
}
const editAvail = ref(false);
function resetEdits() { editName.value = false; editParams.value = false; editVerif.value = false; editPolicy.value = false; editAvail.value = false; }
watch(selectedId, (id) => { if (id != null) { showAdd.value = false; resetEdits(); loadDetail(id); } });

function select(id: number) {
  selectedId.value = id;
  showMobileList.value = false;
  tab.value = "config";
  const gid = dbs.value.find((d) => d.id === id)?.group_id;
  if (gid != null) ensureOpen(gid);
}

// ---- actions ----
async function test() {
  if (!selected.value) return;
  toasts.info("Test de connexion…");
  try {
    const r = await api.post<{ pg_major?: number; server_version?: string; engine?: string }>(`/api/databases/${selected.value.id}/test`);
    if (r.engine === "mysql") toasts.success(`Connexion OK — MySQL ${r.server_version}`);
    else toasts.success(`Connexion OK — PostgreSQL ${r.pg_major}`);
    await loadAll();
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
async function runBackup() {
  if (!selected.value) return;
  try {
    await api.post("/api/backups/run", { database_id: selected.value.id, encrypt: true, verify_after: true });
    toasts.info(`Sauvegarde lancée — ${selected.value.name}`);
    await loadDetail(selected.value.id);
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
async function verify(backupId: number) {
  await api.post(`/api/backups/${backupId}/verify`);
  toasts.info("Vérification lancée");
  if (selected.value) await loadDetail(selected.value.id);
}
function removeDb() {
  if (!selected.value) return;
  const d = selected.value;
  askConfirm(`Supprimer la base « ${d.name} » ?`, async () => {
    try {
      await api.del(`/api/databases/${d.id}`);
      toasts.success("Base supprimée");
      selectedId.value = null;
      await loadAll();
      if (dbs.value[0]) selectedId.value = dbs.value[0].id;
    } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
  });
}

// ---- confirmation intégrée (window.confirm est bloqué dans certains navigateurs) ----
const confirmState = ref<{ show: boolean; message: string; onYes: () => Promise<void> | void }>({
  show: false, message: "", onYes: () => {},
});
function askConfirm(message: string, onYes: () => Promise<void> | void) {
  confirmState.value = { show: true, message, onYes };
}
async function doConfirm() {
  const fn = confirmState.value.onYes;
  confirmState.value.show = false;
  await fn();
}

function openNewGroup() {
  showNewGroup.value = true;
  groupName.value = "";
  nextTick(() => groupNameInput.value?.focus());
}
async function createGroup() {
  const name = groupName.value.trim();
  if (!name) return;
  try {
    const created = await api.post<Group>("/api/groups", { name });
    groups.value = [...groups.value, created];
    knownFolderIds.value = [...knownFolderIds.value, created.id];
    ensureOpen(created.id);
    showNewGroup.value = false;
    groupName.value = "";
    toasts.success("Groupe créé");
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
function startRenameGroup(g: Group) {
  editingGroupId.value = g.id;
  editingGroupName.value = g.name;
  nextTick(() => {
    const el = document.getElementById(`group-rename-${g.id}`) as HTMLInputElement | null;
    el?.focus();
    el?.select();
  });
}
function cancelRenameGroup() {
  skipGroupBlur.value = true;
  editingGroupId.value = null;
}
async function saveGroupRename(g: Group) {
  if (skipGroupBlur.value) { skipGroupBlur.value = false; return; }
  if (editingGroupId.value !== g.id) return;
  const name = editingGroupName.value.trim();
  editingGroupId.value = null;
  if (!name || name === g.name) return;
  try {
    const updated = await api.patch<Group>(`/api/groups/${g.id}`, { name });
    const i = groups.value.findIndex((x) => x.id === g.id);
    if (i >= 0) groups.value[i] = updated;
    toasts.success("Groupe renommé");
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
function removeGroup(g: Group) {
  askConfirm(`Supprimer le groupe « ${g.name} » ? Les bases restent dans la liste.`, async () => {
    try {
      await api.del(`/api/groups/${g.id}`);
      groups.value = groups.value.filter((x) => x.id !== g.id);
      for (const d of dbs.value) if (d.group_id === g.id) d.group_id = null;
      openIds.value = openIds.value.filter((id) => id !== g.id);
      knownFolderIds.value = knownFolderIds.value.filter((id) => id !== g.id);
      writeFolders();
      toasts.success("Groupe supprimé");
    } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
  });
}
async function moveDb(id: number, groupId: number | null) {
  const d = dbs.value.find((x) => x.id === id);
  if (!d || (d.group_id ?? null) === groupId) return;
  try {
    await api.patch(`/api/databases/${id}`, { group_id: groupId });
    d.group_id = groupId;
    if (groupId != null) ensureOpen(groupId);
    toasts.success(groupId == null ? "Base retirée du groupe" : "Base déplacée");
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
function onGroupSelect(e: Event) {
  if (!selected.value) return;
  const raw = (e.target as HTMLSelectElement).value;
  void moveDb(selected.value.id, raw === "" ? null : Number(raw));
}
function onDragStart(e: DragEvent, id: number) {
  draggingId.value = id;
  e.dataTransfer?.setData("text/plain", String(id));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragEnd() {
  draggingId.value = null;
  draggingGroupId.value = null;
  groupInsert.value = null;
  dropTarget.value = null;
}
function onDrop(groupId: number | null) {
  if (draggingGroupId.value != null) return;
  const id = draggingId.value;
  draggingId.value = null;
  dropTarget.value = null;
  if (id == null) return;
  void moveDb(id, groupId);
}
function onGroupDragStart(e: DragEvent, id: number) {
  draggingGroupId.value = id;
  draggingId.value = null;
  e.dataTransfer?.setData("application/x-datasp-group", String(id));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onFolderDragOver(e: DragEvent, index: number) {
  if (draggingGroupId.value == null) {
    dropTarget.value = sortedGroups.value[index]?.id ?? null;
    groupInsert.value = null;
    return;
  }
  const el = e.currentTarget as HTMLElement;
  const after = e.clientY > el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
  groupInsert.value = { index, after };
  dropTarget.value = null;
}
function onRootDragOver() {
  if (draggingGroupId.value != null) {
    const last = sortedGroups.value.length - 1;
    groupInsert.value = last >= 0 ? { index: last, after: true } : null;
    dropTarget.value = null;
    return;
  }
  dropTarget.value = "root";
}
async function reorderGroup(id: number, toIndex: number) {
  const list = [...sortedGroups.value];
  const from = list.findIndex((g) => g.id === id);
  if (from < 0) return;
  const insertAt = from < toIndex ? toIndex - 1 : toIndex;
  if (insertAt === from) return;
  const [item] = list.splice(from, 1);
  list.splice(insertAt, 0, item!);
  const previous = groups.value;
  groups.value = list.map((g, index) => ({ ...g, position: index }));
  try {
    groups.value = await api.put<Group[]>("/api/groups/order", { ids: list.map((g) => g.id) });
  } catch (e) {
    groups.value = previous;
    toasts.error("Échec : " + (e as { message?: string }).message);
  }
}
function onFolderDrop(e: DragEvent, groupId: number, index: number) {
  if (draggingGroupId.value != null) {
    e.stopPropagation();
    const id = draggingGroupId.value;
    const insert = groupInsert.value;
    const toIndex = insert && insert.index === index ? (insert.after ? index + 1 : index) : index;
    draggingGroupId.value = null;
    groupInsert.value = null;
    void reorderGroup(id, toIndex);
    return;
  }
  onDrop(groupId);
}
function onRootDrop() {
  if (draggingGroupId.value != null) {
    const id = draggingGroupId.value;
    draggingGroupId.value = null;
    groupInsert.value = null;
    void reorderGroup(id, sortedGroups.value.length);
    return;
  }
  onDrop(null);
}

// ---- add database ----
const showAdd = ref(false);
const blank = () => ({
  name: "", engine: "postgres" as "postgres" | "mysql",
  host: "", port: 5432, db_name: "postgres", username: "postgres",
  password: "", ssl_mode: "prefer", is_supabase: true,
  included_schemas: ["public", "auth", "storage"],
  excluded_tables: [] as string[],
  excluded_table_data: [] as string[],
  ignore_user_mappings: false,
  group_id: null as number | null,
});
const form = ref(blank());
function openAdd() { showAdd.value = true; resetEdits(); form.value = blank(); selectedId.value = null; showMobileList.value = false; }
function backToList() { showAdd.value = false; showMobileList.value = true; }
function onEngineChange() {
  if (form.value.engine === "mysql") {
    if (form.value.port === 5432) form.value.port = 3306;
    if (form.value.db_name === "postgres") form.value.db_name = "";
    if (form.value.username === "postgres") form.value.username = "root";
    form.value.is_supabase = false;
    form.value.included_schemas = [];
    form.value.ignore_user_mappings = false;
  } else {
    if (form.value.port === 3306) form.value.port = 5432;
    if (!form.value.db_name) form.value.db_name = "postgres";
    if (form.value.username === "root") form.value.username = "postgres";
    form.value.is_supabase = true;
    form.value.included_schemas = ["public", "auth", "storage"];
  }
}
async function createDb() {
  const gid = form.value.group_id;
  const payload = {
    ...form.value,
    port: Number(form.value.port),
    group_id: gid == null ? null : Number(gid),
  };
  try {
    const created = await api.post<Db>("/api/databases", payload);
    showAdd.value = false;
    await loadAll();
    selectedId.value = created.id;
    toasts.success("Base enregistrée");
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

// ---- renommer (crayon du titre) ----
const editName = ref(false);
const nameEdit = ref("");
function openRename() { if (!selected.value) return; nameEdit.value = selected.value.name; editName.value = true; }
async function saveName() {
  if (!selected.value || !nameEdit.value.trim()) return;
  try {
    await api.patch(`/api/databases/${selected.value.id}`, { name: nameEdit.value.trim() });
    editName.value = false;
    toasts.success("Base renommée");
    await loadAll();
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

// ---- édition des paramètres de connexion ----
const editParams = ref(false);
const paramsForm = ref({
  host: "", port: 5432, db_name: "", username: "", password: "", ssl_mode: "prefer",
  included_schemas: [] as string[], excluded_tables: [] as string[],
  excluded_table_data: [] as string[], ignore_user_mappings: false,
});
function openParams() {
  const d = selected.value; if (!d) return;
  paramsForm.value = {
    host: d.host, port: d.port, db_name: d.db_name, username: d.username,
    password: "", ssl_mode: d.ssl_mode,
    included_schemas: [...(d.included_schemas ?? [])],
    excluded_tables: [...(d.excluded_tables ?? [])],
    excluded_table_data: [...(d.excluded_table_data ?? [])],
    ignore_user_mappings: d.ignore_user_mappings === 1,
  };
  editParams.value = true;
}
async function saveParams() {
  if (!selected.value) return;
  const body: Record<string, unknown> = {
    host: paramsForm.value.host, port: Number(paramsForm.value.port), db_name: paramsForm.value.db_name,
    username: paramsForm.value.username, ssl_mode: paramsForm.value.ssl_mode,
    included_schemas: paramsForm.value.included_schemas,
    excluded_tables: paramsForm.value.excluded_tables,
    excluded_table_data: paramsForm.value.excluded_table_data,
    ignore_user_mappings: paramsForm.value.ignore_user_mappings,
  };
  if (paramsForm.value.password) body.password = paramsForm.value.password;
  try {
    await api.patch(`/api/databases/${selected.value.id}`, body);
    editParams.value = false;
    toasts.success("Paramètres enregistrés");
    await loadAll();
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

// ---- édition de la vérification de restauration ----
const editVerif = ref(false);
const verifForm = ref({ is_supabase: true, verify_after: true });
function openVerif() {
  const d = selected.value; if (!d) return;
  verifForm.value = { is_supabase: d.is_supabase === 1, verify_after: policy.value ? policy.value.verify_after === 1 : true };
  editVerif.value = true;
}
async function saveVerif() {
  if (!selected.value) return;
  try {
    if (selected.value.engine !== "mysql") {
      await api.patch(`/api/databases/${selected.value.id}`, { is_supabase: verifForm.value.is_supabase });
    }
    if (policy.value) await api.patch(`/api/policies/${policy.value.id}`, { verify_after: verifForm.value.verify_after });
    editVerif.value = false;
    toasts.success("Vérification enregistrée");
    await loadAll();
    await loadDetail(selected.value.id);
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

// ---- vérification de disponibilité ----
const availForm = ref({ enabled: false, notify: true, interval_min: 1, attempts: 3, history_days: 7 });
const availPeriod = ref<"today" | "24h" | "7d">("today");
const availChecks = ref<AvailCheck[]>([]);
const availBusy = ref(false);
let availTimer = 0;
let availSeq = 0;
interface AvailCheck {
  id: number; ok: number; latency_ms: number | null; error: string | null; checked_at: string;
}
interface AvailPayload {
  down: boolean; fail_streak: number; last_check_at: string | null; checks: AvailCheck[];
}
function sinceFor(period: "today" | "24h" | "7d"): string {
  const now = new Date();
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  const ms = period === "24h" ? 86_400_000 : 7 * 86_400_000;
  return new Date(now.getTime() - ms).toISOString();
}
function applyAvail(id: number, data: AvailPayload) {
  const d = dbs.value.find((x) => x.id === id);
  if (!d) return;
  d.avail_down = data.down ? 1 : 0;
  d.avail_fail_streak = data.fail_streak;
  d.avail_last_check_at = data.last_check_at;
}
async function loadAvailability() {
  const id = selectedId.value;
  if (id == null || tab.value !== "availability") return;
  const gen = ++availSeq;
  try {
    const data = await api.get<AvailPayload>(
      `/api/databases/${id}/availability?since=${encodeURIComponent(sinceFor(availPeriod.value))}`,
    );
    if (gen !== availSeq || selectedId.value !== id) return;
    availChecks.value = data.checks;
    applyAvail(id, data);
  } catch { /* le prochain rafraîchissement réessaie */ }
}
function stopAvailPoll() { window.clearInterval(availTimer); availTimer = 0; }
watch([tab, selectedId, availPeriod], () => {
  stopAvailPoll();
  if (tab.value !== "availability" || selectedId.value == null) {
    if (tab.value !== "availability") availChecks.value = [];
    return;
  }
  void loadAvailability();
  availTimer = window.setInterval(() => { void loadAvailability(); }, 15_000);
}, { immediate: true });
function openAvail() {
  const d = selected.value; if (!d) return;
  availForm.value = {
    enabled: d.avail_enabled === 1,
    notify: d.avail_notify === 1,
    interval_min: d.avail_interval_min || 1,
    attempts: d.avail_attempts || 3,
    history_days: d.avail_history_days || 7,
  };
  editAvail.value = true;
}
function clampInt(n: number, min: number, max: number): number | null {
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  return v >= min && v <= max ? v : null;
}
async function saveAvail() {
  if (!selected.value) return;
  const interval = clampInt(availForm.value.interval_min, 1, 1440);
  const attempts = clampInt(availForm.value.attempts, 1, 30);
  const history = clampInt(availForm.value.history_days, 1, 365);
  if (interval == null || attempts == null || history == null) {
    toasts.error("Intervalle (1–1440 min), tentatives (1–30) ou historique (1–365 jours) invalide");
    return;
  }
  try {
    await api.patch(`/api/databases/${selected.value.id}`, {
      avail_enabled: availForm.value.enabled,
      avail_notify: availForm.value.notify,
      avail_interval_min: interval,
      avail_attempts: attempts,
      avail_history_days: history,
    });
    editAvail.value = false;
    toasts.success("Disponibilité enregistrée");
    await loadAll();
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
async function checkNow() {
  if (!selected.value || availBusy.value) return;
  availBusy.value = true;
  try {
    const data = await api.post<AvailPayload & { check: AvailCheck }>(
      `/api/databases/${selected.value.id}/availability/check`,
    );
    applyAvail(selected.value.id, data);
    await loadAvailability();
    if (data.check.ok) toasts.success("Base disponible");
    else toasts.error(data.down ? "Base indisponible" : "La base n'a pas répondu");
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
  finally { availBusy.value = false; }
}
function cellTitle(c: AvailCheck): string {
  const state = c.ok ? "Disponible" : `Échec${c.error ? " : " + c.error : ""}`;
  const ms = c.latency_ms != null ? ` · ${c.latency_ms} ms` : "";
  return `${fmtDate(c.checked_at)} — ${state}${ms}`;
}
const availStatusLabel = computed(() => {
  const d = selected.value;
  if (!d?.avail_enabled) return "Surveillance inactive";
  if (!d.avail_last_check_at) return "En attente de la première vérification";
  if (d.avail_down) return "Indisponible";
  if (d.avail_fail_streak > 0) return `Échec ${d.avail_fail_streak}/${d.avail_attempts || 3}`;
  return "Disponible";
});
const lastAvailError = computed(() => {
  for (let i = availChecks.value.length - 1; i >= 0; i--) {
    const c = availChecks.value[i];
    if (c && c.ok !== 1 && c.error) return c.error;
  }
  return "";
});

// ---- configuration des sauvegardes (politique, façon Databasus) ----
const editPolicy = ref(false);
type Interval = "hourly" | "daily" | "weekly" | "monthly" | "custom";
const WEEKDAYS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const RETENTION_DAYS = [
  { label: "1 semaine", value: 7 }, { label: "2 semaines", value: 14 },
  { label: "1 mois", value: 30 }, { label: "3 mois", value: 90 },
  { label: "6 mois", value: 180 }, { label: "1 an", value: 365 },
];
const RETENTION_COUNTS = [3, 5, 7, 14, 30, 60];
const cform = ref({
  enabled: true, interval: "daily" as Interval, time: "01:00", weekday: 1, monthday: 1,
  customCron: "0 2 * * *", storage_id: 0, encrypt: true,
  retentionType: "days" as "days" | "count" | "unlimited", retentionDays: 7, retentionCount: 7,
  notify_success: false, notify_failure: true, showAdvanced: false,
});

function cronFromForm(): string {
  const [h, m] = cform.value.time.split(":").map((n) => Number(n) || 0);
  switch (cform.value.interval) {
    case "hourly": return "0 * * * *";
    case "daily": return `${m} ${h} * * *`;
    case "weekly": return `${m} ${h} * * ${cform.value.weekday}`;
    case "monthly": return `${m} ${h} ${cform.value.monthday} * *`;
    default: return cform.value.customCron;
  }
}
function parseCronToForm(cron: string) {
  const p = cron.trim().split(/\s+/);
  cform.value.customCron = cron;
  if (p.length !== 5) { cform.value.interval = "custom"; return; }
  const [m, h, dom, , dow] = p;
  const pad = (n: string) => String(n).padStart(2, "0");
  if (cron === "0 * * * *") { cform.value.interval = "hourly"; return; }
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    if (dom === "*" && dow === "*") { cform.value.interval = "daily"; cform.value.time = `${pad(h)}:${pad(m)}`; return; }
    if (dom === "*" && /^\d+$/.test(dow)) { cform.value.interval = "weekly"; cform.value.weekday = Number(dow); cform.value.time = `${pad(h)}:${pad(m)}`; return; }
    if (/^\d+$/.test(dom) && dow === "*") { cform.value.interval = "monthly"; cform.value.monthday = Number(dom); cform.value.time = `${pad(h)}:${pad(m)}`; return; }
  }
  cform.value.interval = "custom";
}
function openPolicy() {
  editPolicy.value = true;
  cform.value.storage_id = stores.value[0]?.id ?? 0;
  if (policy.value) {
    const pol = policy.value;
    parseCronToForm(pol.schedule_cron);
    cform.value.enabled = pol.enabled === 1;
    cform.value.encrypt = pol.encrypt === 1;
    cform.value.storage_id = pol.storage_id;
    cform.value.notify_success = pol.notify_success === 1;
    cform.value.notify_failure = pol.notify_failure === 1;
    if (pol.retention_days != null) { cform.value.retentionType = "days"; cform.value.retentionDays = pol.retention_days; }
    else if (pol.retention_count != null) { cform.value.retentionType = "count"; cform.value.retentionCount = pol.retention_count; }
    else cform.value.retentionType = "unlimited";
  }
}
async function savePolicy() {
  if (!selected.value) return;
  const body: Record<string, unknown> = {
    schedule_cron: cronFromForm(),
    storage_id: Number(cform.value.storage_id),
    encrypt: cform.value.encrypt,
    enabled: cform.value.enabled,
    notify_success: cform.value.notify_success,
    notify_failure: cform.value.notify_failure,
    retention_days: cform.value.retentionType === "days" ? Number(cform.value.retentionDays) : null,
    retention_count: cform.value.retentionType === "count" ? Number(cform.value.retentionCount) : null,
  };
  try {
    if (policy.value) await api.patch(`/api/policies/${policy.value.id}`, body);
    else await api.post("/api/policies", { database_id: selected.value.id, ...body });
    editPolicy.value = false;
    toasts.success("Configuration enregistrée");
    await loadDetail(selected.value.id);
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

// ---- actions sauvegardes ----
function deleteBackup(id: number) {
  askConfirm("Supprimer cette sauvegarde et ses vérifications ?", async () => {
    try {
      await api.del(`/api/backups/${id}`);
      toasts.success("Sauvegarde supprimée");
      if (selected.value) await loadDetail(selected.value.id);
      await loadAll();
    } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
  });
}

// ---- restauration ----
const showRestore = ref(false);
const restoreBackupId = ref<number | null>(null);
const rform = ref({
  mode: "existing" as "existing" | "new", targetDatabaseId: 0,
  clean: false, wipeData: false, prepareSupabase: true, confirm: false,
});
interface ConnDraft {
  host: string; port: string; username: string; password: string; dbName: string; sslMode: string;
}
function emptyConn(): ConnDraft {
  return { host: "", port: "", username: "", password: "", dbName: "postgres", sslMode: "disable" };
}
const rconn = ref<ConnDraft>(emptyConn());
const showConnPw = ref(false);
const connErrorMsg = ref("");

const SSL_FROM_CLIP: Record<string, string> = {
  disable: "disable", allow: "prefer", prefer: "prefer",
  require: "require", "verify-ca": "require", "verify-full": "require",
};
function decUri(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
function parsePgClipboard(raw: string): Partial<ConnDraft> | null {
  const text = raw.trim();
  if (!text) return null;
  const uriMatch = text.match(/postgres(?:ql)?:\/\/\S+/i);
  if (uriMatch) {
    try {
      const u = new URL(uriMatch[0].replace(/^postgres(?:ql)?:\/\//i, "http://"));
      const db = decUri(u.pathname.replace(/^\//, "").split("/")[0] || "");
      const ssl = SSL_FROM_CLIP[(u.searchParams.get("sslmode") ?? "").toLowerCase()];
      if (u.hostname) {
        return {
          host: u.hostname,
          port: u.port || "5432",
          ...(u.username ? { username: decUri(u.username) } : {}),
          ...(u.password ? { password: decUri(u.password) } : {}),
          ...(db ? { dbName: db } : {}),
          ...(ssl ? { sslMode: ssl } : {}),
        };
      }
    } catch { /* essai au format mot-clé */ }
  }
  const map: Record<string, string> = {};
  const re = /\b(host|port|user|username|password|dbname|database|sslmode)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) map[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  if (!map.host && !map.user && !map.username) return null;
  const ssl = SSL_FROM_CLIP[(map.sslmode ?? "").toLowerCase()];
  return {
    ...(map.host ? { host: map.host } : {}),
    ...(map.port ? { port: map.port } : {}),
    ...((map.user || map.username) ? { username: map.user || map.username } : {}),
    ...(map.password ? { password: map.password } : {}),
    ...((map.dbname || map.database) ? { dbName: map.dbname || map.database } : {}),
    ...(ssl ? { sslMode: ssl } : {}),
  };
}
function parseMysqlClipboard(raw: string): Partial<ConnDraft> | null {
  const uriMatch = raw.trim().match(/mysql:\/\/\S+/i);
  if (!uriMatch) return null;
  try {
    const u = new URL(uriMatch[0].replace(/^mysql:\/\//i, "http://"));
    const db = decUri(u.pathname.replace(/^\//, "").split("/")[0] || "");
    if (!u.hostname) return null;
    return {
      host: u.hostname,
      port: u.port || "3306",
      ...(u.username ? { username: decUri(u.username) } : {}),
      ...(u.password ? { password: decUri(u.password) } : {}),
      ...(db ? { dbName: db } : {}),
    };
  } catch {
    return null;
  }
}
async function fillConnFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const parsed = parsePgClipboard(text) ?? parseMysqlClipboard(text);
    if (!parsed) {
      toasts.error("Presse-papiers : chaîne de connexion non reconnue");
      return;
    }
    rconn.value = { ...rconn.value, ...parsed };
    showConnPw.value = false;
    toasts.success("Connexion renseignée");
  } catch {
    toasts.error("Impossible de lire le presse-papiers");
  }
}
function connProblem(): string | null {
  const c = rconn.value;
  if (!c.host.trim()) return "Hôte requis";
  const port = Number(c.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port invalide";
  if (!c.username.trim()) return "Nom d'utilisateur requis";
  if (!/^[a-zA-Z0-9_]+$/.test(c.dbName)) return "Nom de base invalide (a-z, 0-9, _)";
  return null;
}
function targetIsSupabase(id: number): boolean {
  return dbs.value.find((d) => d.id === Number(id))?.is_supabase === 1;
}
function onRestoreTarget() {
  if (targetIsSupabase(rform.value.targetDatabaseId)) {
    rform.value.wipeData = true;
    rform.value.clean = false;
  } else rform.value.wipeData = false;
}
function onWipeData() {
  if (rform.value.wipeData) rform.value.clean = false;
}
function onClean() {
  if (rform.value.clean) rform.value.wipeData = false;
}
function openRestore(id: number) {
  restoreBackupId.value = id;
  const backup = backups.value.find((b) => b.id === id);
  const source = dbs.value.find((d) => d.id === (backup?.database_id ?? selected.value?.id));
  const engine = source?.engine || "postgres";
  const candidates = dbs.value.filter((d) => (d.engine || "postgres") === engine);
  const first = candidates[0]?.id ?? 0;
  const supabase = engine !== "mysql" && targetIsSupabase(first);
  rform.value = {
    mode: "existing", targetDatabaseId: first,
    clean: false, wipeData: supabase, prepareSupabase: engine !== "mysql", confirm: false,
  };
  rconn.value = emptyConn();
  if (engine === "mysql") {
    rconn.value.port = "3306";
    rconn.value.dbName = "";
  }
  showConnPw.value = false;
  connErrorMsg.value = "";
  showRestore.value = true;
}
async function launchRestore() {
  if (!restoreBackupId.value || !rform.value.confirm) return;
  const body: Record<string, unknown> = {
    mode: rform.value.mode,
    clean: rform.value.clean,
    wipeData: rform.value.mode === "existing" && rform.value.wipeData,
    prepareSupabase: rform.value.prepareSupabase,
  };
  if (rform.value.mode === "existing") body.targetDatabaseId = Number(rform.value.targetDatabaseId);
  else {
    const problem = connProblem();
    if (problem) { connErrorMsg.value = problem; toasts.error(problem); return; }
    connErrorMsg.value = "";
    const c = rconn.value;
    body.connection = {
      host: c.host.trim(),
      port: Number(c.port),
      username: c.username.trim(),
      password: c.password,
      dbName: c.dbName.trim(),
      sslMode: c.sslMode,
    };
  }
  try {
    const res = await api.post<{ restore_id: number }>(`/api/backups/${restoreBackupId.value}/restore`, body);
    showRestore.value = false;
    tab.value = "restores";
    if (selected.value) await loadDetail(selected.value.id);
    toasts.info("Restauration lancée", { to: `/?detail=restore&id=${res.restore_id}`, label: "Suivre" });
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

onMounted(() => { loadAll(); window.addEventListener("keydown", onDetailKey); });
onUnmounted(() => {
  window.removeEventListener("keydown", onDetailKey);
  window.clearTimeout(refreshTimer);
  stopAvailPoll();
  detailSeq += 1;
});
</script>

<template>
  <div class="master-detail" :class="showMobileList ? 'mobile-list' : 'mobile-detail'">
    <!-- ---------- Liste des bases ---------- -->
    <aside class="list-panel">
      <div v-if="showNewGroup" class="new-group">
        <input
          ref="groupNameInput"
          v-model="groupName"
          placeholder="Nom du groupe"
          @keydown.enter.prevent="createGroup"
          @keydown.escape.prevent="showNewGroup = false"
        />
        <button class="btn" :disabled="!groupName.trim()" @click="createGroup">Créer</button>
        <button class="btn secondary" @click="showNewGroup = false">Annuler</button>
      </div>
      <button v-else class="btn secondary list-top-action" @click="openNewGroup">Nouveau groupe</button>

      <div
        v-for="(g, index) in sortedGroups"
        :key="g.id"
        class="folder"
        :class="{
          'drop-over': dropTarget === g.id && canDropOn(g.id) && draggingGroupId == null,
          'is-dragging': draggingGroupId === g.id,
          'reorder-before': groupInsert?.index === index && !groupInsert.after && draggingGroupId !== g.id,
          'reorder-after': groupInsert?.index === index && groupInsert.after && draggingGroupId !== g.id,
        }"
        @dragover.prevent="onFolderDragOver($event, index)"
        @drop.prevent="onFolderDrop($event, g.id, index)"
      >
        <div class="folder-head" @click="toggleFolder(g.id)">
          <span
            class="folder-grip"
            draggable="true"
            title="Déplacer le groupe"
            role="button"
            aria-label="Déplacer le groupe"
            @click.stop
            @dragstart.stop="onGroupDragStart($event, g.id)"
            @dragend="onDragEnd"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="1.3" /><circle cx="15" cy="7" r="1.3" /><circle cx="9" cy="12" r="1.3" /><circle cx="15" cy="12" r="1.3" /><circle cx="9" cy="17" r="1.3" /><circle cx="15" cy="17" r="1.3" /></svg>
          </span>
          <svg class="chevron" :class="{ open: isOpen(g.id) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6" /></svg>
          <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
          <input
            v-if="editingGroupId === g.id"
            :id="`group-rename-${g.id}`"
            v-model="editingGroupName"
            class="folder-rename"
            @click.stop
            @keydown.enter.prevent="saveGroupRename(g)"
            @keydown.escape.prevent="cancelRenameGroup"
            @blur="saveGroupRename(g)"
          />
          <span v-else class="folder-name">{{ g.name }}</span>
          <span class="folder-count">{{ dbsInGroup(g.id).length }}</span>
          <span class="folder-actions" @click.stop>
            <button class="icon-btn" title="Renommer" @click="startRenameGroup(g)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </button>
            <button class="icon-btn danger" title="Supprimer le groupe" @click="removeGroup(g)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
            </button>
          </span>
        </div>
        <div v-show="isOpen(g.id)" class="folder-body">
          <div
            v-for="d in dbsInGroup(g.id)"
            :key="d.id"
            class="db-card"
            :class="{ active: d.id === selectedId }"
            draggable="true"
            @click="select(d.id)"
            @dragstart="onDragStart($event, d.id)"
            @dragend="onDragEnd"
          >
            <div class="db-name">
              {{ d.name }}
              <span class="badge" :class="dbBadge(d).cls" :title="availTitle(d)">{{ dbBadge(d).label }}</span>
              <span v-for="a in jobAlerts(d.id)" :key="a.key" class="badge failed" :title="a.title">{{ a.label }}</span>
              <span v-if="!d.has_password" class="badge warn">Mot de passe requis</span>
            </div>
            <div class="db-meta">
              {{ engineLabel(d) }}<br />
              <template v-if="lastBackup(d.id)">Dernière sauvegarde {{ fmtAgo(lastBackup(d.id)!.created_at) }}</template>
              <template v-else>Aucune sauvegarde</template>
            </div>
          </div>
          <div v-if="!dbsInGroup(g.id).length" class="folder-empty">Glisser une base ici</div>
        </div>
      </div>

      <div
        class="ungrouped"
        :class="{ 'drag-active': draggingFromGroup && dropTarget === 'root' }"
        @dragover.prevent="onRootDragOver"
        @drop.prevent="onRootDrop"
      >
        <div v-if="draggingFromGroup" class="drop-hint">Déposer pour retirer du groupe</div>
        <div
          v-for="d in ungrouped"
          :key="d.id"
          class="db-card"
          :class="{ active: d.id === selectedId }"
          draggable="true"
          @click="select(d.id)"
          @dragstart="onDragStart($event, d.id)"
          @dragend="onDragEnd"
        >
          <div class="db-name">
            {{ d.name }}
            <span class="badge" :class="dbBadge(d).cls" :title="availTitle(d)">{{ dbBadge(d).label }}</span>
            <span v-for="a in jobAlerts(d.id)" :key="a.key" class="badge failed" :title="a.title">{{ a.label }}</span>
            <span v-if="!d.has_password" class="badge warn">Mot de passe requis</span>
          </div>
          <div class="db-meta">
            {{ engineLabel(d) }}<br />
            <template v-if="lastBackup(d.id)">Dernière sauvegarde {{ fmtAgo(lastBackup(d.id)!.created_at) }}</template>
            <template v-else>Aucune sauvegarde</template>
          </div>
        </div>
      </div>

      <button class="btn list-add" @click="openAdd">Ajouter une base de données</button>
      <div class="list-caption">Une base de données, c'est ce que nous sauvegardons</div>
    </aside>

    <!-- ---------- Détail ---------- -->
    <section class="detail-panel">
      <button type="button" class="mobile-back" @click="backToList">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        Bases
      </button>
      <!-- Formulaire ajout -->
      <div v-if="showAdd">
        <h1>{{ form.engine === 'mysql' ? 'Nouvelle base MySQL' : 'Nouvelle base PostgreSQL / Supabase' }}</h1>
        <div class="card" style="margin-top: 16px;"">
          <div class="row">
            <div>
              <label>Moteur</label>
              <select v-model="form.engine" @change="onEngineChange">
                <option value="postgres">PostgreSQL / Supabase</option>
                <option value="mysql">MySQL</option>
              </select>
            </div>
          </div>
          <div class="row">
            <div><label>Nom</label><input v-model="form.name" /></div>
            <div><label>Hôte</label><input v-model="form.host" :placeholder="form.engine === 'mysql' ? 'mysql.exemple.com' : 'db.xxx.supabase.co / pooler'" /></div>
            <div class="w-port"><label>Port</label><input v-model="form.port" type="number" /></div>
          </div>
          <div v-if="groups.length" class="row">
            <div>
              <label>Groupe</label>
              <select v-model="form.group_id">
                <option :value="null">Sans groupe</option>
                <option v-for="g in sortedGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
              </select>
            </div>
          </div>
          <div class="row">
            <div><label>Base</label><input v-model="form.db_name" /></div>
            <div><label>Utilisateur</label><input v-model="form.username" /></div>
            <div><label>Mot de passe</label><input v-model="form.password" type="password" /></div>
          </div>
          <div class="row">
            <div class="w-ssl"><label>Mode SSL</label><select v-model="form.ssl_mode"><option v-for="m in SSL_MODES" :key="m.value" :value="m.value">{{ m.label }}</option></select></div>
          </div>
          <div class="dump-filters">
            <div v-if="form.engine !== 'mysql'" class="dump-row">
              <span class="k">Schémas inclus</span>
              <TagSelect v-model="form.included_schemas" placeholder="Tous les schémas" />
            </div>
            <div class="dump-row">
              <span class="k">Tables exclues entièrement <i class="info-dot" :title="form.engine === 'mysql' ? 'Nom de table ou motif (logs, audit_*). Absente du dump.' : TIP_TABLES">i</i></span>
              <TagSelect v-model="form.excluded_tables" placeholder="Aucune table exclue" />
            </div>
            <div class="dump-row">
              <span class="k">Données de tables exclues <i class="info-dot" :title="TIP_DATA">i</i></span>
              <TagSelect v-model="form.excluded_table_data" placeholder="Aucune donnée de table exclue" />
            </div>
            <div v-if="form.engine !== 'mysql'" class="dump-row">
              <span class="k">Ignorer les correspondances d'utilisateurs <i class="info-dot" :title="TIP_MAPPINGS">i</i></span>
              <span><input type="checkbox" v-model="form.ignore_user_mappings" /></span>
            </div>
          </div>
          <label v-if="form.engine !== 'mysql'" style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" v-model="form.is_supabase" style="width:auto" /> Base Supabase (préparer rôles + extensions)</label>
          <p v-else class="muted" style="margin-top:12px">Sauvegarde <code>mysqldump</code> (tables, routines, triggers). La vérification restaure dans un MySQL jetable.</p>
          <div style="margin-top:14px"><button class="btn" @click="createDb">Créer</button><button class="btn secondary" style="margin-left:8px" @click="backToList">Annuler</button></div>
        </div>
      </div>

      <div v-else-if="!selected" class="muted">Aucune base sélectionnée. Ajoutez-en une.</div>

      <template v-else>
        <h1 class="detail-heading">
          <template v-if="editName">
            <input v-model="nameEdit" class="detail-name-input" @keyup.enter="saveName" />
            <button class="btn" @click="saveName">Enregistrer</button>
            <button class="btn secondary" @click="editName=false">Annuler</button>
          </template>
          <template v-else>
            <span class="detail-name">{{ selected.name }}</span>
            <button class="icon-btn" title="Renommer" @click="openRename">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </button>
          </template>
        </h1>

        <div class="tabs">
          <div class="tab" :class="{ active: tab==='config' }" @click="tab='config'">Configuration</div>
          <div class="tab" :class="{ active: tab==='backups' }" @click="tab='backups'">Sauvegardes</div>
          <div class="tab" :class="{ active: tab==='verifs' }" @click="tab='verifs'">Vérifications</div>
          <div class="tab" :class="{ active: tab==='availability' }" @click="tab='availability'">Disponibilité</div>
          <div class="tab" :class="{ active: tab==='restores' }" @click="tab='restores'">Restaurations</div>
        </div>

        <div class="card">
        <!-- ===== Configuration ===== -->
        <div v-if="tab==='config'">
          <div v-if="!selected.has_password" style="background:var(--warn-soft);border:1px solid var(--warn);color:var(--warn);border-radius:10px;padding:10px 12px;margin-bottom:16px">
            Mot de passe non défini (base importée sans secret). Clique sur le crayon
            de « Paramètres de la base de données » pour le renseigner avant de tester ou sauvegarder.
          </div>
          <div class="config-grid">
            <!-- Paramètres de la base de données -->
            <div class="config-section">
              <h3>Paramètres de la base de données
                <button class="icon-btn" style="width:26px;height:26px" title="Modifier" @click="openParams">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              </h3>
              <div class="field">
                <span class="k">Groupe</span>
                <span class="v">
                  <select class="group-select" :value="selected.group_id ?? ''" @change="onGroupSelect">
                    <option value="">Sans groupe</option>
                    <option v-for="g in sortedGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
                  </select>
                </span>
              </div>
              <template v-if="editParams">
                <div class="row">
                  <div><label>Hôte</label><input v-model="paramsForm.host" /></div>
                  <div class="w-port"><label>Port</label><input v-model="paramsForm.port" type="number" /></div>
                </div>
                <div class="row">
                  <div><label>Base</label><input v-model="paramsForm.db_name" /></div>
                  <div><label>Utilisateur</label><input v-model="paramsForm.username" /></div>
                </div>
                <div class="row">
                  <div><label>Mot de passe <span class="muted">(vide = inchangé)</span></label><input v-model="paramsForm.password" type="password" /></div>
                  <div class="w-ssl"><label>Mode SSL</label><select v-model="paramsForm.ssl_mode"><option v-for="m in SSL_MODES" :key="m.value" :value="m.value">{{ m.label }}</option></select></div>
                </div>
                <div class="dump-filters">
                  <div v-if="selected.engine !== 'mysql'" class="dump-row">
                    <span class="k">Schémas inclus</span>
                    <TagSelect v-model="paramsForm.included_schemas" placeholder="Tous les schémas" />
                  </div>
                  <div class="dump-row">
                    <span class="k">Tables exclues entièrement <i class="info-dot" :title="TIP_TABLES">i</i></span>
                    <TagSelect v-model="paramsForm.excluded_tables" placeholder="Aucune table exclue" />
                  </div>
                  <div class="dump-row">
                    <span class="k">Données de tables exclues <i class="info-dot" :title="TIP_DATA">i</i></span>
                    <TagSelect v-model="paramsForm.excluded_table_data" placeholder="Aucune donnée de table exclue" />
                  </div>
                  <div v-if="selected.engine !== 'mysql'" class="dump-row">
                    <span class="k">Ignorer les correspondances d'utilisateurs <i class="info-dot" :title="TIP_MAPPINGS">i</i></span>
                    <span><input type="checkbox" v-model="paramsForm.ignore_user_mappings" /></span>
                  </div>
                </div>
                <div style="margin-top:12px"><button class="btn" @click="saveParams">Enregistrer</button><button class="btn secondary" style="margin-left:8px" @click="editParams=false">Annuler</button></div>
              </template>
              <template v-else>
                <div class="field"><span class="k">{{ selected.engine === 'mysql' ? 'Version MySQL' : 'Version de PG' }}</span><span class="v">{{ selected.engine === 'mysql' ? (selected.server_version ?? '—') : (selected.pg_major ?? '—') }}</span></div>
                <div class="field"><span class="k">Hôte</span><span class="v">{{ selected.host }}</span></div>
                <div class="field"><span class="k">Port</span><span class="v">{{ selected.port }}</span></div>
                <div class="field"><span class="k">Nom d'utilisateur</span><span class="v">{{ selected.username }}</span></div>
                <div class="field"><span class="k">Mot de passe</span><span class="v">••••••••••••</span></div>
                <div class="field"><span class="k">Nom de la base</span><span class="v">{{ selected.db_name }}</span></div>
                <div class="field"><span class="k">Mode SSL</span><span class="v">{{ sslLabel(selected.ssl_mode) }}</span></div>
                <div class="field"><span class="k">Type</span><span class="v">{{ engineLabel(selected) }}</span></div>
                <div class="dump-filters">
                  <div v-if="selected.engine !== 'mysql'" class="dump-row">
                    <span class="k">Schémas inclus</span>
                    <TagSelect :model-value="selected.included_schemas ?? []" readonly placeholder="Tous les schémas" />
                  </div>
                  <div class="dump-row">
                    <span class="k">Tables exclues entièrement <i class="info-dot" :title="TIP_TABLES">i</i></span>
                    <TagSelect :model-value="selected.excluded_tables ?? []" readonly placeholder="Aucune table exclue" />
                  </div>
                  <div class="dump-row">
                    <span class="k">Données de tables exclues <i class="info-dot" :title="TIP_DATA">i</i></span>
                    <TagSelect :model-value="selected.excluded_table_data ?? []" readonly placeholder="Aucune donnée de table exclue" />
                  </div>
                  <div v-if="selected.engine !== 'mysql'" class="dump-row">
                    <span class="k">Ignorer les correspondances d'utilisateurs <i class="info-dot" :title="TIP_MAPPINGS">i</i></span>
                    <span><input type="checkbox" :checked="selected.ignore_user_mappings === 1" disabled /></span>
                  </div>
                </div>
              </template>
            </div>

            <!-- Configuration des sauvegardes -->
            <div class="config-section">
              <h3>Configuration des sauvegardes
                <button class="icon-btn" style="width:26px;height:26px" title="Modifier" @click="openPolicy">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              </h3>
              <template v-if="editPolicy">
                <label style="display:flex;gap:8px;align-items:center;margin-top:2px"><input type="checkbox" v-model="cform.enabled" style="width:auto" /> Sauvegardes activées</label>

                <label>Intervalle de sauvegarde</label>
                <select v-model="cform.interval">
                  <option value="hourly">Toutes les heures</option>
                  <option value="daily">Tous les jours</option>
                  <option value="weekly">Toutes les semaines</option>
                  <option value="monthly">Tous les mois</option>
                  <option value="custom">Personnalisé (cron)</option>
                </select>

                <template v-if="cform.interval==='weekly'">
                  <label>Jour de la semaine</label>
                  <select v-model.number="cform.weekday"><option v-for="(w,i) in WEEKDAYS" :key="i" :value="i">{{ w }}</option></select>
                </template>
                <template v-if="cform.interval==='monthly'">
                  <label>Jour du mois</label>
                  <input v-model.number="cform.monthday" type="number" min="1" max="28" />
                </template>
                <template v-if="['daily','weekly','monthly'].includes(cform.interval)">
                  <label>Heure de la sauvegarde (UTC)</label>
                  <input v-model="cform.time" type="time" />
                </template>
                <template v-if="cform.interval==='custom'">
                  <label>Expression cron (UTC)</label>
                  <input v-model="cform.customCron" />
                </template>

                <label>Stockage</label>
                <select v-model="cform.storage_id"><option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }} ({{ s.type }})</option></select>

                <label>Chiffrement</label>
                <select v-model="cform.encrypt"><option :value="true">Chiffrer les fichiers de sauvegarde</option><option :value="false">Ne pas chiffrer</option></select>

                <label>Politique de rétention</label>
                <select v-model="cform.retentionType">
                  <option value="days">Période (N derniers jours)</option>
                  <option value="count">Nombre (N dernières)</option>
                  <option value="unlimited">Illimitée</option>
                </select>
                <select v-if="cform.retentionType==='days'" v-model.number="cform.retentionDays" style="margin-top:6px">
                  <option v-for="r in RETENTION_DAYS" :key="r.value" :value="r.value">{{ r.label }}</option>
                </select>
                <select v-if="cform.retentionType==='count'" v-model.number="cform.retentionCount" style="margin-top:6px">
                  <option v-for="n in RETENTION_COUNTS" :key="n" :value="n">{{ n }} dernières</option>
                </select>

                <label>Notifications</label>
                <div style="display:flex;flex-direction:column;gap:6px">
                  <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" v-model="cform.notify_success" style="width:auto" /> Sauvegarde réussie</label>
                  <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" v-model="cform.notify_failure" style="width:auto" /> Sauvegarde échouée</label>
                </div>

                <a href="#" @click.prevent="cform.showAdvanced=!cform.showAdvanced" style="display:inline-block;margin-top:12px">Paramètres avancés ▾</a>
                <template v-if="cform.showAdvanced">
                  <label>Expression cron générée</label>
                  <input :value="cronFromForm()" disabled />
                </template>

                <div style="margin-top:14px"><button class="btn" @click="savePolicy">Enregistrer</button><button class="btn secondary" style="margin-left:8px" @click="editPolicy=false">Annuler</button></div>
              </template>
              <template v-else-if="policy">
                <div class="field"><span class="k">Sauvegardes activées</span><span class="v">{{ policy.enabled ? "Oui" : "Non" }}</span></div>
                <div class="field"><span class="k">Planification (cron)</span><span class="v"><code>{{ policy.schedule_cron }}</code></span></div>
                <div class="field"><span class="k">Rétention</span><span class="v">
                  {{ policy.retention_count ? policy.retention_count + " dernières" : "" }}{{ policy.retention_count && policy.retention_days ? " / " : "" }}{{ policy.retention_days ? policy.retention_days + " jours" : "" }}{{ !policy.retention_count && !policy.retention_days ? "illimitée" : "" }}
                </span></div>
                <div class="field"><span class="k">Chiffrement</span><span class="v">{{ policy.encrypt ? "Activé (AES-256)" : "Désactivé" }}</span></div>
                <div class="field"><span class="k">Vérifier après</span><span class="v">{{ policy.verify_after ? "Oui" : "Non" }}</span></div>
              </template>
              <template v-else>
                <p class="muted">Aucune planification. <a href="#" @click.prevent="openPolicy">En créer une</a>.</p>
              </template>
            </div>

            <!-- Vérification de restauration -->
            <div class="config-section">
              <h3>Vérification de restauration
                <button class="icon-btn" style="width:26px;height:26px" title="Modifier" @click="openVerif">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              </h3>
              <template v-if="editVerif">
                <label v-if="selected.engine !== 'mysql'" style="display:flex;gap:8px;align-items:center;margin-top:6px"><input type="checkbox" v-model="verifForm.is_supabase" style="width:auto" /> Préparée Supabase (rôles + extensions)</label>
                <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" v-model="verifForm.verify_after" style="width:auto" :disabled="!policy" /> Vérifier après chaque sauvegarde <span v-if="!policy" class="muted">(nécessite une planification)</span></label>
                <div style="margin-top:12px"><button class="btn" @click="saveVerif">Enregistrer</button><button class="btn secondary" style="margin-left:8px" @click="editVerif=false">Annuler</button></div>
              </template>
              <template v-else>
                <div v-if="selected.engine !== 'mysql'" class="field"><span class="k">Préparée Supabase</span><span class="v">{{ selected.is_supabase ? "Oui (rôles + extensions)" : "Standard" }}</span></div>
                <div v-else class="field"><span class="k">Moteur</span><span class="v">MySQL (mysqldump, conteneur jetable)</span></div>
                <div class="field"><span class="k">Déclenchement</span><span class="v">{{ policy?.verify_after ? "Après chaque sauvegarde" : "Manuel" }}</span></div>
                <div class="field"><span class="k">Cible</span><span class="v">Conteneur jetable (détruit ensuite)</span></div>
              </template>
            </div>

            <!-- Vérification de disponibilité -->
            <div class="config-section">
              <h3>Vérification de disponibilité
                <button class="icon-btn" style="width:26px;height:26px" title="Modifier" @click="openAvail">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              </h3>
              <template v-if="editAvail">
                <label style="display:flex;gap:8px;align-items:center;margin-top:2px"><input type="checkbox" v-model="availForm.enabled" style="width:auto" /> Vérification activée</label>
                <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" v-model="availForm.notify" style="width:auto" /> Notifier en cas d'indisponibilité</label>
                <p class="muted" style="margin:4px 0 0">Les canaux qui notifient les échecs sont utilisés.</p>
                <label>Intervalle de vérification (min)</label>
                <input v-model.number="availForm.interval_min" type="number" min="1" max="1440" />
                <label>Tentatives avant indisponibilité</label>
                <input v-model.number="availForm.attempts" type="number" min="1" max="30" />
                <label>Conserver l'historique (jours)</label>
                <input v-model.number="availForm.history_days" type="number" min="1" max="365" />
                <div style="margin-top:12px"><button class="btn" @click="saveAvail">Enregistrer</button><button class="btn secondary" style="margin-left:8px" @click="editAvail=false">Annuler</button></div>
              </template>
              <template v-else>
                <div class="field long"><span class="k">Vérification activée</span><span class="v">{{ ouiNon(selected.avail_enabled) }}</span></div>
                <div class="field long"><span class="k">Notifier en cas d'indisponibilité</span><span class="v">{{ ouiNon(selected.avail_notify) }}</span></div>
                <div class="field long"><span class="k">Intervalle de vérification (min)</span><span class="v">{{ selected.avail_interval_min ?? 1 }}</span></div>
                <div class="field long"><span class="k">Tentatives avant indisponibilité</span><span class="v">{{ selected.avail_attempts ?? 3 }}</span></div>
                <div class="field long"><span class="k">Conserver l'historique (jours)</span><span class="v">{{ selected.avail_history_days ?? 7 }}</span></div>
              </template>
            </div>

            <!-- Canaux de notification -->
            <div class="config-section">
              <h3>Canaux de notification
                <RouterLink class="icon-btn" style="width:26px;height:26px" to="/notifications" title="Gérer">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </RouterLink>
              </h3>
              <div v-if="channels.length" class="field">
                <span class="k">Notifier via</span>
                <span class="v">{{ channels.map(c => c.name + " (" + c.type + ")").join(", ") }}</span>
              </div>
              <p v-else class="muted">Aucun canal. <RouterLink to="/notifications">En ajouter</RouterLink>.</p>
            </div>
          </div>

          <div class="toolbar" style="margin-top:22px">
            <button class="btn" @click="test">Tester la connexion</button>
            <button class="btn secondary" @click="runBackup">Lancer une sauvegarde</button>
            <button class="icon-btn danger" title="Supprimer" @click="removeDb">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
            </button>
          </div>
        </div>

        <!-- ===== Sauvegardes ===== -->
        <div v-else-if="tab==='backups'">
          <div class="toolbar">
            <button class="btn" @click="runBackup">Lancer une sauvegarde maintenant</button>
            <button class="btn secondary" @click="loadDetail(selected.id)">Rafraîchir</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Créée le</th><th>Statut</th><th>Taille</th><th>Durée</th><th>Vérification</th><th>Actions</th></tr></thead>
              <tbody>
                <tr v-for="b in backups" :key="b.id">
                  <td>{{ fmtDate(b.created_at) }}<div class="muted">{{ fmtAgo(b.created_at) }}</div></td>
                  <td>
                    <button class="text-btn" title="Voir le détail" @click="openDetail('backup', b.id)"><span class="badge" :class="b.status">{{ statusLabel(b.status) }}</span></button>
                    <div v-if="b.error" class="muted">{{ b.error }}</div>
                  </td>
                  <td>{{ fmtSize(b.size_bytes) }}</td>
                  <td>{{ fmtDuration(b.started_at, b.finished_at) }}</td>
                  <td>
                    <button v-if="verifFor(b.id)" class="text-btn" title="Voir le rapport" @click="openDetail('verification', verifFor(b.id)!.id)"><span class="badge" :class="verifFor(b.id)!.status">{{ verifFor(b.id)!.status === 'success' ? 'Vérifiée' : verifFor(b.id)!.status === 'failed' ? 'Échouée' : verifFor(b.id)!.status }}</span></button>
                    <span v-else class="muted">—</span>
                  </td>
                  <td>
                    <div style="display:flex;gap:6px;align-items:center">
                      <button v-if="b.status==='success'" class="icon-btn" title="Vérifier" @click="verify(b.id)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>
                      </button>
                      <a v-if="b.status==='success'" class="icon-btn" :href="`/api/backups/${b.id}/download`" title="Télécharger">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                      </a>
                      <button v-if="b.status==='success'" class="icon-btn" title="Restaurer" @click="openRestore(b.id)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
                      </button>
                      <button class="icon-btn" title="Détail" @click="openDetail('backup', b.id)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                      </button>
                      <button class="icon-btn danger" title="Supprimer" @click="deleteBackup(b.id)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!backups.length"><td colspan="6" class="muted">Aucune sauvegarde.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ===== Restauration ===== -->
        <div v-else-if="tab==='restores'">
          <div class="toolbar">
            <button class="btn secondary" @click="loadDetail(selected.id)">Rafraîchir</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Créée le</th><th>Statut</th><th>Destination</th><th>Actions</th></tr></thead>
              <tbody>
                <tr v-for="r in restores" :key="r.id">
                  <td>{{ fmtDate(r.created_at) }}<div class="muted">{{ fmtAgo(r.created_at) }}</div></td>
                  <td>
                    <button class="text-btn" title="Détails" @click="openDetail('restore', r.id)"><span class="badge" :class="r.status">{{ statusLabel(r.status) }}</span></button>
                    <div v-if="r.root_error" class="muted">{{ r.root_error }}</div>
                  </td>
                  <td>{{ r.target_label }}<div class="muted">{{ r.mode === 'existing' ? 'Base existante' : 'Nouvelle base' }}</div></td>
                  <td>
                    <button class="icon-btn" title="Détails" @click="openDetail('restore', r.id)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                    </button>
                  </td>
                </tr>
                <tr v-if="!restores.length"><td colspan="4" class="muted">Aucune restauration.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ===== Vérifications ===== -->
        <div v-else-if="tab==='verifs'">
          <p class="muted" style="margin-bottom:14px">Chaque ligne correspond à une restauration de cette base dans une copie temporaire.</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Créée le</th><th>Statut</th><th>Déclenchement</th><th>Durée</th><th>Actions</th></tr></thead>
              <tbody>
                <tr v-for="v in verifs" :key="v.id">
                  <td>{{ fmtDate(v.created_at) }}<div class="muted">{{ fmtAgo(v.created_at) }}</div></td>
                  <td><span class="badge" :class="v.status">{{ statusLabel(v.status) }}</span></td>
                  <td class="muted">{{ v.trigger }}</td>
                  <td>{{ fmtDuration(v.started_at, v.finished_at) }}</td>
                  <td>
                    <button class="icon-btn" title="Voir le rapport" @click="openDetail('verification', v.id)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                    </button>
                  </td>
                </tr>
                <tr v-if="!verifs.length"><td colspan="5" class="muted">Aucune vérification.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ===== Disponibilité ===== -->
        <div v-else-if="tab==='availability'">
          <h2 class="avail-title">Vérifications de disponibilité</h2>
          <div class="avail-toolbar">
            <label>Période
              <select v-model="availPeriod">
                <option value="today">Aujourd'hui</option>
                <option value="24h">24 heures</option>
                <option value="7d">7 jours</option>
              </select>
            </label>
            <button class="btn secondary" :disabled="availBusy" @click="checkNow">{{ availBusy ? "Vérification…" : "Vérifier maintenant" }}</button>
          </div>
          <p class="avail-status muted">
            {{ availStatusLabel }}
            <template v-if="selected.avail_last_check_at"> · {{ fmtAgo(selected.avail_last_check_at) }}</template>
          </p>
          <p v-if="lastAvailError && (selected.avail_down || selected.avail_fail_streak)" class="err">{{ lastAvailError }}</p>
          <div v-if="availChecks.length" class="avail-grid">
            <span
              v-for="c in availChecks"
              :key="c.id"
              class="avail-cell"
              :class="{ down: c.ok !== 1 }"
              :title="cellTitle(c)"
            ></span>
          </div>
          <p v-else class="muted">Aucune vérification sur cette période.</p>
        </div>
        </div>
      </template>
    </section>

    <!-- ---------- Détail (sauvegarde, vérification, restauration) ---------- -->
    <div v-if="detail" class="modal-overlay" @click.self="closeDetail">
      <div class="modal detail-modal" role="dialog" aria-modal="true">
        <button class="icon-btn detail-close" title="Fermer" @click="closeDetail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
        <BackupDetail v-if="detail.kind==='backup'" :key="`b-${detail.id}`" :id="detail.id" @close="closeDetail" @open="openDetail" @deleted="selected && loadDetail(selected.id)" @focus="onFocusDb" />
        <VerificationDetail v-else-if="detail.kind==='verification'" :key="`v-${detail.id}`" :id="detail.id" @focus="onFocusDb" />
        <RestoreDetail v-else :key="`r-${detail.id}`" :id="detail.id" @open="openDetail" @focus="onFocusDb" />
      </div>
    </div>

    <!-- ---------- Modale de restauration ---------- -->
    <div v-if="showRestore" class="modal-overlay" @click.self="showRestore=false">
      <div class="modal restore-modal">
        <h2>Restaurer la sauvegarde #{{ restoreBackupId }}</h2>
        <div v-if="restoreSource" class="field" style="margin-top:8px">
          <span class="k">Base source</span>
          <span class="v">{{ restoreSource.name }}<br /><span class="muted text-small">{{ restoreSource.db_name }}@{{ restoreSource.host }}</span></span>
        </div>
        <label>Destination</label>
        <select v-model="rform.mode">
          <option value="existing">Base existante</option>
          <option value="new">Nouvelle base</option>
        </select>

        <template v-if="rform.mode==='existing'">
          <label>Base de destination</label>
          <select v-model="rform.targetDatabaseId" @change="onRestoreTarget">
            <option v-for="d in restoreCandidates" :key="d.id" :value="d.id">{{ d.name }} — {{ d.db_name }}@{{ d.host }}</option>
          </select>
          <template v-if="restoreSource?.engine !== 'mysql'">
          <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px">
            <input type="checkbox" v-model="rform.wipeData" style="width:auto;margin-top:2px" @change="onWipeData" />
            Base Supabase : supprimer l'applicatif, conserver Supabase
          </label>
          <p v-if="rform.wipeData" class="muted" style="margin-top:6px">Les tables, vues et fonctions de <code>public</code> sont supprimées puis recréées depuis la sauvegarde. Les objets d'extension (PostGIS, etc.) restent. <code>auth</code>, <code>storage</code>, <code>realtime</code> et les autres schémas Supabase ne sont pas touchés. Un schéma applicatif comme <code>private</code> est supprimé puis rechargé.</p>
          <p v-else-if="rform.clean" class="muted" style="margin-top:6px"><code>--clean</code> supprime les objets avant de les recréer. Sur une base Supabase, le schéma <code>public</code> peut rester bloqué par les extensions.</p>
          <p v-else class="muted" style="margin-top:6px">La sauvegarde sera restaurée dans cette base <strong>existante</strong>. Les lignes déjà présentes restent.</p>
          </template>
          <p v-else class="muted" style="margin-top:6px">Le dump contient <code>DROP TABLE IF EXISTS</code> : les tables de la sauvegarde sont recréées. La base source n'est jamais modifiée.</p>
        </template>
        <template v-else>
          <button type="button" class="clip-fill" @click="fillConnFromClipboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></svg>
            Remplir depuis le presse-papiers
          </button>
          <div class="conn-grid">
            <label for="rconn-host">Hôte</label>
            <input id="rconn-host" v-model="rconn.host" :placeholder="restoreSource?.engine === 'mysql' ? 'Hôte MySQL' : 'Hôte PostgreSQL'" autocomplete="off" />
            <label for="rconn-port">Port</label>
            <input id="rconn-port" v-model="rconn.port" :placeholder="restoreSource?.engine === 'mysql' ? '3306' : '5432'" inputmode="numeric" autocomplete="off" />
            <label for="rconn-user">Nom d'utilisateur</label>
            <input id="rconn-user" v-model="rconn.username" placeholder="Saisissez le nom d'utilisateur" autocomplete="off" />
            <label for="rconn-pw">Mot de passe</label>
            <div class="pw-wrap">
              <input id="rconn-pw" v-model="rconn.password" :type="showConnPw ? 'text' : 'password'" placeholder="Saisissez le mot de passe" autocomplete="new-password" />
              <button type="button" class="pw-eye" :title="showConnPw ? 'Masquer le mot de passe' : 'Afficher le mot de passe'" @click="showConnPw = !showConnPw">
                <svg v-if="showConnPw" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.1A10.8 10.8 0 0 1 12 5c7 0 11 7 11 7a18 18 0 0 1-3.2 4.2" /><path d="M6.1 6.1C3.5 7.9 2 12 2 12s4 7 10 7a10 10 0 0 0 4.1-.9" /></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
              </button>
            </div>
            <label for="rconn-db">Nom de la base</label>
            <input id="rconn-db" v-model="rconn.dbName" autocomplete="off" />
            <label for="rconn-ssl">Mode SSL</label>
            <select id="rconn-ssl" v-model="rconn.sslMode">
              <option v-for="m in SSL_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </div>
          <p v-if="connErrorMsg" class="err">{{ connErrorMsg }}</p>
          <p class="muted" style="margin-top:10px">Cette base est créée sur le serveur indiqué, puis la sauvegarde y est restaurée.</p>
          <label v-if="restoreSource?.engine !== 'mysql'" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" v-model="rform.prepareSupabase" style="width:auto" /> Préparer Supabase (rôles + extensions)</label>
        </template>

        <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" v-model="rform.clean" style="width:auto" @change="onClean" />
          <template v-if="restoreSource?.engine === 'mysql'">Supprimer les tables de la cible avant import</template>
          <template v-else>Écraser les objets existants (<code>--clean</code>)</template>
        </label>

        <div style="background:var(--danger-soft);border:1px solid var(--danger);border-radius:10px;margin-top:14px;padding:12px">
          <label style="display:flex;gap:8px;align-items:flex-start;color:var(--danger);margin:0">
            <input type="checkbox" v-model="rform.confirm" style="width:auto;margin-top:2px" />
            Je comprends que cette restauration <strong>écrit dans la base de destination</strong>.
          </label>
        </div>

        <div class="modal-actions">
          <button class="btn danger" :disabled="!rform.confirm" @click="launchRestore">Lancer la restauration</button>
          <button class="btn secondary" @click="showRestore=false">Annuler</button>
        </div>
      </div>
    </div>

    <!-- ---------- Modale de confirmation ---------- -->
    <div v-if="confirmState.show" class="modal-overlay" @click.self="confirmState.show=false">
      <div class="modal" style="width:400px">
        <h2>Confirmation</h2>
        <p>{{ confirmState.message }}</p>
        <div class="modal-actions">
          <button class="btn danger" @click="doConfirm">Supprimer</button>
          <button class="btn secondary" @click="confirmState.show=false">Annuler</button>
        </div>
      </div>
    </div>
  </div>
</template>
