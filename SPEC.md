# nanana.lat: Webhook Inspector, Replayer & Tunnel. Spec v0.2

Public, self-operated service on **nanana.lat**. Anyone can spin up a throwaway subdomain, point webhooks at it, watch requests arrive live, replay them, and (with the `nanana` CLI) tunnel them into a port on their own machine. Accounts unlock custom names and CLI management; paid tiers (reservations, always-on) come later and are designed for, not built.

---

## 1. Decisions log (from the questionnaire)

| Area | Decision |
|---|---|
| Hosting | Single EC2/Lightsail VM in **us-east-1**, Docker Compose: Caddy + API + Postgres. DNS in Route 53 (`*.nanana.lat` wildcard to the VM) |
| TLS | Caddy with the Route 53 DNS-01 plugin, wildcard certs |
| Auth | Anonymous (token-based) **and** accounts. SSO: GitHub, Google, email magic link (SES, us-east-1). CLI uses browser device flow |
| Billing | Nothing built now; data model and limits are plan-aware (`plan` field + `PlanLimits` service) |
| Naming | Anonymous: random only. Accounts: custom names allowed. No squatting: everything idles out |
| Lifecycle | `active` (activity within 1 h) to `cold` (1 h to 24 h idle, still captures, any activity revives) to `dead` (data deleted, slug released) |
| Retention | Per subdomain: newest **100** requests AND nothing older than **1 h**, whichever bites first |
| Tunnel | Real proxy: local app's response goes back to the sender. HTTP/HTTPS only. Offline/failure: store request, reply with configurable status (default 200) |
| Replay | Localhost/LAN targets go **through the CLI tunnel**. Server-side replay only to public hosts with SSRF protection |
| Dashboard access | Anonymous: URL + token fragment. Account-owned: login as owner |
| Limits | Anonymous/free: 1 MB body, 60 req/min per sub, 3 new subs per IP per day. Accounts: 10 MB body, 300 req/min, 3 active subs, 1 custom name |
| CLI | Go single static binary. v1 commands: tunnel, login/logout/whoami, list/create/delete, live tail |
| Features kept | HMAC check, response mocking, copy as curl, live dashboard updates |
| Architecture | NestJS monolith incl. WebSocket tunnel gateway. One React/Vite app (landing is a route) |
| Claiming | An anonymous subdomain can be claimed by an account using its token |
| Repo | Monorepo (`apps/api`, `apps/web`, `cli`), GitHub Actions, private for now |

---

## 2. Hostnames and routing

