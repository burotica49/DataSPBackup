<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../lib/api";

interface CatError {
  category: string; count: number; sample: string; hint: string; blocking: boolean;
}
interface Verif {
  id: number; status: string; exit_code: number | null;
  schema_count: number | null; table_count: number | null;
  restored_size_bytes: number | null; root_error: string | null;
  row_counts: Record<string, number>;
  errors: CatError[];
  report: any;
}

const route = useRoute();
const router = useRouter();
const v = ref<Verif | null>(null);
let timer: number | undefined;

async function load() {
  v.value = await api.get<Verif>(`/api/verifications/${route.params.id}`);
  if (v.value && !["success", "failed", "canceled"].includes(v.value.status)) {
    timer = window.setTimeout(load, 1500);
  }
}
onMounted(load);
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div class="page">
  <button class="btn secondary" style="margin-bottom:16px" @click="router.back()">← Retour</button>
  <div v-if="v">
    <h1>
      Vérification #{{ v.id }}
      <span class="badge" :class="v.status" style="margin-left: 10px">{{ v.status }}</span>
    </h1>

    <div class="row">
      <div class="card"><div class="muted">Schémas</div><div style="font-size: 24px; font-weight: 700">{{ v.schema_count ?? "—" }}</div></div>
      <div class="card"><div class="muted">Tables</div><div style="font-size: 24px; font-weight: 700">{{ v.table_count ?? "—" }}</div></div>
      <div class="card"><div class="muted">Code de sortie pg_restore</div><div style="font-size: 24px; font-weight: 700">{{ v.exit_code ?? "—" }}</div></div>
    </div>

    <div v-if="v.report" class="card">
      <h2>Cible jetable</h2>
      <p class="muted">Image : <code>{{ v.report.image }}</code>
        <span v-if="v.report.bundledImage === false" class="badge warn" style="margin-left:8px">repli postgres standard</span>
      </p>
      <p v-if="v.report.prep">
        Préparé : {{ v.report.prep.roles?.length }} rôles,
        {{ v.report.prep.extensions?.length }} extensions
        <span v-if="v.report.prep.extensions?.length">(<code>{{ v.report.prep.extensions.join(", ") }}</code>)</span>
      </p>
    </div>

    <div v-if="v.root_error" class="card" style="border-color: var(--danger)">
      <h2 style="color: var(--danger)">Erreur d'origine</h2>
      <code style="display: block; white-space: pre-wrap">{{ v.root_error }}</code>
    </div>

    <div v-if="v.errors?.length" class="card">
      <h2>Erreurs catégorisées</h2>
      <table>
        <thead><tr><th>Catégorie</th><th>Nb</th><th>Type</th><th>Diagnostic</th></tr></thead>
        <tbody>
          <tr v-for="e in v.errors" :key="e.category">
            <td><code>{{ e.category }}</code></td>
            <td>{{ e.count }}</td>
            <td><span class="badge" :class="e.blocking ? 'failed' : 'success'">{{ e.blocking ? "bloquant" : "bénin" }}</span></td>
            <td class="muted">{{ e.hint }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="v.report?.comparison" class="card">
      <h2>Comparaison avec la source</h2>
      <p v-if="v.report.comparison.withinTolerance" class="badge success">dans la tolérance</p>
      <table v-if="v.report.comparison.diffs?.length" style="margin-top: 10px">
        <thead><tr><th>Table</th><th>Source</th><th>Restauré</th></tr></thead>
        <tbody>
          <tr v-for="d in v.report.comparison.diffs" :key="d.table">
            <td><code>{{ d.table }}</code></td><td>{{ d.source }}</td><td>{{ d.restored }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="v.report?.timeline" class="card">
      <h2>Chronologie</h2>
      <div v-for="(t, i) in v.report.timeline" :key="i" class="muted">
        {{ new Date(t.at).toLocaleTimeString() }} — {{ t.step }}
      </div>
    </div>

    <div v-if="Object.keys(v.row_counts || {}).length" class="card">
      <h2>Lignes par table (restauré)</h2>
      <table>
        <thead><tr><th>Table</th><th>Lignes</th></tr></thead>
        <tbody>
          <tr v-for="(c, t) in v.row_counts" :key="t"><td><code>{{ t }}</code></td><td>{{ c }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <p v-else class="muted">Chargement…</p>
  </div>
</template>
