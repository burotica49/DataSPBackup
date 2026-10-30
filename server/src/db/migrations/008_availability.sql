-- Surveillance de disponibilité : réglages par base + historique des tentatives.
ALTER TABLE databases ADD COLUMN avail_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN avail_notify INTEGER NOT NULL DEFAULT 1;
ALTER TABLE databases ADD COLUMN avail_interval_min INTEGER NOT NULL DEFAULT 1;
ALTER TABLE databases ADD COLUMN avail_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE databases ADD COLUMN avail_history_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE databases ADD COLUMN avail_fail_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN avail_down INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN avail_last_check_at TEXT;

CREATE TABLE availability_checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id  INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  ok           INTEGER NOT NULL,             -- 1 joignable, 0 échec
  latency_ms   INTEGER,
  error        TEXT,
  checked_at   TEXT NOT NULL
);
CREATE INDEX idx_availability_db_time ON availability_checks(database_id, checked_at);
