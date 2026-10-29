<script setup lang="ts">
import { useToasts } from "../store/toasts";
const toasts = useToasts();
</script>

<template>
  <div class="toast-host">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="t.level"
        @click="toasts.dismiss(t.id)"
      >
        <span class="toast-icon">
          {{ t.level === "success" ? "✓" : t.level === "error" ? "✕" : "▶" }}
        </span>
        <div class="toast-body">
          <div>{{ t.message }}</div>
          <RouterLink
            v-if="t.link"
            :to="t.link.to"
            class="toast-link"
            @click.stop
          >{{ t.link.label }}</RouterLink>
        </div>
        <span class="toast-close">×</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 18px;
  right: 18px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: min(380px, calc(100vw - 36px));
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  font-size: 14px;
}
.toast.success { border-left: 3px solid var(--accent); }
.toast.error { border-left: 3px solid var(--danger); }
.toast.info { border-left: 3px solid var(--accent-2); }
.toast-icon { font-weight: 700; }
.toast.success .toast-icon { color: var(--accent); }
.toast.error .toast-icon { color: var(--danger); }
.toast.info .toast-icon { color: var(--accent-2); }
.toast-body { flex: 1; }
.toast-link {
  display: inline-block;
  margin-top: 4px;
  font-size: 13px;
  font-weight: 600;
}
.toast-close { color: var(--muted); }

.toast-enter-active,
.toast-leave-active { transition: all 0.25s ease; }
.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>
