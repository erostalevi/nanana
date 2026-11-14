# nanana.lat

A tiny webhook inspector, replayer and tunnel. Create a throwaway subdomain, point webhooks (Transbank, Stripe, anything) at it, watch requests arrive live, replay them, and tunnel them into a port on your own machine with the `nanana` CLI.

```
https://<sub>.nanana.lat          public webhook ingress (any method, any path)
https://<sub>.tools.nanana.lat    live inspector dashboard for that subdomain
https://api.nanana.lat            REST API, SSE stream, CLI tunnel (WebSocket)
https://nanana.lat                landing, docs, login, account
```

```bash
# install the CLI
curl -fsSL https://nanana.lat/install.sh | sh

# forward everything sent to your subdomain to localhost:3000
nanana -t=<token> -p=3000
# ...or to another machine on your network
nanana -t=<token> -p=3000 -h=192.168.1.20
```

## Repo layout

| Path | What |
|---|---|
| `apps/api` | NestJS 12 API: ingress, tunnel gateway, replay, accounts (Postgres via TypeORM) |
| `apps/web` | React + Vite: landing, docs, account pages and the dashboard |
| `cli` | Go CLI (`nanana`) |
| `infra` | OpenTofu/Terraform for AWS (EC2, Route 53, SES, ECR, backups, OIDC roles) |
| `deploy` | Dockerfiles, Compose file, Caddyfile, deploy scripts |
| `docs` | `API.md` (wire contract), `INFRA.md` (runbook), `OVERNIGHT.md` (build log) |
| `SPEC.md` | Product and design spec |

## Local development

Requirements: Node 22+, pnpm, Go, PostgreSQL 16.

```bash
pnpm install
createdb nanana_dev nanana_test            # once
cp apps/api/.env.example apps/api/.env     # BASE_DOMAIN=localhost
pnpm --filter api start:dev                # API on :3001
pnpm --filter web dev                      # web on :5173
(cd cli && go build -o nanana . )          # CLI
```

`*.localhost` resolves to 127.0.0.1, so `http://abc123.localhost:3001` is an ingress and `http://abc123.tools.localhost:5173` the dashboard. Magic-link emails are printed to the API log (`MAIL_DRIVER=console`).

Tests:

```bash
pnpm --filter api test          # unit
pnpm --filter api test:e2e      # needs the nanana_test database
(cd cli && go test -race ./...)
pnpm --filter web test
```

## Operating it

See `docs/INFRA.md`. Operator tooling runs on the box through SSM:

```bash
docker compose exec api node dist/admin-cli.js stats
docker compose exec api node dist/admin-cli.js disable-sub <slug>
docker compose exec api node dist/admin-cli.js disable-account <email>
```
