-- Filtres de pg_dump (schémas déjà présents) : tables, données, user mappings.
ALTER TABLE databases ADD COLUMN excluded_tables TEXT NOT NULL DEFAULT '[]';
ALTER TABLE databases ADD COLUMN excluded_table_data TEXT NOT NULL DEFAULT '[]';
ALTER TABLE databases ADD COLUMN ignore_user_mappings INTEGER NOT NULL DEFAULT 0;
