-- Schéma initial de dataspbackup (métadonnées).
-- Aucun secret en clair : les mots de passe de connexion et les configs de
-- stockage/notification sont stockés chiffrés (colonnes *_enc).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner', -- owner|admin|member|viewer
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bases surveillées (sources à sauvegarder).
CREATE TABLE databases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  engine           TEXT NOT NULL DEFAULT 'postgres',
  host             TEXT NOT NULL,
  port             INTEGER NOT NULL DEFAULT 5432,
  db_name          TEXT NOT NULL,
  username         TEXT NOT NULL,
  password_enc     TEXT NOT NULL,            -- AES-256-GCM
  ssl_mode         TEXT NOT NULL DEFAULT 'prefer',
  included_schemas TEXT NOT NULL DEFAULT '[]', -- JSON array; [] = toutes
  is_supabase      INTEGER NOT NULL DEFAULT 0,
  pg_major         INTEGER,                   -- détecté à la connexion
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Destinations de stockage des archives.
CREATE TABLE storages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,                  -- local|s3
  config_enc TEXT NOT NULL DEFAULT '',       -- JSON chiffré (clés S3, etc.)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Politiques de sauvegarde planifiées.
CREATE TABLE backup_policies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id     INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  storage_id      INTEGER NOT NULL REFERENCES storages(id),
  schedule_cron   TEXT NOT NULL,             -- expression cron (UTC)
  retention_count INTEGER,                   -- garder N dernières
  retention_days  INTEGER,                   -- garder N jours
  compression     TEXT NOT NULL DEFAULT 'zstd', -- none|gzip|zstd (format custom pg)
  encrypt         INTEGER NOT NULL DEFAULT 1,
  verify_after    INTEGER NOT NULL DEFAULT 1, -- vérifier après chaque sauvegarde
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sauvegardes produites.
CREATE TABLE backups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id  INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  policy_id    INTEGER REFERENCES backup_policies(id) ON DELETE SET NULL,
  storage_id   INTEGER REFERENCES storages(id),
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|running|success|failed
  trigger      TEXT NOT NULL DEFAULT 'manual',  -- manual|schedule
  started_at   TEXT,
  finished_at  TEXT,
  size_bytes   INTEGER,
  file_path    TEXT,                           -- chemin dans le stockage
  encrypted    INTEGER NOT NULL DEFAULT 0,
  pg_major     INTEGER,
  schemas_json TEXT,                           -- schémas inclus réellement
  checksum     TEXT,                           -- sha256 du fichier produit
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_backups_database ON backups(database_id);
CREATE INDEX idx_backups_created ON backups(created_at);

-- Vérifications de restauration.
CREATE TABLE verifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id          INTEGER NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  database_id        INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|running|success|failed|canceled
  trigger            TEXT NOT NULL DEFAULT 'after_backup',
  started_at         TEXT,
  finished_at        TEXT,
  exit_code          INTEGER,
  restored_size_bytes INTEGER,
  schema_count       INTEGER,
  table_count        INTEGER,
  row_counts_json    TEXT,   -- {schema.table: count}
  errors_json        TEXT,   -- erreurs catégorisées [{category, count, sample}]
  root_error         TEXT,   -- première erreur d'origine (pas la fin du flux)
  report_json        TEXT,   -- rapport complet lisible
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_verifications_backup ON verifications(backup_id);

-- Canaux de notification.
CREATE TABLE notification_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,                 -- telegram|email|webhook
  name        TEXT NOT NULL,
  config_enc  TEXT NOT NULL DEFAULT '',      -- JSON chiffré
  on_success  INTEGER NOT NULL DEFAULT 0,
  on_failure  INTEGER NOT NULL DEFAULT 1,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Réglages clé/valeur divers.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