| Host | Purpose |
|---|---|
| `nanana.lat`, `www.nanana.lat` | Landing page, docs, login, account pages (React app) |
| `api.nanana.lat` | REST API, SSE stream, CLI tunnel WebSocket (`/tunnel`) |
| `<sub>.nanana.lat` | **Public webhook ingress** for that subdomain (also the tunnel's public face) |
| dashboard host (see below) | Inspector UI for one subdomain |

> **Decision needed: dashboard hostname.** You asked for `tools.<sub>.nanana.lat`. A wildcard certificate covers exactly one label, so `*.nanana.lat` does **not** cover `tools.k7x2.nanana.lat`; that would require a separate certificate per subdomain (on-demand issuance, hits Let's Encrypt rate limits fast). The clean equivalent is **`<sub>.tools.nanana.lat`**, covered by one extra wildcard `*.tools.nanana.lat` cert. DNS needs `*.tools.nanana.lat` too. This spec uses `<sub>.tools.nanana.lat`; flip it back only if you accept per-host certs.

**Reserved labels** (never allocatable): `www, api, tools, app, admin, dashboard, static, assets, mail, smtp, status, docs, blog, help, support, login, auth, cdn, ns1, ns2, root, nanana` plus anything matching a profanity/brand blocklist. Custom names: `[a-z0-9-]{3,32}`, no leading/trailing hyphen, no `xn--`.

**Routing:** Caddy terminates TLS and reverse-proxies all `*.nanana.lat` and `api.` traffic to Nest on `:3001`, passing `X-Forwarded-For`/`Host`. Static React build is served by Caddy for apex/`www` and `*.tools.nanana.lat` (SPA fallback). Nest resolves ingress by Host header; unknown/dead sub gives `404` with a tiny "this subdomain doesn't exist or expired" page.

**Local dev:** `BASE_DOMAIN=localhost` so `abc.localhost:3001` works in browsers with no DNS setup.

---

## 3. Lifecycle and retention

State machine per subdomain, driven by `last_activity_at`:

```
active --(idle >= 1h)--> cold --(idle >= 24h)--> dead (hard delete)
   ^                        |
   +---- any activity ------+
```

**Activity** = inbound request to `<sub>`, CLI tunnel connect (and each heartbeat while connected), dashboard load/stream open, API call using its token. A connected tunnel keeps the subdomain `active` indefinitely. While `cold`, captures still work (no tunnel assumed unless CLI reconnects) and the first activity flips it back to `active` and resets the clock.

**Retention enforced two ways:** (a) on every insert, delete requests beyond the newest 100 for that subdomain; (b) a per-minute job deletes requests older than 1 h and processes state transitions (`active` to `cold`, hard-delete dead ones with cascade). Replays and mock rules are deleted with their parent.

Future paid levers (modeled now, unused): `always_on_until`, `reserved_until` on subdomain; retention/size/rate numbers come from `PlanLimits(plan)`.

---

## 4. Auth and tokens

**Token types** (all random, shown once, stored as SHA-256 hash):
- `nnt_...` **subdomain token**: authorizes the tunnel and dashboard for one subdomain. Returned when an anonymous subdomain is created. Valid for the subdomain's life.
- `nna_...` **account CLI token**: issued by device flow; lets the CLI list/create/delete subdomains and mint/fetch tunnel access for any subdomain the account owns. Revocable.
- Web session: opaque session id in an `HttpOnly; Secure; SameSite=Lax` cookie, host-only on `api.nanana.lat`; CORS allows `https://*.tools.nanana.lat` and the apex with credentials.

**Anonymous flow:** landing page "Create endpoint" to `POST /subdomains` (no auth) returns `{slug, url, dashboardUrl: https://<slug>.tools.nanana.lat/#t=<token>, token, cliCommand}`. Fragment is never sent to servers or logged. The dashboard moves the token into memory/sessionStorage and strips the fragment from the URL. Lose the token, lose management (the endpoint dies on idle anyway).

**Account flow:** SSO via GitHub, Google, or magic link (single-use, 15 min, hashed). Account-owned subdomains require login as owner (or the subdomain token) to view.

**CLI device flow:**
1. `nanana login` calls `POST /auth/device`, receives `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in` (10 min).
2. CLI opens `https://nanana.lat/device?code=<user_code>` (prints the URL if no browser); user signs in with any SSO method and approves.
3. CLI polls `POST /auth/device/token` until approved, stores `nna_...` in `~/.config/nanana/credentials.json` (mode 0600; XDG-aware; Windows `%AppData%`).

**Claim:** logged-in user supplies a subdomain token (dashboard "Claim" button or `nanana claim -t <token>`) to attach it to their account, subject to the 3 active subs limit. It keeps its random name and data; lifecycle timers still apply.

**Limits (config-driven, `PlanLimits`):**

| | Anonymous | Free account |
|---|---|---|
| Active subdomains | 3 new/IP/day | 3 active |
| Custom names | no | 1 |
| Max body | 1 MB | 10 MB |
| Rate (per sub) | 60 req/min | 300 req/min |
| Retention | 100 req / 1 h | 100 req / 1 h |

Rate limiting: in-memory token bucket keyed by sub (and by IP for creation/login endpoints); single VM, so no Redis. Over limit returns `429` with `Retry-After`. Hashed IPs (HMAC with server secret) are kept for creation limits; raw IPs are stored only on captures, for display.

---

## 5. Ingress (`<sub>.nanana.lat`, any method, any path)

Pipeline per request:

1. Resolve sub by Host; 404 if missing/dead. Enforce body cap (413) and rate limit (429).
2. Read **raw** body bytes (no parser touches it).
3. Persist `captured_request` (method, full path+query, headers as received, raw body, size, source IP, timestamp). Bump `last_activity_at` (revive if cold). Emit SSE event.
4. Decide the response:
   - **Mock rule active?** Return the rule's response, decrement `remaining`. Not forwarded. Capture still stored, marked `mocked`.
   - **Tunnel connected?** Forward through the tunnel; return the local app's status/headers/body to the sender. Local timeout 25 s. On timeout/connection-refused/tunnel drop: mark `forward_error`, respond with the **offline status** (below).
   - **No tunnel:** respond with the offline status.
5. **Offline status:** per-subdomain setting `offline_status` (default `200`, body `{"ok":true}`), switchable to e.g. `502/503` to deliberately trigger sender retries.
6. Store the response that was actually sent (status, headers, body capped at 1 MB) on the capture, plus latency and who answered (`tunnel | mock | offline`).

Hop-by-hop headers (`connection`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`) are stripped in both directions; `host` is rewritten to the CLI target host unless `--preserve-host`; `X-Forwarded-For/Proto/Host` added.

---

## 6. Tunnel protocol (`wss://api.nanana.lat/tunnel`)

One WebSocket per subdomain connection. Auth by `Authorization: Bearer <nnt_ or nna_>` and `?sub=<slug>` on upgrade (nna_ must own the sub). Frames are JSON text for control plus binary frames for bodies:

```
server -> cli   {"t":"hello","sub":"k7x2m9qa","url":"https://k7x2m9qa.nanana.lat","dashboard":"..."}
server -> cli   {"t":"req","id":"<uuid>","method":"POST","path":"/pay?x=1","headers":{...},"bodyLen":123,"replay":false}
                <binary frame(s): body, tagged by id, chunked <=64KB>
cli -> server   {"t":"res","id":"<uuid>","status":200,"headers":{...},"bodyLen":45}
                <binary frame(s): response body>
cli -> server   {"t":"err","id":"<uuid>","code":"ECONNREFUSED","msg":"..."}
both            {"t":"ping"} / {"t":"pong"}   every 20 s; drop after 60 s silence
```

- Max 20 in-flight requests per tunnel; excess is answered with the offline status (`forward_error=busy`).
- **One live tunnel per subdomain**: a new connection replaces the old one (old receives `{"t":"bye","reason":"replaced"}`). Avoids split-brain; mention in docs.
- CLI reconnects with exponential backoff (1 s up to 30 s, jitter); in-flight requests during a drop get the offline status.
- Protocol version in the `hello` and an `X-Nanana-Protocol: 1` header; server can reject too-old CLIs with an upgrade message.
- Replay-through-tunnel reuses the `req` frame with `"replay":true` (so the CLI tail labels it).

---

## 7. Replay

`POST /requests/:id/replay` body `{ "target": { "type": "tunnel" } | { "type": "url", "url": "https://staging.example.com/hook" }, "overrideHeaders"? }`

- **tunnel:** requires a connected tunnel for that subdomain (409 if not). Sends the original method, path, headers, raw body through it. Works to `localhost`, LAN hosts (`-h`), anything the CLI can reach.
- **url:** server-side, **public hosts only**. SSRF guard: https/http only; resolve DNS ourselves, reject loopback, RFC1918, link-local (incl. `169.254.169.254`), CGNAT, multicast, IPv6 equivalents; connect to the resolved IP (no rebinding); no redirects followed; 10 s timeout; 1 MB response cap; max 10 server-side replays per minute per sub; request carries `x-replayed-by: nanana` and `x-replay-of: <id>`.
- Result is always a `201` with the stored replay (`status` null and `error` set for network failures); non-2xx is a result, not an API error.
- Replays do not count as inbound activity for retention but do bump `last_activity_at`.

---

## 8. HMAC check

Configured per subdomain: `secret`, `header` name, `algo` (sha256 default; sha1, sha512). Verification over the **raw body** with `timingSafeEqual`; accepts plain hex, `sha256=<hex>`, base64, and Stripe-style `t=...,v1=...` (signs `t.body`, with 5 min tolerance flag shown informationally). States: `pass | fail | header_missing | not_configured`. Computed on read so changing the secret re-evaluates existing captures. Secret encrypted at rest (AES-256-GCM, key from env), never returned by the API after save.

---

## 9. Mocking rules

`POST /subdomains/:slug/mock` body `{status, headers?, body?, times: 1..50, then?: "passthrough"}`. Each inbound request consumes one use while `remaining > 0`; afterwards behavior returns to normal (tunnel/offline). One active rule per subdomain (new replaces old). Typical use: `500 x2` then let the sender's retry hit your real handler, to test idempotency. Dashboard shows remaining count live.

---

## 10. Data model (Postgres, TypeORM migrations)

**account**: `id`, `email` (unique, citext), `display_name`, `plan` text default `free`, `created_at`, `disabled_at`
**identity**: `id`, `account_id` fk, `provider` (`github|google|email`), `subject`, unique(provider, subject)
**session**: `id` (hashed), `account_id`, `expires_at`, `user_agent`, `created_at`
**cli_token**: `id`, `account_id`, `token_hash`, `name`, `last_used_at`, `revoked_at`
**device_auth**: `device_code_hash`, `user_code`, `account_id` null, `status`, `expires_at`
**magic_link**: `token_hash`, `email`, `expires_at`, `used_at`
**subdomain**: `id`, `slug` (unique), `owner_id` null (anonymous), `is_custom` bool, `token_hash`, `state` (`active|cold`), `last_activity_at`, `offline_status` int default 200, `offline_body` text, `hmac_secret_enc` null, `hmac_header` null, `hmac_algo`, `created_ip_hash`, `created_at`, `always_on_until` null, `reserved_until` null
**captured_request**: `id`, `subdomain_id` fk cascade, `method`, `path`, `headers` jsonb, `body` bytea, `body_size`, `content_type`, `source_ip`, `received_at`, `answered_by` (`tunnel|mock|offline`), `response_status`, `response_headers` jsonb, `response_body` bytea (cap 1 MB), `latency_ms`, `forward_error` null. Indexes: (`subdomain_id`, `received_at` desc)
**replay**: `id`, `request_id` fk cascade, `target_type`, `target_url` null, `status` null, `response_headers`, `response_body`, `truncated`, `error`, `duration_ms`, `created_at`
**mock_rule**: `id`, `subdomain_id` fk cascade (unique), `status`, `headers` jsonb, `body`, `remaining`, `created_at`

Cleanup is cascade-driven; the per-minute job also deletes expired sessions, device auths, and magic links.

---

## 11. REST API (`api.nanana.lat`)

Auth column: `-` public, `T` subdomain token (Bearer `nnt_`), `A` account (session cookie or Bearer `nna_`), `T|A` either (A must own the sub).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/subdomains` | `-` or `A` | Anonymous: random name + returns token. Account: optional `name` (custom, 1 free), returns token too |
| GET | `/subdomains` | `A` | Owner's subdomains with state and idle timers |
| GET | `/subdomains/:slug` | `T|A` | Settings, state, tunnel online?, mock rule |
| PATCH | `/subdomains/:slug` | `T|A` | `offline_status/body`, HMAC settings |
| DELETE | `/subdomains/:slug` | `T|A` | Immediate hard delete |
| POST | `/subdomains/:slug/claim` | `A` + body `{token}` | Attach anonymous sub to account |
| GET | `/subdomains/:slug/requests?limit&before` | `T|A` | Newest first, bodies omitted (preview only) |
| GET | `/requests/:id` | `T|A` | Full detail, signature result, replays |
| DELETE | `/requests/:id` | `T|A` | |
| POST | `/requests/:id/replay` | `T|A` | See §7 |
| GET | `/subdomains/:slug/stream` | `T|A` | SSE: `request.created`, `request.updated` (response filled), `tunnel.status`, `mock.updated`, `subdomain.state`; heartbeat every 25 s |
| POST/DELETE | `/subdomains/:slug/mock` | `T|A` | §9 |
| POST | `/auth/magic` , `/auth/magic/verify` | `-` | Magic link |
| GET | `/auth/github`, `/auth/google` (+ callbacks) | `-` | OAuth |
| POST | `/auth/device`, `/auth/device/token`, `/auth/device/approve` | `-`/`A` | CLI device flow |
| GET | `/me`, POST `/auth/logout` | `A` | |
| GET | `/healthz` | `-` | |

Errors: `{ "error": { "code", "message" } }`. IDs are UUIDv7 so keyset pagination by id is stable.

---

## 12. CLI (`nanana`, Go)

```
nanana -t=<token> -p=<port> [-h=<host>]       # shorthand for `nanana tunnel`
nanana tunnel -t <token> -p 3000 [-h 192.168.1.20] [--scheme http|https] [--preserve-host] [--no-tail]
nanana login | logout | whoami
nanana list                                    # account: your subdomains and states
nanana create [name]                           # account: new subdomain (name = custom, else random); prints token and URLs
nanana delete <slug>
nanana claim -t <token>                        # attach an anonymous sub to your account
nanana tunnel <slug> -p 3000                   # logged-in: no token needed for owned subs
nanana version | update-check
```

Behavior:
- `-h` is the **target host** (default `127.0.0.1`), so `--help` is long-only. `-p` is required (or `--url http://host:port`).
- On start prints the public URL, dashboard URL, forwarding target, and `Ctrl+C to stop`.
- **Live tail**: one line per request: time, method, path, status, latency, `signature ✓/✗`, `[replay]`/`[mock]` tags. Colors off when not a TTY; `--json` for machine output.
- Reconnects automatically (backoff), prints state changes. Local connection refused gives a clear message and the sender sees the offline status.
- Config precedence: flags, env (`NANANA_TOKEN`, `NANANA_API`), credentials file. `NANANA_API` default `https://api.nanana.lat` (override for local dev).
- Distribution: GoReleaser to GitHub Releases (darwin/linux/windows, amd64/arm64), `install.sh` (`curl -fsSL https://nanana.lat/install.sh | sh`), Homebrew tap later. Release binaries signed with checksums (cosign later).
- Libs: `cobra`/`pflag`, `gorilla/websocket` or `nhooyr/websocket`, `lipgloss` for output.

---

## 13. Web app (React + Vite + TS, TanStack Query, Tailwind)

**Landing (`nanana.lat`, `www`)**: hero with one-click "Create an endpoint" (live demo: shows URL and a copy-paste curl that fires a test webhook and appears live), how it works (3 steps), CLI install and usage (`-t -p -h` examples), feature grid (live inspector, replay, tunnel, HMAC, mocking), lifecycle/limits explainer ("Endpoints sleep after 1 h and vanish after 24 h idle"), pricing teaser ("Reserved names & always-on: coming soon", email capture optional), FAQ, footer with status/GitHub. Pages: `/docs` (usage, protocol overview, webhook provider recipes for Transbank, Stripe), `/login`, `/device`, `/account` (subdomains list, CLI tokens, claim, delete account).

**Dashboard (`<sub>.tools.nanana.lat`)**:
- Header: public URL with copy, state badge (active/cold + idle countdown to death), tunnel indicator (connected target `localhost:3000`), settings (offline status, HMAC), mock panel, delete.
- Left: live list (method badge, path, relative time, size, answered-by icon, response status, signature dot). SSE with auto-reconnect and refetch on gap.
- Right tabs: **Request** (headers table, pretty JSON/form/raw/hex body), **Response** (what we sent back), **Signature**, **Replays**. Replay bar: target choice "My tunnel" (disabled if offline) or public URL input; remembers last URL per sub.
- **Copy as curl** (uses `--data-binary` with base64 pipe for non-UTF-8).
- Empty state shows the exact curl and CLI commands for this subdomain.
- Light/dark, responsive.

---

## 14. Infra and deploy

- **Cost target (us-east-1, on-demand):** EC2 `t3.micro` (x86, so CI builds plain Docker images on free runners) ~$7.6 + public IPv4 ~$3.65 + 20 GB root gp3 ~$1.6 + 10 GB data gp3 ~$0.8 + Route 53 zone $0.50 + S3 backups/ECR/SES ~$1 = **~$15/mo**. 1 GB RAM is tight: 1 GB swap file; credit mode set to `standard` (not `unlimited`) so a CPU spike can never produce surprise bills. Resize to `t3.small` (+~$7.6) if needed. A 1-yr Savings Plan can cut the instance cost later.
- **Data safety (priority over uptime; downtime is acceptable, data loss is not):**
  - Postgres data lives on a **separate EBS data volume** (`DeleteOnTermination=false`, termination protection on, `prevent_destroy` in Terraform), so replacing the instance keeps the data.
  - **Continuous WAL archiving to S3 (WAL-G)** + weekly base backups: point-in-time recovery to any second within 30 days. Backup bucket: versioning on, encrypted, object-lock/lifecycle 30 days, public access blocked, bucket policy denies deletes except by a break-glass role.
  - **Daily EBS snapshots** via Data Lifecycle Manager (7 daily, 4 weekly).
  - Optional later: replicate the backup bucket to a second region.
  - A **restore drill** script (`infra/scripts/restore-drill.sh`) restores the latest backup into a scratch Postgres and checks account row counts; run before launch and monthly.
  - Captured webhook payloads are ephemeral by design; accounts, identities, tokens, and subdomain ownership are the data that must not be lost.
  - **Disaster recovery:** the backup bucket is replicated cross-region to `us-west-2` (S3 CRR, versioned, same lifecycle), ~$1/mo at this size.
- **Alerts:** SNS topic emailing the owner (address passed as a Terraform variable, not committed). Alarms: EC2 status check failed, disk >80%, WAL archive lag / backup job failure, Budget >$20/mo, Postgres container down.
- **AWS credentials:** owner chose to keep using root keys for now. Terraform will take an `aws_profile` variable so this can move to a scoped admin user later without changes; recommendation to rotate away from root remains open.
- **Edge protection:** app-level and Caddy rate limits, body caps and the budget alarm only for v1 (no CloudFront/WAF/Cloudflare).
- **Secrets:** SSM Parameter Store SecureString under `/nanana/prod/*`; the deploy script renders `.env` on the box from them. No secrets are stored in GitHub (OIDC only).
- **Environments:** prod only on AWS. Local dev uses `*.localhost`; PR CI runs e2e against a throwaway Postgres container.
- **Guards:** AWS Budget alarm at $20/mo; IMDSv2 required with hop limit 1; security group allows only 80/443 (no SSH).
- **IaC:** Terraform in `infra/`, state in an S3 bucket (native S3 locking). Resources: EC2 + EIP + SG (80/443 only, no SSH), IAM instance role (SSM, ECR pull, S3 backups, Route 53 DNS-01 for Caddy), ECR repo, S3 backup bucket, Route 53 zone `nanana.lat`, GitHub OIDC provider + deploy roles.
- **Deploys:** PRs into `main` run CI (tests, build, `terraform plan`) with a read-only OIDC role. Merge/push to `main` builds images, pushes to ECR, then deploys via **SSM Run Command** (`docker compose pull && up -d`), using an OIDC role trusted only for `repo:erostalevi/nanana:ref:refs/heads/main`. No SSH, no long-lived AWS keys in GitHub. The existing `erostalevi-landing-github-deploy` role belongs to another repo and is not reused.
- **VM:** Ubuntu/Amazon Linux arm64, Docker Compose. Elastic IP; Route 53 records: `A nanana.lat`, `A *.nanana.lat`, `A *.tools.nanana.lat`, `A api.nanana.lat`, `www` CNAME. SES: verified `nanana.lat` domain with DKIM/SPF/DMARC (+ production access request, since sandbox only mails verified addresses).
- **Caddy** image built with `caddy-dns/route53` (IAM user scoped to the hosted zone's TXT records for DNS-01).
- **Compose services:** `caddy`, `api`, `postgres:16` (data on the dedicated EBS volume, WAL-G archiving to S3; see Data safety above).
- **Config via `.env`/AWS SSM:** `BASE_DOMAIN`, `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `IP_HASH_SECRET`, OAuth client IDs/secrets, `SES_*`, limits overrides.
- **CI/CD (GitHub Actions):** lint+test on PR (api, web, cli); on tag: build and push images to GHCR, GoReleaser CLI release; deploy job SSHes to the VM and runs `docker compose pull && up -d` (migrations run on api start).
- **Observability:** structured JSON logs (pino), `/healthz`, basic Prometheus metrics (`/metrics` internal only), CloudWatch alarm on instance status; uptime check on `api.nanana.lat/healthz`.

---

## 15. Security and abuse

- Captured bodies are **never rendered as HTML**; dashboard escapes everything; strict CSP; `X-Content-Type-Options: nosniff`.
- Anonymous ingress is write-only to the public: no way to read captures without a token.
- Dashboards served from `*.tools.nanana.lat`, ingress from `*.nanana.lat`: distinct origins, no cookies shared with ingress hosts (session cookie is host-only on `api.`).
- Abuse: per-sub and per-IP rate limits, body caps, reserved names, takedown command (`admin disable-sub <slug>`), ToS/abuse contact page. Phishing/echo-server abuse risk accepted; mitigated by ephemerality and no custom response bodies for anonymous subs beyond the offline body (max 4 KB, forced `text/plain`/JSON content type).
- Secrets (HMAC) encrypted at rest; tokens and device/magic codes hashed; constant-time comparisons.
- Privacy: payload data is deleted within 24 h by design; state this plainly on the landing page. Never log bodies.
- Account deletion removes identities, sessions, tokens, owned subdomains.

---

## 16. Testing

- **API e2e (Jest + supertest, real Postgres):** raw byte preservation (non-UTF-8, odd whitespace); retention (cap 100 and 1 h); lifecycle transitions with a fake clock; rate/body limits; mock countdown; HMAC vectors incl. Stripe; SSRF guard (private IPs, redirects, DNS rebinding stub); device flow; claim; limits by plan.
- **Tunnel integration:** real WS client against a stub local HTTP server: proxying success, local timeout, ECONNREFUSED, replaced connection, in-flight drop, replay frame.
- **CLI:** Go unit tests for flag parsing (`-t= -p= -h=`), reconnect/backoff, output formatting; e2e against a locally started API.
- **Web:** Playwright smoke: create sub, curl it, see it live, replay through a fake tunnel, mock then clear.

---

## 17. Milestones

- **M0 Foundations:** monorepo scaffold, local Postgres, `BASE_DOMAIN=localhost` host routing, migrations, config/limits module.
- **M1 Ingress core:** create anonymous sub, capture pipeline, list/detail, retention + lifecycle job, rate/body limits, SSE.
- **M2 Tunnel:** WS gateway, protocol, offline status, response capture; Go CLI `tunnel` command with live tail.
- **M3 Replay, HMAC, mocking:** tunnel and URL replay with SSRF guard, HMAC verify, mock rules.
- **M4 Dashboard + landing:** React app, all dashboard panels, landing and docs.
- **M5 Accounts:** magic link, GitHub, Google, sessions, device flow, CLI `login/list/create/delete/claim`, custom names, plan limits.
- **M6 Ship:** Caddy and Route 53 wildcard TLS, Compose, SES, backups, CI/CD, GoReleaser/`install.sh`, abuse tooling, smoke test on prod.

---

## 18. Defaults I'm assuming (shout if wrong)

1. Dashboard host is `<sub>.tools.nanana.lat` (see §2 for why).
2. Local dev: Postgres via Homebrew (`postgresql@16`; neither Postgres nor Docker is installed on this machine yet); Docker only needed for deploy testing.
3. pnpm workspace; TypeORM; `ws` via `@nestjs/platform-ws`; UUIDv7 ids.
4. One live tunnel per subdomain; newest connection wins.
5. Mock rule beats the tunnel (mocked requests aren't forwarded).
6. 25 s local response timeout; 20 in-flight requests per tunnel.
7. Anonymous subs may set only `offline_status` and a tiny `offline_body`; no arbitrary custom bodies beyond that.
8. Brand/visual direction: playful-minimal developer tool (the "nanana" name and your ◡̈ vibe), dark-first with light mode.
9. Repo initialized with `git init` in `/Users/neto/nanana.lat`; private on GitHub when you're ready.
