# dataspbackup — notes pour Claude Code

Sauvegarde PostgreSQL auto-hébergée + vérification de restauration fiable pour
Supabase. Monorepo npm workspaces : `server/` (Fastify + TS) et `web/` (Vue 3).

## Commandes

```bash
npm install                    # dépendances (scripts natifs requis)
npm run dev:server             # API :4005 (tsx watch)
npm run dev:web                # UI :5173
npm run build                  # build serveur (tsc) + web (vite)
npm test                       # vitest (serveur)
docker compose up -d --build   # déploiement un conteneur
```

Dev sans Docker : `DEV_ALLOW_EPHEMERAL_SECRETS=1 DATA_DIR=./data ADMIN_PASSWORD=dev`.

## Règles de sécurité (impératives)

- **Aucun secret dans les logs.** Le logger (`src/lib/logger.ts`) masque
  `password`, `token`, `secret`, `dsn`, `connectionString`, `masterKey`.
- **Aucun secret par défaut.** `src/config.ts` lève une erreur si `MASTER_KEY`
  (32 octets hex) ou `JWT_SECRET` manquent. Ne jamais contourner.
- **Secrets stockés chiffrés** (AES-256-GCM via `services/crypto`). Les routes
  ne renvoient jamais `password_enc` au client.
- **Restauration uniquement vers une cible jetable.** Ne jamais exécuter de
  `DROP`/recréation sur une base source. La vérification lit la source en
  lecture seule (comptage de lignes) et restaure dans un conteneur détruit
  ensuite.

## Carte du code

- `server/src/config.ts` — env + validation des secrets.
- `server/src/db/` — SQLite + migrations SQL (`migrations/*.sql`).
- `server/src/models/repo.ts` — accès typé aux métadonnées.
- `server/src/services/crypto/` — AES-256-GCM, hachage scrypt.
- `server/src/services/docker/` — pilotage dockerode (conteneurs jetables).
- `server/src/services/backup/` — `pg_dump` versionné + chiffrement.
- `server/src/services/verify/` — **cœur Supabase** :
  - `archive.ts` : introspection `pg_restore -l` ;
  - `supabasePrep.ts` : rôles / schéma extensions / extensions ;
  - `errors.ts` : catalogue bloquant vs bénin, erreur d'origine ;
  - `verify.ts` : orchestrateur.
- `server/src/services/scheduler/` — file de tâches + cron.
- `server/src/routes/` — API Fastify.
- `web/src/` — Vue 3 (router, pinia, vues).

## Conventions

- TypeScript strict, ESM (`"type": "module"`, imports en `.js`).
- Les migrations SQL sont copiées dans `dist/` au build (`cp` dans le script).
- Commentaires et libellés en français (le projet est francophone).
- Nouveau travail lourd = passer par `jobQueue` (exécution séquentielle).
