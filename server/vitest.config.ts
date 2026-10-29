import { defineConfig } from "vitest/config";

// Secrets éphémères pour les tests uniquement. La validation stricte des
// secrets reste active au démarrage réel du serveur (voir src/config.ts).
export default defineConfig({
  test: {
    env: {
      MASTER_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      JWT_SECRET: "test-jwt-secret",
      DATA_DIR: "/tmp/dataspbackup-test",
    },
  },
});
