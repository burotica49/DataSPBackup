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
const testMsg = ref<Record<number, string>>({});

const blank = () => ({
  type: "telegram" as "telegram" | "email" | "webhook",
  name: "",
  on_start: true, on_success: true, on_failure: true, enabled: true,
  // champs de config selon le type
  telegram: { botToken: "", chatId: "" },
  webhook: { url: "" },
  email: { host: "", port: 587, secure: false, user: "", pass: "", from: "", to: "" },
});
const form = ref(blank());

async function load() {
  list.value = await api.get<Channel[]>("/api/notifications");
}
function openCreate() {
  form.value = blank();
  showForm.value = true;
}
function configForType() {
  if (form.value.type === "telegram") return form.value.telegram;
  if (form.value.type === "webhook") return form.value.webhook;
  return form.value.email;
}
async function create() {
  await api.post("/api/notifications", {
    type: form.value.type,
    name: form.value.name,
    config: configForType(),
    on_start: form.value.on_start,
    on_success: form.value.on_success,
    on_failure: form.value.on_failure,
    enabled: form.value.enabled,
  });
  showForm.value = false;
  await load();
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
    <h2>Nouveau canal</h2>
    <div class="row">
      <div>
        <label>Type</label>
        <select v-model="form.type">
          <option value="telegram">Telegram</option>
          <option value="webhook">Webhook</option>
          <option value="email">Email (SMTP)</option>
        </select>
      </div>
      <div><label>Nom</label><input v-model="form.name" placeholder="ex: Telegram ops" /></div>
    </div>

    <template v-if="form.type === 'telegram'">
      <div class="row">
        <div><label>Bot token</label><input v-model="form.telegram.botToken" /></div>
        <div><label>Chat ID</label><input v-model="form.telegram.chatId" /></div>
      </div>
    </template>
    <template v-else-if="form.type === 'webhook'">
      <label>URL</label><input v-model="form.webhook.url" placeholder="https://…" />
    </template>
    <template v-else>
      <div class="row">
        <div><label>Hôte SMTP</label><input v-model="form.email.host" /></div>
        <div><label>Port</label><input v-model="form.email.port" type="number" /></div>
      </div>
      <div class="row">
        <div><label>Utilisateur</label><input v-model="form.email.user" /></div>
        <div><label>Mot de passe</label><input v-model="form.email.pass" type="password" /></div>
      </div>
      <div class="row">
        <div><label>De</label><input v-model="form.email.from" placeholder="backup@domaine" /></div>
        <div><label>À</label><input v-model="form.email.to" placeholder="vous@domaine" /></div>
      </div>
    </template>

    <div style="display: flex; gap: 18px; margin-top: 14px; flex-wrap: wrap">
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.on_start" style="width: auto" /> Lancement</label>
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.on_success" style="width: auto" /> Succès</label>
      <label style="display: flex; gap: 6px; align-items: center"><input type="checkbox" v-model="form.on_failure" style="width: auto" /> Échec</label>
    </div>
    <div style="margin-top: 14px">
      <button class="btn" @click="create">Créer</button>
      <button class="btn secondary" style="margin-left: 8px" @click="showForm = false">Annuler</button>
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
            <button class="btn secondary" @click="test(c.id)">Tester</button>
            <button class="btn danger" style="margin-left: 6px" @click="remove(c.id)">×</button>
            <div v-if="testMsg[c.id]" class="muted" style="margin-top: 6px">{{ testMsg[c.id] }}</div>
          </td>
        </tr>
        <tr v-if="!list.length"><td colspan="7" class="muted">Aucun canal configuré.</td></tr>
      </tbody>
    </table>
  </div>
  </div>
</template>
