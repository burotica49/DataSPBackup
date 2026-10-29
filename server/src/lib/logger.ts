import pino from "pino";

/**
 * Logger partagé.
 *
 * Secrets : ne JAMAIS logger de mot de passe, jeton, DSN complet ou clé.
 * `redact` masque les champs sensibles si un objet en contient par mégarde.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "secret",
      "*.secret",
      "connectionString",
      "*.connectionString",
      "dsn",
      "*.dsn",
      "masterKey",
      "*.masterKey",
    ],
    censor: "[redacted]",
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino/file", options: { destination: 1 } },
});

export type Logger = typeof logger;
