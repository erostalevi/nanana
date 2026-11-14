# syntax=docker/dockerfile:1.20
# nanana API image. Build context = repository root:
#   docker build -f deploy/api/Dockerfile -t nanana-api .
ARG NODE_VERSION=24
ARG PNPM_VERSION=12.18.0

# ---- base: node + pnpm -------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force
ENV PNPM_HOME=/pnpm CI=true
WORKDIR /app

# ---- manifests only (best layer caching) ---------------------------------------
FROM base AS manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --parents apps/*/package.json ./

# ---- build: all deps, compile TypeScript ---------------------------------------
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "api..." --store-dir /pnpm/store
COPY apps/api ./apps/api
RUN pnpm --filter api build

# ---- prod-deps: production dependencies only -------------------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "api..." --store-dir /pnpm/store

# ---- runtime ----------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node apps/api/package.json ./apps/api/package.json
COPY --chown=node:node deploy/api/healthcheck.mjs /app/healthcheck.mjs

WORKDIR /app/apps/api
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "/app/healthcheck.mjs"]
# Migrations run automatically when the app boots.
CMD ["node", "dist/main.js"]
