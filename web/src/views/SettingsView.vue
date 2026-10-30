<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToasts } from "../store/toasts";

const toasts = useToasts();
const MAJORS = ["14", "15", "16", "17", "18"];

interface VerifyImages {
  map: Record<string, string>;
  env_map: Record<string, string>;
  default_template: string;
  fallback_template: string;
}

const info = ref<VerifyImages | null>(null);
const map = ref<Record<string, string>>({});

async function load() {
  info.value = await api.get<VerifyImages>("/api/settings/verify-images");
  const m: Record<string, string> = {};
  for (const maj of MAJORS) m[maj] = info.value.map[maj] ?? "";
  map.value = m;
}
async function save() {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(map.value)) if (v.trim()) clean[k] = v.trim();
  try {
    await api.put("/api/settings/verify-images", { map: clean });
    toasts.success("Images de vérification enregistrées");
    await load();
  } catch (e) {
    toasts.error("Échec : " + (e as { message?: string }).message);
  }
}

// ---- export / import ----
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
async function exportConfig() {
  try {
    const data = await api.get<unknown>("/api/settings/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dataspbackup-config.json";
    a.click();
    URL.revokeObjectURL(url);
    toasts.success("Configuration exportée");
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
function triggerImport() { fileInput.value?.click(); }
async function onImport(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const json = JSON.parse(await file.text());
    const res = await api.post<{ summary: Record<string, number> }>("/api/settings/import", json);
    const s = res.summary;
    toasts.success(`Importé : ${s.databases} base(s), ${s.groups ?? 0} groupe(s), ${s.storages} stockage(s), ${s.policies} planif(s), ${s.channels} canal(aux)`);
    await load();
  } catch (e) {
    toasts.error("Import échoué : " + (e as { message?: string }).message);
  } finally {
    importing.value = false;
    input.value = "";
  }
}
onMounted(load);
</script>

<template>
  <div class="page">
  <h1>Réglages</h1>

  <div class="card" style="margin-top: 18px">
    <h2>Export / import de configuration</h2>
    <p class="muted">
      Exporte les bases, groupes, stockages, planifications, canaux de notification et
      réglages, <strong>sans les secrets</strong> (mots de passe, jetons).
      Après un import, re-saisis les mots de passe des bases et les jetons des
      canaux avant utilisation. Les entités dont le nom existe déjà sont ignorées.
    </p>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn" @click="exportConfig">Exporter la configuration</button>
      <button class="btn secondary" :disabled="importing" @click="triggerImport">
        {{ importing ? "Import…" : "Importer un fichier" }}
      </button>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display:none" @change="onImport" />
    </div>
  </div>

  <div class="card" v-if="info">
    <h2>Image de vérification par version PostgreSQL</h2>
    <p class="muted">
      Par défaut : <code>{{ info.default_template }}</code>
      (PostGIS + contrib), repli <code>{{ info.fallback_template }}</code>.
      Pour couvrir les extensions internes Supabase (pgsodium, supabase_vault,
      pg_graphql…), indiquer ici une image Supabase complète correspondant à la
      version majeure de la source. Priorité à cette valeur, puis l'image par
      défaut. <code>{major}</code> est remplacé par la version si présent.
    </p>
    <div class="row" v-for="maj in ['14','15','16','17','18']" :key="maj" style="align-items: flex-end">
      <div style="max-width: 90px">
        <label>PG {{ maj }}</label>
        <input :value="maj" disabled />
      </div>
      <div style="flex: 4">
        <label>Image</label>
        <input v-model="map[maj]" :placeholder="`ex: supabase/postgres:${maj}.8.1.060`" />
      </div>
    </div>
    <button class="btn" style="margin-top: 14px" @click="save">Enregistrer</button>
    <p class="muted" style="margin-top: 10px">
      Astuce : une image Supabase correspond à ta version Supabase ; elle tourne
      en natif (arm64) sans émulation. Sinon l'image PostGIS par défaut suffit si
      tes bases n'utilisent pas ces extensions internes.
    </p>
  </div>
  </div>
</template>
