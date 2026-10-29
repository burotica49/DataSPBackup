<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../lib/api";
import { useToasts } from "../store/toasts";

const route = useRoute();
const router = useRouter();
const toasts = useToasts();

interface Backup {
  id: number; database_id: number; status: string; trigger: string;
  size_bytes: number | null; pg_major: number | null; created_at: string;
  started_at: string | null; finished_at: string | null; encrypted: number;
  file_path: string | null; checksum: string | null; schemas_json: string | null; error: string | null;
}
interface Verif { id: number; status: string; }

const b = ref<Backup | null>(null);
const verif = ref<Verif | null>(null);
let timer: number | undefined;

function parse(d: string | null) { if (!d) return NaN; return Date.parse(/[TZ]/.test(d) ? d : d + "Z"); }
function fmtDate(d: string | null): string { const t = parse(d); return isNaN(t) ? "—" : new Date(t).toLocaleString(); }
function fmtDuration(a: string | null, c: string | null): string {
  const s = parse(a), e = parse(c); if (isNaN(s) || isNaN(e)) return "—";
  const d = Math.max(0, Math.round((e - s) / 1000));
  return d >= 60 ? `${Math.floor(d / 60)}m ${d % 60}s` : `${d}s`;
}
function fmtSize(n: number | null): string {
  if (!n) return "—";
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(2)} Mo` : `${(n / 1024).toFixed(0)} Ko`;
}
function statusLabel(s: string): string {
  return s === "success" ? "Réussie" : s === "failed" ? "Échouée" : s === "running" ? "En cours" : s === "pending" ? "En attente" : s;
}

async function load() {
  b.value = await api.get<Backup>(`/api/backups/${route.params.id}`);
  const vs = await api.get<Verif[]>(`/api/verifications?backup_id=${route.params.id}`);
  verif.value = vs[0] ?? null;
  if (b.value && (b.value.status === "running" || b.value.status === "pending")) {
    timer = window.setTimeout(load, 1500);
  }
}
async function verifyNow() {
  if (!b.value) return;
  try {
    await api.post(`/api/backups/${b.value.id}/verify`);
    toasts.info("Vérification lancée");
    setTimeout(load, 800);
  } catch (e) { toasts.error("Échec : " + (e as { message?: string }).message); }
}
onMounted(load);
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div class="page">
    <button class="btn secondary" style="margin-bottom:16px" @click="router.back()">← Retour</button>

    <div v-if="b">
      <h1 style="display:flex;align-items:center;gap:12px">
        Sauvegarde #{{ b.id }}
        <span class="badge" :class="b.status">{{ statusLabel(b.status) }}</span>
      </h1>

      <div class="row" style="margin-top:16px">
        <div class="card"><div class="muted">Taille</div><div style="font-size:22px;font-weight:700">{{ fmtSize(b.size_bytes) }}</div></div>
        <div class="card"><div class="muted">Durée</div><div style="font-size:22px;font-weight:700">{{ fmtDuration(b.started_at, b.finished_at) }}</div></div>
        <div class="card"><div class="muted">Version PG</div><div style="font-size:22px;font-weight:700">{{ b.pg_major ?? "—" }}</div></div>
      </div>

      <div class="card">
        <h2>Détails</h2>
        <div class="field"><span class="k">Statut</span><span class="v"><span class="badge" :class="b.status">{{ statusLabel(b.status) }}</span></span></div>
        <div class="field"><span class="k">Déclenchement</span><span class="v">{{ b.trigger }}</span></div>
        <div class="field"><span class="k">Créée le</span><span class="v">{{ fmtDate(b.created_at) }}</span></div>
        <div class="field"><span class="k">Démarrée</span><span class="v">{{ fmtDate(b.started_at) }}</span></div>
        <div class="field"><span class="k">Terminée</span><span class="v">{{ fmtDate(b.finished_at) }}</span></div>
        <div class="field"><span class="k">Chiffrement</span><span class="v">{{ b.encrypted ? "AES-256-GCM" : "Non chiffrée" }}</span></div>
        <div class="field"><span class="k">Schémas</span><span class="v">{{ b.schemas_json ? (JSON.parse(b.schemas_json).join(", ") || "toutes") : "—" }}</span></div>
        <div class="field"><span class="k">Fichier</span><span class="v"><code v-if="b.file_path">{{ b.file_path }}</code><span v-else>—</span></span></div>
        <div class="field"><span class="k">Checksum (sha256)</span><span class="v"><code v-if="b.checksum">{{ b.checksum }}</code><span v-else>—</span></span></div>
      </div>

      <div v-if="b.error" class="card" style="border-color:var(--danger)">
        <h2 style="color:var(--danger)">Erreur</h2>
        <code style="display:block;white-space:pre-wrap">{{ b.error }}</code>
      </div>

      <div class="card">
        <h2>Vérification de restauration</h2>
        <template v-if="verif">
          <p>Statut : <span class="badge" :class="verif.status">{{ verif.status === 'success' ? 'Réussie' : verif.status === 'failed' ? 'Échouée' : verif.status }}</span></p>
          <RouterLink class="btn secondary" :to="`/verifications/${verif.id}`">Voir le rapport</RouterLink>
        </template>
        <template v-else>
          <p class="muted">Aucune vérification pour cette sauvegarde.</p>
          <button v-if="b.status==='success'" class="btn" @click="verifyNow">Vérifier maintenant</button>
        </template>
      </div>
    </div>
    <p v-else class="muted">Chargement…</p>
  </div>
</template>
