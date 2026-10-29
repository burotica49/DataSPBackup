<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { api } from "../lib/api";

const props = defineProps<{ id: number }>();
const emit = defineEmits<{
  open: [kind: "backup", id: number];
  focus: [databaseId: number];
}>();

interface CatError { category: string; count: number; sample: string; hint: string; blocking: boolean; }
interface Restore {
  id: number; backup_id: number; mode: string; target_label: string; status: string;
  exit_code: number | null; root_error: string | null;
  errors: CatError[]; report: any;
}

const r = ref<Restore | null>(null);
let timer: number | undefined;

function statusLabel(s: string): string {
  return s === "success" ? "Réussie" : s === "failed" ? "Échouée" : s === "running" ? "En cours" : s;
}

async function load() {
  clearTimeout(timer);
  r.value = await api.get<Restore>(`/api/restores/${props.id}`);
  try {
    const backup = await api.get<{ database_id: number }>(`/api/backups/${r.value.backup_id}`);
    emit("focus", backup.database_id);
  } catch { /* la base affichée derrière reste celle en cours */ }
  if (!["success", "failed"].includes(r.value.status)) {
    timer = window.setTimeout(load, 1500);
  }
}
watch(() => props.id, () => { r.value = null; load(); }, { immediate: true });
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div v-if="r">
    <h2 style="display:flex;align-items:center;gap:12px;padding-right:36px">
      Restauration #{{ r.id }}
      <span class="badge" :class="r.status">{{ statusLabel(r.status) }}</span>
    </h2>

    <div class="card">
      <div class="field"><span class="k">Destination</span><span class="v">{{ r.target_label }}</span></div>
      <div class="field"><span class="k">Mode</span><span class="v">{{ r.mode === 'existing' ? 'Base existante' : 'Nouvelle base' }}</span></div>
      <div class="field">
        <span class="k">Sauvegarde source</span>
        <span class="v"><button class="text-btn" style="color:var(--primary)" @click="emit('open', 'backup', r.backup_id)">#{{ r.backup_id }}</button></span>
      </div>
      <div class="field"><span class="k">Code pg_restore</span><span class="v">{{ r.exit_code ?? '—' }}</span></div>
    </div>

    <div v-if="r.root_error" class="card" style="border-color:var(--danger)">
      <h2 style="color:var(--danger)">Erreur d'origine</h2>
      <code style="display:block;white-space:pre-wrap">{{ r.root_error }}</code>
    </div>

    <div v-if="r.errors?.length" class="card">
      <h2>Erreurs catégorisées</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Catégorie</th><th>Nb</th><th>Type</th><th>Diagnostic</th></tr></thead>
          <tbody>
            <tr v-for="e in r.errors" :key="e.category">
              <td><code>{{ e.category }}</code></td>
              <td>{{ e.count }}</td>
              <td><span class="badge" :class="e.blocking ? 'failed' : 'success'">{{ e.blocking ? 'bloquant' : 'bénin' }}</span></td>
              <td class="muted">{{ e.hint }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="r.report" class="card">
      <h2>Détails</h2>
      <div v-if="r.report.prep">Préparé : {{ r.report.prep.roles?.length ?? 0 }} rôles, {{ r.report.prep.extensions?.length ?? 0 }} extensions</div>
      <div v-if="r.report.createdbCode !== null && r.report.createdbCode !== undefined" class="muted" style="margin-top:6px">Création de base : code {{ r.report.createdbCode }}</div>
      <div v-if="r.report.timeline" style="margin-top:10px">
        <div v-for="(t, i) in r.report.timeline" :key="i" class="muted">{{ new Date(t.at).toLocaleTimeString() }} — {{ t.step }}</div>
      </div>
    </div>
  </div>
  <p v-else class="muted">Chargement…</p>
</template>
