-- Opérations de restauration (vers une base existante ou une nouvelle base).
CREATE TABLE restores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id     INTEGER NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL,                 -- existing|new
  target_label  TEXT NOT NULL,                 -- ex: "db@hôte" (pas de secret)
  status        TEXT NOT NULL DEFAULT 'pending',-- pending|running|success|failed
  exit_code     INTEGER,
  root_error    TEXT,
  errors_json   TEXT,
  report_json   TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_restores_backup ON restores(backup_id);
