<script setup lang="ts">
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "./store/auth";
import { useActivity } from "./store/activity";
import ToastHost from "./components/ToastHost.vue";
import { version } from "../../package.json";

const auth = useAuth();
const activity = useActivity();
const router = useRouter();
const loggedIn = computed(() => !!auth.user);

watch(loggedIn, (v) => (v ? activity.start() : activity.stop()), {
  immediate: true,
});

async function logout() {
  await auth.logout();
  router.push({ name: "login" });
}
</script>

<template>
  <div v-if="loggedIn" class="app">
    <header class="topbar">
      <div class="logo">D</div>
      <div class="brand">DataSP<span>Backup</span><small class="ver">v{{ version }}</small></div>
      <div class="spacer"></div>
      <!-- <span class="top-link">Sauvegarde PostgreSQL + vérification Supabase</span> -->
      <span class="user">{{ auth.user?.email }}</span>
      <button class="btn secondary" @click="logout">Déconnexion</button>
    </header>

    <div class="body">
      <nav class="rail">
        <RouterLink to="/" title="Bases">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
          </svg>
        </RouterLink>
        <RouterLink to="/planification" title="Planification">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </RouterLink>
        <RouterLink to="/notifications" title="Notifications">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
        </RouterLink>
        <RouterLink to="/settings" title="Réglages">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 2.6 15H2.5a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.2 9 1.6 1.6 0 0 0 4 7.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6h.1A1.6 1.6 0 0 0 11 3V2.9a2 2 0 1 1 4 0V3a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 9v.1a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.6 1z" />
          </svg>
        </RouterLink>
        <div class="rail-spacer"></div>
      </nav>

      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
  <RouterView v-else />
  <ToastHost />
</template>
