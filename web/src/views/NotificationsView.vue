<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToasts } from "../store/toasts";

const toasts = useToasts();

interface Channel {
  id: number; type: "telegram" | "email" | "webhook"; name: string;
  on_start: number; on_success: number; on_failure: number; enabled: number;
}
const list = ref<Channel[]>([]);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const testMsg = ref<Record<number, string>>({});

type ChannelType = "telegram" | "email" | "webhook";
interface FormState {
  type: ChannelType;
  name: string;
  on_start: boolean; on_success: boolean; on_failure: boolean; enabled: boolean;
  telegram: { botToken: string; chatId: string };
  webhook: { url: string };
  email: { host: string; port: number | ""; secure: boolean; user: string; pass: string; from: string; to: string };
}

const blank = (): FormState => ({
  type: "telegram",
  name: "",
  on_start: true, on_success: true, on_failure: true, enabled: true,
  telegram: { botToken: "", chatId: "" },
  webhook: { url: "" },
  email: { host: "", port: 587, secure: false, user: "", pass: "", from: "", to: "" },
});
const form = ref(blank());

async function load() {
  list.value = await api.get<Channel[]>("/api/notifications");
}
function openCreate() {
  editingId.value = null;
  form.value = blank();
  showForm.value = true;
}
function openEdit(c: Channel) {
  editingId.value = c.id;
  form.value = {
    type: c.type,
    name: c.name,
    on_start: c.on_start === 1,
    on_success: c.on_success === 1,
    on_failure: c.on_failure === 1,
    enabled: c.enabled === 1,
    telegram: { botToken: "", chatId: "" },
    webhook: { url: "" },
    email: { host: "", port: "", secure: false, user: "", pass: "", from: "", to: "" },
  };
  showForm.value = true;
}
function closeForm() {
  showForm.value = false;
  editingId.value = null;
}
function configForType(): Record<string, unknown> {
  if (form.value.type === "telegram") return { ...form.value.telegram };
  if (form.value.type === "webhook") return { ...form.value.webhook };
  return { ...form.value.email };
}
/** Champs saisis uniquement. En édition, un champ vide signifie « inchangé ». */
function filledConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(configForType())) {
    if (k === "secure") continue;
    if (k === "port") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      out.port = n;
      continue;
    }
    if (typeof v === "string") {
      const t = v.trim();
      if (t) out[k] = t;
      continue;
    }
    if (v === "" || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}
async function save() {
  const config = filledConfig();
  const flags = {
    name: form.value.name,
    on_start: form.value.on_start,
    on_success: form.value.on_success,
    on_failure: form.value.on_failure,
    enabled: form.value.enabled,
  };
  try {
    if (editingId.value) {
      await api.patch(`/api/notifications/${editingId.value}`, {
        ...flags,
        ...(Object.keys(config).length ? { config } : {}),
      });
      toasts.success("Canal enregistré");
    } else {
      await api.post("/api/notifications", { type: form.value.type, ...flags, config });
      toasts.success("Canal créé");
    }
    closeForm();
    await load();
  } catch (e) {
    toasts.error("Échec : " + ((e as { message?: string }).message ?? "erreur"));
  }
}
async function toggle(c: Channel, field: "on_start" | "on_success" | "on_failure" | "enabled") {
  await api.patch(`/api/notifications/${c.id}`, { [field]: c[field] === 0 });
  await load();
}
async function test(id: number) {
  testMsg.value[id] = "Envoi…";
  try {
    await api.post(`/api/notifications/${id}/test`);
    testMsg.value[id] = "Message de test envoyé ✓";
    toasts.success("Message de test envoyé");
  } catch (e) {
    const msg = (e as { message?: string }).message ?? "erreur";
    testMsg.value[id] = "Échec: " + msg;
    toasts.error("Échec du test : " + msg);
  }
}
async function remove(id: number) {
  if (!confirm("Supprimer ce canal ?")) return;
  await api.del(`/api/notifications/${id}`);
  await load();
}
onMounted(load);
</script>

