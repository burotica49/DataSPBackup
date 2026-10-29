<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../lib/api";
import { useToasts } from "../store/toasts";

const toasts = useToasts();

interface Db {
  id: number; name: string; host: string; port: number; db_name: string;
  username: string; ssl_mode: string; is_supabase: number; pg_major: number | null;
  included_schemas: string[];
}
interface Backup {
  id: number; database_id: number; status: string; trigger: string;
  size_bytes: number | null; pg_major: number | null; created_at: string;
  started_at: string | null; finished_at: string | null; encrypted: number; error: string | null;
}
interface Verif {
  id: number; backup_id: number; status: string; trigger: string;
  created_at: string; started_at: string | null; finished_at: string | null;
}
interface Policy {
  id: number; database_id: number; storage_id: number; schedule_cron: string;
  retention_count: number | null; retention_days: number | null;
  encrypt: number; verify_after: number; enabled: number;
}
interface Store { id: number; name: string; type: string }
interface Channel { id: number; type: string; name: string; on_failure: number; on_success: number; on_start: number }

const dbs = ref<Db[]>([]);
const stores = ref<Store[]>([]);
const channels = ref<Channel[]>([]);
const allBackups = ref<Backup[]>([]);
const selectedId = ref<number | null>(null);
const tab = ref<"config" | "backups" | "verifs">("config");

const backups = ref<Backup[]>([]);
const verifs = ref<Verif[]>([]);
const policy = ref<Policy | null>(null);

const selected = computed(() => dbs.value.find((d) => d.id === selectedId.value) ?? null);

// ---- helpers ----
function parse(d: string | null) { return d ? Date.parse(d + "Z") : NaN; }
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

// ---- loading ----
async function loadAll() {
  [dbs.value, stores.value, channels.value, allBackups.value] = await Promise.all([
    api.get<Db[]>("/api/databases"),
    api.get<Store[]>("/api/storages"),
    api.get<Channel[]>("/api/notifications"),
    api.get<Backup[]>("/api/backups"),
  ]);
  if (selectedId.value == null && dbs.value[0]) selectedId.value = dbs.value[0].id;
}
async function loadDetail(id: number) {
  const [bs, vs, ps] = await Promise.all([
    api.get<Backup[]>(`/api/backups?database_id=${id}`),
    api.get<Verif[]>(`/api/verifications?database_id=${id}`),
    api.get<Policy[]>("/api/policies"),
  ]);
  backups.value = bs;
  verifs.value = vs;
  policy.value = ps.find((p) => p.database_id === id) ?? null;
}
watch(selectedId, (id) => { if (id != null) { showAdd.value = false; editDb.value = false; loadDetail(id); } });

function select(id: number) { selectedId.value = id; tab.value = "config"; }

