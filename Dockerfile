# syntax=docker/dockerfile:1

# ---- Build web (Vue 3) -----------------------------------------------------
FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY web/package.json web/package.json
RUN npm install --workspace=web --include-workspace-root
COPY web web
RUN npm run build --workspace=web

# ---- Build server (TypeScript) --------------------------------------------
FROM node:22-bookworm-slim AS server-build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
RUN npm install --workspace=server --include-workspace-root
COPY server server
RUN npm run build --workspace=server

# ---- Runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Dépendances runtime du serveur uniquement.
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
RUN npm install --workspace=server --include-workspace-root --omit=dev \
    && npm cache clean --force

# Binaires compilés + web statique
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=web-build /app/web/dist ./server/dist/public

# Les sauvegardes et pg_dump/pg_restore tournent dans des conteneurs
# PostgreSQL versionnés pilotés via le socket Docker : l'image reste légère
# et n'embarque pas les clients postgres.

EXPOSE 4005
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4005)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
