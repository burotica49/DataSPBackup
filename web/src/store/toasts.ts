import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastLevel = "info" | "success" | "error";
export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  link?: { to: string; label: string };
}

/** Notifications popup dans l'interface (toasts auto-dismiss). */
export const useToasts = defineStore("toasts", () => {
  const items = ref<Toast[]>([]);
  let seq = 0;

  function dismiss(id: number): void {
    items.value = items.value.filter((t) => t.id !== id);
  }

  function push(
    message: string,
    level: ToastLevel = "info",
    opts: { timeout?: number; link?: Toast["link"] } = {},
  ): number {
    const id = ++seq;
    items.value.push({ id, message, level, link: opts.link });
    const timeout = opts.timeout ?? (level === "error" ? 9000 : 5000);
    if (timeout > 0) window.setTimeout(() => dismiss(id), timeout);
    return id;
  }

  const info = (m: string, link?: Toast["link"]) => push(m, "info", { link });
  const success = (m: string, link?: Toast["link"]) =>
    push(m, "success", { link });
  const error = (m: string, link?: Toast["link"]) => push(m, "error", { link });

  return { items, push, dismiss, info, success, error };
});
