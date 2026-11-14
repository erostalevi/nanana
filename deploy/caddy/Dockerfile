# syntax=docker/dockerfile:1.20
# Caddy with the Route 53 DNS-01 plugin, plus the built React app and install.sh.
# Build context = repository root:
#   docker build -f deploy/caddy/Dockerfile -t nanana-caddy .
ARG CADDY_VERSION=2.10
ARG NODE_VERSION=24
ARG PNPM_VERSION=12.18.0

# ---- caddy binary with caddy-dns/route53 ---------------------------------------
FROM caddy:${CADDY_VERSION}-builder AS caddy-build
RUN xcaddy build --with github.com/caddy-dns/route53

# ---- web app (apps/web). Tolerates its absence by emitting a placeholder. -------
FROM node:${NODE_VERSION}-alpine AS web
ARG PNPM_VERSION
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force
ENV PNPM_HOME=/pnpm CI=true
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    set -eu; \
    if [ -f apps/web/package.json ]; then \
      pnpm install --frozen-lockfile --filter "web..." --store-dir /pnpm/store; \
      pnpm --filter web build; \
    else \
      echo "apps/web not found: shipping a placeholder page"; \
      mkdir -p apps/web/dist; \
      printf '%s\n' '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>nanana.lat</title><body style="font-family:ui-monospace,monospace;background:#0b0b0f;color:#e8e8ea;display:grid;place-items:center;min-height:100vh;margin:0"><main><h1>nanana.lat</h1><p>Webhook inspector, replayer and tunnel. Coming soon.</p></main></body></html>' > apps/web/dist/index.html; \
    fi

# ---- runtime -----------------------------------------------------------------------
FROM caddy:${CADDY_VERSION}-alpine
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/caddy/install.sh /srv/dl/install.sh
COPY --from=web /app/apps/web/dist /srv/www
RUN chmod 0644 /srv/dl/install.sh && caddy list-modules | grep -q dns.providers.route53
