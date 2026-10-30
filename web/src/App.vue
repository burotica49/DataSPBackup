<script setup lang="ts">
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "./store/auth";
import { useActivity } from "./store/activity";
import AppLogo from "./components/AppLogo.vue";
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
      <div class="brand-lockup">
        <AppLogo />
        <div class="brand">DataSP<span>Backup</span><small class="ver">v{{ version }}</small></div>
      </div>
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
