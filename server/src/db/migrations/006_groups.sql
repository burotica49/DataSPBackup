-- Groupes (dossiers) pour organiser la liste des bases.
CREATE TABLE db_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE databases ADD COLUMN group_id INTEGER;
CREATE INDEX idx_databases_group ON databases(group_id);
