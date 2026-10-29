<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToasts } from "../store/toasts";

const toasts = useToasts();

interface Policy {
  id: number; database_id: number; storage_id: number; schedule_cron: string;
  retention_count: number | null; retention_days: number | null;
  encrypt: number; verify_after: number; enabled: number;
}
interface Db { id: number; name: string }
interface Store { id: number; name: string; type: string }

const list = ref<Policy[]>([]);
const dbs = ref<Db[]>([]);
const stores = ref<Store[]>([]);
const showForm = ref(false);

const CRON_PRESETS = [
  { label: "Toutes les heures", value: "0 * * * *" },
  { label: "Quotidien à 02:00", value: "0 2 * * *" },
  { label: "Hebdo (dimanche 03:00)", value: "0 3 * * 0" },
  { label: "Mensuel (1er à 04:00)", value: "0 4 1 * *" },
];

const blank = () => ({
  database_id: 0, storage_id: 0, schedule_cron: "0 2 * * *",
  retention_count: 7 as number | null, retention_days: null as number | null,
  encrypt: true, verify_after: true, enabled: true,
});
const form = ref(blank());

function dbName(id: number) { return dbs.value.find((d) => d.id === id)?.name ?? "#" + id; }

async function load() {
  [list.value, dbs.value, stores.value] = await Promise.all([
    api.get<Policy[]>("/api/policies"),
    api.get<Db[]>("/api/databases"),
    api.get<Store[]>("/api/storages"),
  ]);
}
function openCreate() {
  form.value = blank();
  if (dbs.value[0]) form.value.database_id = dbs.value[0].id;
  if (stores.value[0]) form.value.storage_id = stores.value[0].id;
  showForm.value = true;
}
async function create() {
  try {
    await api.post("/api/policies", {
      database_id: Number(form.value.database_id),
      storage_id: Number(form.value.storage_id),
      schedule_cron: form.value.schedule_cron,
      retention_count: form.value.retention_count ? Number(form.value.retention_count) : null,
      retention_days: form.value.retention_days ? Number(form.value.retention_days) : null,
      encrypt: form.value.encrypt,
      verify_after: form.value.verify_after,
      enabled: form.value.enabled,
    });
    showForm.value = false;
    toasts.success("Planification créée");
    await load();
  } catch (e) {
    toasts.error("Création impossible : " + (e as { message?: string }).message);
  }
}
async function toggle(p: Policy) {
  await api.patch(`/api/policies/${p.id}`, { enabled: p.enabled === 0 });
  await load();
}
async function runNow(p: Policy) {
  await api.post(`/api/policies/${p.id}/run`);
  toasts.info(`Sauvegarde lancée — ${dbName(p.database_id)}`, { to: "/backups", label: "Voir" });
}
async function remove(id: number) {
  if (!confirm("Supprimer cette planification ?")) return;
  await api.del(`/api/policies/${id}`);
  await load();
}
onMounted(load);
</script>

<template>
  <div class="page">
  <h1>Planification</h1>
  <p class="muted">Sauvegardes automatiques (cron UTC) avec rétention et vérification.</p>
  <button class="btn" @click="openCreate" :disabled="!dbs.length">Ajouter une planification</button>
  <p v-if="!dbs.length" class="muted">Ajoute d'abord une base dans l'onglet Bases.</p>

  <div v-if="showForm" class="card" style="margin-top: 16px">
    <h2>Nouvelle planification</h2>
    <div class="row">
      <div>
        <label>Base</label>
        <select v-model="form.database_id">
          <option v-for="d in dbs" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </div>
      <div>
        <label>Stockage</label>
        <select v-model="form.storage_id">
          <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }} ({{ s.type }})</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div>
        <label>Fréquence</label>
        <select @change="form.schedule_cron = ($event.target as HTMLSelectElement).value">
          <option v-for="p in CRON_PRESETS" :key="p.value" :value="p.value" :selected="p.value === form.schedule_cron">{{ p.label }}</option>
        </select>
      </div>
      <div>
        <label>Expression cron (UTC)</label>
        <input v-model="form.schedule_cron" />
      </div>
    </div>
    <div class="row">
      <div><label>Garder les N dernières</label><input v-model="form.retention_count" type="number" placeholder="ex: 7" /></div>
      <div><label>Garder N jours</label><input v-model="form.retention_days" type="number" placeholder="ex: 30" /></div>
    </div>
    <div style="display: flex; gap: 18px; margin-top: 12px; flex-wrap: wrap">
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.encrypt" style="width: auto" /> Chiffrer (AES-256)</label>
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.verify_after" style="width: auto" /> Vérifier après</label>
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.enabled" style="width: auto" /> Activée</label>
    </div>
    <div style="margin-top: 14px">
      <button class="btn" @click="create">Créer</button>
      <button class="btn secondary" style="margin-left: 8px" @click="showForm = false">Annuler</button>
    </div>
  </div>

  <div class="card" style="margin-top: 16px">
    <table>
      <thead>
        <tr><th>Base</th><th>Cron (UTC)</th><th>Rétention</th><th>Vérif</th><th>Active</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in list" :key="p.id">
          <td>{{ dbName(p.database_id) }}</td>
          <td><code>{{ p.schedule_cron }}</code></td>
          <td class="muted">
            {{ p.retention_count ? p.retention_count + " dern." : "" }}
            {{ p.retention_count && p.retention_days ? " / " : "" }}
            {{ p.retention_days ? p.retention_days + " j" : "" }}
            {{ !p.retention_count && !p.retention_days ? "illimitée" : "" }}
          </td>
          <td>{{ p.verify_after ? "oui" : "non" }}</td>
          <td><input type="checkbox" :checked="p.enabled === 1" @change="toggle(p)" /></td>
          <td style="white-space: nowrap">
            <button class="btn secondary" @click="runNow(p)">Exécuter</button>
            <button class="btn danger" style="margin-left: 6px" @click="remove(p.id)">×</button>
          </td>
        </tr>
        <tr v-if="!list.length"><td colspan="6" class="muted">Aucune planification.</td></tr>
      </tbody>
    </table>
  </div>
  </div>
</template>