// ---- actions ----
async function test() {
  if (!selected.value) return;
  toasts.info("Test de connexion…");
  try {
    const r = await api.post<{ pg_major: number }>(`/api/databases/${selected.value.id}/test`);
    toasts.success(`Connexion OK — PostgreSQL ${r.pg_major}`);
    await loadAll();
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
async function runBackup() {
  if (!selected.value) return;
  try {
    await api.post("/api/backups/run", { database_id: selected.value.id, encrypt: true, verify_after: true });
    toasts.info(`Sauvegarde lancée — ${selected.value.name}`);
    setTimeout(() => loadDetail(selected.value!.id), 800);
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
async function verify(backupId: number) {
  await api.post(`/api/backups/${backupId}/verify`);
  toasts.info("Vérification lancée");
  setTimeout(() => loadDetail(selected.value!.id), 800);
}
async function removeDb() {
  if (!selected.value) return;
  if (!confirm(`Supprimer la base « ${selected.value.name} » ?`)) return;
  await api.del(`/api/databases/${selected.value.id}`);
  selectedId.value = null;
  await loadAll();
  if (dbs.value[0]) selectedId.value = dbs.value[0].id;
}

// ---- add / edit database ----
const showAdd = ref(false);
const editDb = ref(false);
const blank = () => ({
  name: "", host: "", port: 5432, db_name: "postgres", username: "postgres",
  password: "", ssl_mode: "prefer", is_supabase: true, included_schemas: "public,auth,storage",
});
const form = ref(blank());
function openAdd() { showAdd.value = true; editDb.value = false; form.value = blank(); selectedId.value = null; }
function openEdit() {
  const d = selected.value; if (!d) return;
  editDb.value = true;
  form.value = {
    name: d.name, host: d.host, port: d.port, db_name: d.db_name, username: d.username,
    password: "", ssl_mode: d.ssl_mode, is_supabase: d.is_supabase === 1,
    included_schemas: d.included_schemas.join(","),
  };
}
async function saveDb() {
  const payload = {
    ...form.value, port: Number(form.value.port),
    included_schemas: form.value.included_schemas.split(",").map((s) => s.trim()).filter(Boolean),
  };
  try {
    if (editDb.value && selected.value) {
      const body: Record<string, unknown> = { ...payload };
      if (!payload.password) delete body.password;
      await api.patch(`/api/databases/${selected.value.id}`, body);
      editDb.value = false;
    } else {
      const created = await api.post<Db>("/api/databases", payload);
      showAdd.value = false;
      await loadAll();
      selectedId.value = created.id;
    }
    toasts.success("Base enregistrée");
    await loadAll();
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

// ---- backup config (policy) ----
const editPolicy = ref(false);
const pform = ref({ schedule_cron: "0 2 * * *", retention_count: 7 as number | null, retention_days: null as number | null, encrypt: true, verify_after: true, enabled: true });
function openPolicy() {
  editPolicy.value = true;
  if (policy.value) {
    pform.value = {
      schedule_cron: policy.value.schedule_cron,
      retention_count: policy.value.retention_count,
      retention_days: policy.value.retention_days,
      encrypt: policy.value.encrypt === 1,
      verify_after: policy.value.verify_after === 1,
      enabled: policy.value.enabled === 1,
    };
  }
}
async function savePolicy() {
  if (!selected.value) return;
  const body = {
    schedule_cron: pform.value.schedule_cron,
    retention_count: pform.value.retention_count ? Number(pform.value.retention_count) : null,
    retention_days: pform.value.retention_days ? Number(pform.value.retention_days) : null,
    encrypt: pform.value.encrypt, verify_after: pform.value.verify_after, enabled: pform.value.enabled,
  };
  try {
    if (policy.value) await api.patch(`/api/policies/${policy.value.id}`, body);
    else await api.post("/api/policies", { database_id: selected.value.id, storage_id: stores.value[0]?.id, ...body });
    editPolicy.value = false;
    toasts.success("Planification enregistrée");
    await loadDetail(selected.value.id);
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}

onMounted(loadAll);
</script>

<template>
  <div class="master-detail">
    <!-- ---------- Liste des bases ---------- -->
    <aside class="list-panel">
      <div v-for="d in dbs" :key="d.id" class="db-card" :class="{ active: d.id === selectedId }" @click="select(d.id)">
        <div class="db-name">
          {{ d.name }}
          <span v-if="d.pg_major" class="badge available">Disponible</span>
          <span v-else class="badge neutral">Non testé</span>
        </div>
        <div class="db-meta">
          Stockage : Stockage local<br />
          <template v-if="lastBackup(d.id)">Dernière sauvegarde {{ fmtAgo(lastBackup(d.id)!.created_at) }}</template>
          <template v-else>Aucune sauvegarde</template>
        </div>
      </div>
      <button class="btn" style="width: 100%; margin-top: 6px" @click="openAdd">Ajouter une base de données</button>
      <div class="list-caption">Une base de données, c'est ce que nous sauvegardons</div>
    </aside>

    <!-- ---------- Détail ---------- -->
    <section class="detail-panel">
      <!-- Formulaire ajout -->
      <div v-if="showAdd">
        <h1>Nouvelle base PostgreSQL / Supabase</h1>
        <div class="card" style="margin-top: 14px; max-width: 720px">
          <div class="row">
            <div><label>Nom</label><input v-model="form.name" /></div>
            <div><label>Hôte</label><input v-model="form.host" placeholder="db.xxx.supabase.co / pooler" /></div>
            <div style="max-width:110px"><label>Port</label><input v-model="form.port" type="number" /></div>
          </div>
          <div class="row">
            <div><label>Base</label><input v-model="form.db_name" /></div>
            <div><label>Utilisateur</label><input v-model="form.username" /></div>
            <div><label>Mot de passe</label><input v-model="form.password" type="password" /></div>
          </div>
          <div class="row">
            <div style="max-width:160px"><label>Mode SSL</label><select v-model="form.ssl_mode"><option>disable</option><option>prefer</option><option>require</option></select></div>
            <div style="flex:2"><label>Schémas inclus (virgules ; vide = tous)</label><input v-model="form.included_schemas" /></div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" v-model="form.is_supabase" style="width:auto" /> Base Supabase (préparer rôles + extensions)</label>
          <div style="margin-top:14px"><button class="btn" @click="saveDb">Créer</button><button class="btn secondary" style="margin-left:8px" @click="showAdd=false">Annuler</button></div>
        </div>
      </div>

      <div v-else-if="!selected" class="muted">Aucune base sélectionnée. Ajoutez-en une.</div>

      <template v-else>
        <h1 style="display:flex;align-items:center;gap:10px">
          {{ selected.name }}
          <button class="icon-btn" title="Modifier" @click="openEdit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          </button>
        </h1>

        <div class="tabs">
          <div class="tab" :class="{ active: tab==='config' }" @click="tab='config'">Configuration</div>
          <div class="tab" :class="{ active: tab==='backups' }" @click="tab='backups'">Sauvegardes</div>
          <div class="tab" :class="{ active: tab==='verifs' }" @click="tab='verifs'">Vérifications</div>
        </div>

        <!-- ===== Configuration ===== -->
        <div v-if="tab==='config'">
          <!-- édition base -->
          <div v-if="editDb" class="card" style="max-width:720px">
            <h2>Modifier la connexion</h2>
            <div class="row">
              <div><label>Nom</label><input v-model="form.name" /></div>
              <div><label>Hôte</label><input v-model="form.host" /></div>
              <div style="max-width:110px"><label>Port</label><input v-model="form.port" type="number" /></div>
            </div>
            <div class="row">
              <div><label>Base</label><input v-model="form.db_name" /></div>
              <div><label>Utilisateur</label><input v-model="form.username" /></div>
              <div><label>Mot de passe <span class="muted">(vide = inchangé)</span></label><input v-model="form.password" type="password" /></div>
            </div>
            <div class="row">
              <div style="max-width:160px"><label>Mode SSL</label><select v-model="form.ssl_mode"><option>disable</option><option>prefer</option><option>require</option></select></div>
              <div style="flex:2"><label>Schémas inclus</label><input v-model="form.included_schemas" /></div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" v-model="form.is_supabase" style="width:auto" /> Base Supabase</label>
            <div style="margin-top:14px"><button class="btn" @click="saveDb">Enregistrer</button><button class="btn secondary" style="margin-left:8px" @click="editDb=false">Annuler</button></div>
          </div>

          <div v-else class="config-grid">
            <div class="config-section">
              <h3>Paramètres de la base de données</h3>
              <div class="field"><span class="k">Version de PG</span><span class="v">{{ selected.pg_major ?? "—" }}</span></div>
              <div class="field"><span class="k">Hôte</span><span class="v">{{ selected.host }}</span></div>
              <div class="field"><span class="k">Port</span><span class="v">{{ selected.port }}</span></div>
              <div class="field"><span class="k">Nom d'utilisateur</span><span class="v">{{ selected.username }}</span></div>
              <div class="field"><span class="k">Mot de passe</span><span class="v">••••••••••••</span></div>
              <div class="field"><span class="k">Nom de la base</span><span class="v">{{ selected.db_name }}</span></div>
              <div class="field"><span class="k">Mode SSL</span><span class="v">{{ selected.ssl_mode }}</span></div>
              <div class="field"><span class="k">Schémas inclus</span><span class="v">{{ selected.included_schemas.join(", ") || "toutes" }}</span></div>
              <div class="field"><span class="k">Type</span><span class="v">{{ selected.is_supabase ? "Supabase" : "PostgreSQL" }}</span></div>
            </div>

            <div class="config-section">
              <h3>Configuration des sauvegardes
                <button class="icon-btn" style="width:26px;height:26px" title="Modifier" @click="openPolicy">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              </h3>
              <template v-if="editPolicy">
                <label>Expression cron (UTC)</label><input v-model="pform.schedule_cron" />
                <div class="row">
                  <div><label>Garder N dernières</label><input v-model="pform.retention_count" type="number" /></div>
                  <div><label>Garder N jours</label><input v-model="pform.retention_days" type="number" /></div>
                </div>
                <div style="display:flex;gap:16px;margin-top:10px;flex-wrap:wrap">
                  <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" v-model="pform.encrypt" style="width:auto" /> Chiffrer</label>
                  <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" v-model="pform.verify_after" style="width:auto" /> Vérifier après</label>
                  <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" v-model="pform.enabled" style="width:auto" /> Activée</label>
                </div>
                <div style="margin-top:12px"><button class="btn" @click="savePolicy">Enregistrer</button><button class="btn secondary" style="margin-left:8px" @click="editPolicy=false">Annuler</button></div>
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

            <div class="config-section">
              <h3>Vérification de restauration</h3>
              <div class="field"><span class="k">Préparée Supabase</span><span class="v">{{ selected.is_supabase ? "Oui (rôles + extensions)" : "Standard" }}</span></div>
              <div class="field"><span class="k">Déclenchement</span><span class="v">{{ policy?.verify_after ? "Après chaque sauvegarde" : "Manuel" }}</span></div>
              <div class="field"><span class="k">Cible</span><span class="v">Conteneur jetable (détruit ensuite)</span></div>
            </div>

            <div class="config-section">
              <h3>Canaux de notification</h3>
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
          <div class="card" style="padding:0">
            <table>
              <thead><tr><th>Créée le</th><th>Statut</th><th>Taille</th><th>Durée</th><th>Vérification</th><th>Actions</th></tr></thead>
              <tbody>
                <tr v-for="b in backups" :key="b.id">
                  <td>{{ new Date(b.created_at + "Z").toLocaleString() }}<div class="muted">{{ fmtAgo(b.created_at) }}</div></td>
                  <td><span class="badge" :class="b.status">{{ b.status === 'success' ? 'Réussie' : b.status }}</span><div v-if="b.error" class="muted">{{ b.error }}</div></td>
                  <td>{{ fmtSize(b.size_bytes) }}</td>
                  <td>{{ fmtDuration(b.started_at, b.finished_at) }}</td>
                  <td>
                    <RouterLink v-if="verifFor(b.id)" :to="`/verifications/${verifFor(b.id)!.id}`"><span class="badge" :class="verifFor(b.id)!.status">{{ verifFor(b.id)!.status === 'success' ? 'Vérifiée' : verifFor(b.id)!.status === 'failed' ? 'Échouée' : verifFor(b.id)!.status }}</span></RouterLink>
                    <span v-else class="muted">—</span>
                  </td>
                  <td>
                    <button v-if="b.status==='success'" class="icon-btn" title="Vérifier" @click="verify(b.id)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>
                    </button>
                  </td>
                </tr>
                <tr v-if="!backups.length"><td colspan="6" class="muted">Aucune sauvegarde.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ===== Vérifications ===== -->
        <div v-else>
          <p class="muted" style="margin-bottom:14px">Chaque ligne correspond à une restauration de cette base dans une copie temporaire.</p>
          <div class="card" style="padding:0">
            <table>
              <thead><tr><th>Créée le</th><th>Statut</th><th>Déclenchement</th><th>Durée</th><th>Actions</th></tr></thead>
              <tbody>
                <tr v-for="v in verifs" :key="v.id">
                  <td>{{ new Date(v.created_at + "Z").toLocaleString() }}<div class="muted">{{ fmtAgo(v.created_at) }}</div></td>
                  <td><span class="badge" :class="v.status">{{ v.status === 'success' ? 'Réussie' : v.status === 'failed' ? 'Échouée' : v.status }}</span></td>
                  <td class="muted">{{ v.trigger }}</td>
                  <td>{{ fmtDuration(v.started_at, v.finished_at) }}</td>
                  <td>
                    <RouterLink class="icon-btn" :to="`/verifications/${v.id}`" title="Voir le rapport">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                    </RouterLink>
                  </td>
                </tr>
                <tr v-if="!verifs.length"><td colspan="5" class="muted">Aucune vérification.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>
