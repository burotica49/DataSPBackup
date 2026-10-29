# Jalons et critères d'acceptation

## Jalon 1 — Fondations + cœur de vérification Supabase ✅ (en cours)

Squelette, Docker, serveur, sauvegarde logique, vérification préparée Supabase.

Critères d'acceptation :
- [x] `npm run build` compile serveur + web sans erreur de type.
- [x] Tests unitaires du catalogue d'erreurs et du parsing de TOC verts.
- [x] Déploiement `docker compose up` en un conteneur, interface sur :4005.
- [x] Aucun secret par défaut : le serveur refuse de démarrer sans `MASTER_KEY`.
- [ ] *(à valider en conditions réelles)* Sauvegarde d'une base Supabase PG15
      puis vérification réussie avec rôles + extensions préparés.

## Jalon 2 — Stockage distant + notifications

- Stockage S3 / Cloudflare R2 (upload/download streaming chiffré).
- Notifications Telegram + email (SMTP), cases succès/échec indépendantes.
- Rétention par durée et par nombre, application après chaque sauvegarde.

## Jalon 3 — Robustesse Supabase avancée

- Détection des dépendances inter-schémas (FK vers `auth.users`, triggers
  `private`) et avertissement explicite.
- Exigence de version de cible ≥ source (bloquer sinon).
- Image de vérification Supabase personnalisée + registre, avec repli.
- Comparaison de lignes schéma par schéma, tolérance configurable.

## Jalon 4 — Au-delà du dump

- Sauvegarde des volumes Docker (fichiers Supabase Storage) et du `.env`
  Supabase (JWT secret, clés `anon`/`service_role`).
- Agent de vérification sortant (HTTPS, jeton, file, budgets CPU/RAM/disque).
- Rétention GFS, plafonds de taille.
- Sauvegarde physique / WAL (PITR).
- Autres moteurs : MySQL, MariaDB, MongoDB.

## Décisions prises (§7 du contexte)

- Stack : **Node (TS) + Vue 3**.
- Vérification : **intégrée** au serveur (socket Docker), agent sortant = J4.
- Métadonnées : **SQLite**.
- Pilotage Docker : **API Docker** (dockerode).
