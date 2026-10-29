import { createRouter, createWebHistory } from "vue-router";
import { useAuth } from "../store/auth";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("../views/LoginView.vue"),
      meta: { public: true },
    },
    {
      path: "/",
      name: "databases",
      component: () => import("../views/DatabasesView.vue"),
    },
    {
      path: "/planification",
      name: "planification",
      component: () => import("../views/PlanificationView.vue"),
    },
    {
      path: "/notifications",
      name: "notifications",
      component: () => import("../views/NotificationsView.vue"),
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("../views/SettingsView.vue"),
    },
    {
      path: "/backups/:id",
      redirect: (to) => ({ path: "/", query: { detail: "backup", id: String(to.params.id) } }),
    },
    {
      path: "/verifications/:id",
      redirect: (to) => ({ path: "/", query: { detail: "verification", id: String(to.params.id) } }),
    },
    {
      path: "/restores/:id",
      redirect: (to) => ({ path: "/", query: { detail: "restore", id: String(to.params.id) } }),
    },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.ready) await auth.fetchMe();
  if (!to.meta.public && !auth.user) return { name: "login" };
  if (to.name === "login" && auth.user) return { name: "databases" };
  return true;
});

export default router;
