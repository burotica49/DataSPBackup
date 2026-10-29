-- Préférences de notification par politique (configuration des sauvegardes).
ALTER TABLE backup_policies ADD COLUMN notify_success INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backup_policies ADD COLUMN notify_failure INTEGER NOT NULL DEFAULT 1;
