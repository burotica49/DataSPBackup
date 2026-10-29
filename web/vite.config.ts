import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // En dev, proxy des appels API vers le serveur Fastify.
    proxy: {
      "/api": "http://localhost:4005",
    },
  },
  build: {
    outDir: "dist",
  },
});
