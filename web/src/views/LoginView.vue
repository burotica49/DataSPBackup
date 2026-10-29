<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../store/auth";
import type { ApiError } from "../lib/api";
import { version } from "../../package.json";

const auth = useAuth();
const router = useRouter();
const email = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    await auth.login(email.value, password.value);
    router.push({ name: "databases" });
  } catch (e) {
    error.value = (e as ApiError).message ?? "Échec de connexion";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="center-screen">
    <form class="card login-box" @submit.prevent="submit">
      <div class="brand">DataSP<span>Backup</span><small class="ver">v{{ version }}</small></div>
      <!-- <p class="muted">Sauvegarde PostgreSQL + vérification Supabase</p> -->
      <label>Email</label>
      <input v-model="email" type="email" autocomplete="username" />
      <label>Mot de passe</label>
      <input v-model="password" type="password" autocomplete="current-password" />
      <button class="btn" style="width: 100%; margin-top: 16px" :disabled="busy">
        {{ busy ? "Connexion…" : "Se connecter" }}
      </button>
      <div v-if="error" class="err">{{ error }}</div>
    </form>
  </div>
</template>
