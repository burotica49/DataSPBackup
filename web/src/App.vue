<script setup lang="ts">
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "./store/auth";
import { useActivity } from "./store/activity";
import AppLogo from "./components/AppLogo.vue";
import ToastHost from "./components/ToastHost.vue";
import { homepage, repository, version } from "../../package.json";

// Liens de la topbar : issus du package.json (une seule source à maintenir).
const repoUrl = repository.url.replace(/\.git$/, "");
const docsUrl = homepage;

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
      <div class="brand-lockup">
        <AppLogo />
        <div class="brand">DataSP<span>Backup</span><small class="ver">v{{ version }}</small></div>
      </div>
      <div class="spacer"></div>
      <!-- <span class="top-link">Sauvegarde PostgreSQL + vérification Supabase</span> -->
      <span class="user">{{ auth.user?.email }}</span>
      <div class="top-actions">
        <a class="icon-btn" :href="repoUrl" target="_blank" rel="noopener noreferrer" title="Dépôt GitHub" aria-label="Dépôt GitHub">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
        <a class="icon-btn" :href="docsUrl" target="_blank" rel="noopener noreferrer" title="Documentation (README)" aria-label="Documentation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
        </a>
      </div>
      <button class="btn secondary" @click="logout">Déconnexion</button>
    </header>

    <div class="body">
      <nav class="rail">
        <RouterLink to="/" title="Bases">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
          </svg>
          <span class="rail-label">Bases</span>
        </RouterLink>
        <RouterLink to="/planification" title="Planification">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          <span class="rail-label">Planning</span>
        </RouterLink>
        <RouterLink to="/notifications" title="Notifications">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          <span class="rail-label">Alertes</span>
        </RouterLink>
        <RouterLink to="/settings" title="Réglages">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span class="rail-label">Réglages</span>
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