<template>
  <div class="page">
  <h1>Notifications</h1>
  <p class="muted">Événements : lancement, succès et échec des sauvegardes et vérifications.</p>
  <button class="btn" @click="openCreate">Ajouter un canal</button>

  <div v-if="showForm" class="card" style="margin-top: 16px">
    <h2>{{ editingId ? "Modifier le canal" : "Nouveau canal" }}</h2>
    <div class="row">
      <div>
        <label>Type</label>
        <select v-model="form.type" :disabled="!!editingId">
          <option value="telegram">Telegram</option>
          <option value="webhook">Webhook</option>
          <option value="email">Email (SMTP)</option>
        </select>
      </div>
      <div><label>Nom</label><input v-model="form.name" placeholder="ex: Telegram ops" /></div>
    </div>
    <p v-if="editingId" class="muted" style="margin-top: 10px">Les champs de connexion vides conservent la valeur actuelle.</p>

    <template v-if="form.type === 'telegram'">
      <div class="row">
        <div><label>Bot token <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.telegram.botToken" type="password" autocomplete="off" /></div>
        <div><label>Chat ID <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.telegram.chatId" autocomplete="off" /></div>
      </div>
    </template>
    <template v-else-if="form.type === 'webhook'">
      <label>URL <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.webhook.url" placeholder="https://…" autocomplete="off" />
    </template>
    <template v-else>
      <div class="row">
        <div><label>Hôte SMTP <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.email.host" autocomplete="off" /></div>
        <div><label>Port <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.email.port" type="number" /></div>
      </div>
      <div class="row">
        <div><label>Utilisateur <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.email.user" autocomplete="off" /></div>
        <div><label>Mot de passe <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.email.pass" type="password" autocomplete="off" /></div>
      </div>
      <div class="row">
        <div><label>De <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.email.from" placeholder="backup@domaine" autocomplete="off" /></div>
        <div><label>À <span v-if="editingId" class="muted">(vide = inchangé)</span></label><input v-model="form.email.to" placeholder="vous@domaine" autocomplete="off" /></div>
      </div>
    </template>

    <div style="display: flex; gap: 18px; margin-top: 14px; flex-wrap: wrap">
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.on_start" style="width: auto" /> Lancement</label>
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.on_success" style="width: auto" /> Succès</label>
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.on_failure" style="width: auto" /> Échec</label>
    </div>
    <div style="margin-top: 14px">
      <button class="btn" @click="save">{{ editingId ? "Enregistrer" : "Créer" }}</button>
      <button class="btn secondary" style="margin-left: 8px" @click="closeForm">Annuler</button>
    </div>
  </div>

  <div class="card" style="margin-top: 16px">
    <table>
      <thead>
        <tr><th>Nom</th><th>Type</th><th>Lancement</th><th>Succès</th><th>Échec</th><th>Actif</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in list" :key="c.id">
          <td>{{ c.name }}</td>
          <td><code>{{ c.type }}</code></td>
          <td><input type="checkbox" :checked="c.on_start === 1" @change="toggle(c, 'on_start')" /></td>
          <td><input type="checkbox" :checked="c.on_success === 1" @change="toggle(c, 'on_success')" /></td>
          <td><input type="checkbox" :checked="c.on_failure === 1" @change="toggle(c, 'on_failure')" /></td>
          <td><input type="checkbox" :checked="c.enabled === 1" @change="toggle(c, 'enabled')" /></td>
          <td style="white-space: nowrap">
            <div style="display: flex; align-items: stretch; gap: 6px">
              <button class="icon-btn" title="Modifier" style="width: 35px; height: auto" @click="openEdit(c)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              </button>
              <button class="btn secondary" @click="test(c.id)">Tester</button>
              <button class="btn danger" @click="remove(c.id)">×</button>
            </div>
            <div v-if="testMsg[c.id]" class="muted" style="margin-top: 6px">{{ testMsg[c.id] }}</div>
          </td>
        </tr>
        <tr v-if="!list.length"><td colspan="7" class="muted">Aucun canal configuré.</td></tr>
      </tbody>
    </table>
  </div>
  </div>
</template>
