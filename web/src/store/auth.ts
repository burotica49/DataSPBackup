import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../lib/api";

export interface User {
  id: number;
  email: string;
  role: string;
}

export const useAuth = defineStore("auth", () => {
  const user = ref<User | null>(null);
  const ready = ref(false);

  async function fetchMe(): Promise<void> {
    try {
      const res = await api.get<{ user: User }>("/api/auth/me");
      user.value = res.user;
    } catch {
      user.value = null;
    } finally {
      ready.value = true;
    }
  }

  async function login(email: string, password: string): Promise<void> {
    const res = await api.post<{ user: User }>("/api/auth/login", {
      email,
      password,
    });
    user.value = res.user;
  }

  async function logout(): Promise<void> {
    await api.post("/api/auth/logout");
    user.value = null;
  }

  return { user, ready, fetchMe, login, logout };
});
