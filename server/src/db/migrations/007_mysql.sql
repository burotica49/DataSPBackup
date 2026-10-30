-- Version du serveur MySQL / MariaDB (chaîne VERSION()).
-- PostgreSQL continue d'utiliser pg_major.
ALTER TABLE databases ADD COLUMN server_version TEXT;
ALTER TABLE backups ADD COLUMN server_version TEXT;
