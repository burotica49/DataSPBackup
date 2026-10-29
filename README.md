# dataspbackup

Application web auto-hébergée de **sauvegarde PostgreSQL** avec une
**vérification de restauration fiable pour Supabase** : chaque sauvegarde peut
être restaurée dans un **conteneur PostgreSQL jetable préparé pour Supabase**
(rôles `anon`/`authenticated`/`service_role`, schéma `extensions`, extensions
détectées comme PostGIS / `uuid-ossp`), puis comparée à la source, et le
conteneur est détruit.

> Licence Apache-2.0. Projet écrit à partir d'un cahier des charges, sans
> reprise de code de Databasus / Databasement / Portabase.

## Pourquoi

Un PostgreSQL vierge ne suffit pas à restaurer une base Supabase : rôles
manquants, schémas `auth`/`storage`/`private`, extensions, conflit
`DROP SCHEMA public` avec PostGIS… `dataspbackup` prépare la cible avant la
restauration, distingue les erreurs **bloquantes** des erreurs **bénignes**
(au lieu de tout marquer en échec sur le code de sortie 1 de `pg_restore`), et
remonte l'**erreur d'origine** plutôt que la seule fin du flux.

## Architecture (MVP)

| Brique | Choix |
|---|---|
| Serveur + API | Node.js / TypeScript (Fastify) |
| Interface | Vue 3 + Vite (servie en statique par le serveur) |
| Métadonnées | SQLite (fichier dans le volume de données) |
| Vérification | Intégrée : le serveur pilote Docker via le socket pour créer/détruire les conteneurs jetables |
| Sauvegarde | `pg_dump -Fc` exécuté dans un conteneur PostgreSQL **de la version exacte** de la source |
| Chiffrement | AES-256-GCM (sauvegardes + secrets stockés) |

`pg_dump` et `pg_restore` ne sont pas embarqués dans l'image : ils tournent
dans des conteneurs PostgreSQL versionnés pilotés via le socket Docker, ce qui
évite tout problème d'appariement de version et garde l'image légère.

## Déploiement (Docker)

```bash
cp .env.example .env
# Générer les secrets :
echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
# Définir ADMIN_PASSWORD dans .env

docker compose up -d --build
```

L'interface est sur `http://localhost:4005`. Connexion avec `ADMIN_EMAIL` /
`ADMIN_PASSWORD`.

### Dokploy

Déployer par `docker-compose.yml`. Points d'attention :
- monter le socket Docker (`/var/run/docker.sock`) — requis pour la vérification ;
- fournir les variables `MASTER_KEY`, `JWT_SECRET`, `ADMIN_PASSWORD` ;
- la variable `VERIFY_DATA_VOLUME` doit correspondre au **nom réel** du volume
  tel que vu par le démon Docker (les conteneurs jetables le montent pour lire
  les archives).

## Développement

Les scripts d'installation natifs (`better-sqlite3`, `esbuild`) doivent pouvoir
s'exécuter — lancer `npm install` dans un terminal normal (hors bac à sable).

```bash
npm install
# Secrets éphémères de dev :
export DEV_ALLOW_EPHEMERAL_SECRETS=1 DATA_DIR=./data ADMIN_PASSWORD=dev
npm run dev:server   # API sur :4005
npm run dev:web      # UI sur :5173 (proxy /api -> :4005)
npm test             # tests unitaires (serveur)
```

## Flux d'une vérification

1. L'archive est rendue lisible en clair dans le volume (déchiffrée si besoin).
2. Choix de l'image : `supabase/postgres:<major>` (extensions embarquées),
   repli sur `postgres:<major>`.
3. Introspection de l'archive (`pg_restore -l`) : schémas, extensions, rôles.
4. Démarrage d'un PostgreSQL jetable.
5. Base cible **vide** (pas de `--clean`, donc pas de `DROP SCHEMA public`).
6. Préparation : création des rôles Supabase + propriétaires, du schéma
   `extensions`, et des extensions détectées **avant** les `CREATE TABLE`.
7. `pg_restore` (on continue sur erreurs pour les catégoriser).
8. Comptage des lignes par table dans la cible restaurée.
9. Comparaison avec la source vivante (avec tolérance).
10. Rapport (erreur d'origine, erreurs par catégorie, tables/lignes) et
    destruction du conteneur.

## État et limites (voir [MILESTONES.md](MILESTONES.md))

- MVP : sauvegarde logique chiffrée, planification cron, vérification Supabase,
  rapport, interface, stockage **local**.
- Non encore implémenté : stockages S3/R2/SFTP, notifications Telegram/email,
  agent sortant distant, sauvegarde physique/WAL, sauvegarde des volumes Docker
  et du `.env` Supabase, rétention GFS, MySQL/MongoDB.
- La vérification requiert le déploiement Docker (socket + volume nommé) ;
  elle ne touche **jamais** la base source (lecture seule).
