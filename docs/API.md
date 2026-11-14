# nanana API contract (v1). Source of truth for api, cli and web

Base URL: `https://api.nanana.lat` (dev: `http://localhost:3001`, with `BASE_DOMAIN=localhost`; hosts are `api.localhost:3001`, `<slug>.localhost:3001`, `<slug>.tools.localhost:5173` for the web dev server).
All bodies are JSON (`application/json`) unless stated. Timestamps are ISO-8601 UTC strings. IDs are UUID strings.
Auth: `Authorization: Bearer <token>` where token is `nnt_...` (subdomain token) or `nna_...` (account CLI token); browser sessions use the `nanana_session` cookie (HttpOnly, host-only on the api host; CORS allows the web origins with credentials).
Errors: HTTP status + `{"error":{"code":"snake_case_code","message":"human text"}}`.

## Types

```ts
type Subdomain = {
  slug: string;
  url: string;                 // https://<slug>.nanana.lat
  dashboardUrl: string;        // https://<slug>.tools.nanana.lat  (no token)
  isCustom: boolean;
  ownerId: string | null;
  state: 'active' | 'cold';
  lastActivityAt: string;
  hardExpiresAt: string;       // 7-day ceiling
  offlineStatus: number;       // default 200
  offlineBody: string;         // default {"ok":true}
  hmac: { header: string; algo: 'sha256' | 'sha1' | 'sha512'; configured: boolean } | null;
  tunnelOnline: boolean;
  mock: { status: number; remaining: number } | null;
};

type Signature = 'pass' | 'fail' | 'header_missing' | 'not_configured';

type RequestSummary = {
  id: string; method: string; path: string; receivedAt: string;
  bodySize: number; contentType: string | null; sourceIp: string;
  answeredBy: 'tunnel' | 'mock' | 'offline' | 'preflight';
  responseStatus: number | null; latencyMs: number | null;
  isPreflight: boolean; mocked: boolean; forwardError: string | null;
  signature: Signature;
  bodyPreview: string;         // first 200 chars if utf8, else ''
};

type Body = { encoding: 'utf8' | 'base64'; data: string; truncated?: boolean };

type RequestDetail = RequestSummary & {
  headers: Record<string, string | string[]>;
  body: Body;
  responseHeaders: Record<string, string | string[]> | null;
  responseBody: Body | null;
  signatureDetail: { state: Signature; header: string | null; received: string | null; expected: string | null };
  replays: Replay[];
};

type Replay = {
  id: string; requestId: string; targetType: 'tunnel' | 'url'; targetUrl: string | null;
  status: number | null; responseHeaders: Record<string, string | string[]> | null;
  responseBody: Body | null; error: string | null; durationMs: number; createdAt: string;
};
```

## Subdomains

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/subdomains` | none or `nna_`/session | `{ name?: string }` (name only for accounts) | `201 { subdomain: Subdomain, token: "nnt_...", dashboardUrlWithToken: "https://<slug>.tools.nanana.lat/#t=<token>" }` |
| GET | `/subdomains` | account | | `{ subdomains: Subdomain[] }` |
| GET | `/subdomains/:slug` | `nnt_` or owner | | `Subdomain` |
| PATCH | `/subdomains/:slug` | `nnt_` or owner | `{ offlineStatus?: number(100-599), offlineBody?: string(<=4096), hmacSecret?: string \| null, hmacHeader?: string, hmacAlgo?: string }` | `Subdomain` |
| DELETE | `/subdomains/:slug` | `nnt_` or owner | | `204` |
| POST | `/subdomains/:slug/claim` | account | `{ token: "nnt_..." }` | `Subdomain` |
| POST | `/subdomains/:slug/renew` | owner | | `Subdomain` (adds 7 days once) |
| POST | `/subdomains/:slug/token` | owner | | `{ token: "nnt_..." }` (rotates, shows once) |
| GET | `/subdomains/:slug/requests?limit=50&before=<id>&includePreflight=false` | `nnt_` or owner | | `{ requests: RequestSummary[], nextBefore: string \| null }` (newest first) |
| GET | `/subdomains/:slug/stream` | `nnt_` or owner | | SSE (below) |
| POST | `/subdomains/:slug/mock` | `nnt_` or owner | `{ status: number, headers?: Record<string,string>, body?: string, times: 1..50 }` | `{ status, remaining }` |
| DELETE | `/subdomains/:slug/mock` | `nnt_` or owner | | `204` |

Errors: `name_taken` 409, `name_invalid` 400, `name_reserved` 400, `name_tombstoned` 409, `limit_reached` 403, `rate_limited` 429 (with `Retry-After`), `not_found` 404, `unauthorized` 401, `forbidden` 403.

## Requests

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/requests/:id` | `nnt_` or owner | | `RequestDetail` |
| DELETE | `/requests/:id` | `nnt_` or owner | | `204` |
| POST | `/requests/:id/replay` | `nnt_` or owner | `{ target: { type: "tunnel" } \| { type: "url", url: string }, overrideHeaders?: Record<string,string> }` | `201 Replay` (409 `tunnel_offline` if tunnel target and no tunnel; 400 `url_blocked` for private/loopback hosts) |

## SSE stream (`GET /subdomains/:slug/stream`)

`Content-Type: text/event-stream`. Frames: `event: <name>\ndata: <json>\n\n`; comment heartbeat `: ping\n\n` every 25 s. Sent first: `event: hello` with the current `Subdomain`. The browser uses `fetch` streaming with the Authorization header (never put a token in the URL).

| event | data |
|---|---|
| `hello` | `Subdomain` |
| `request.created` | `RequestSummary` (response fields may be null until `request.updated`) |
| `request.updated` | `RequestSummary` |
| `request.deleted` | `{ id: string }` (retention eviction or manual delete) |
| `tunnel.status` | `{ online: boolean, target: string \| null }` |
| `mock.updated` | `{ status: number, remaining: number } \| null` |
| `subdomain.state` | `{ state: 'active' \| 'cold', hardExpiresAt: string }` |
| `subdomain.deleted` | `{}` (stream then closes) |

## Auth

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/auth/magic` | none | `{ email }` | `202 {}` (always, never reveals existence). Dev (`MAIL_DRIVER=console`): link is logged |
| POST | `/auth/magic/verify` | none | `{ token }` | `200 { account }` and sets `nanana_session` cookie |
| GET | `/auth/github`, `/auth/github/callback`, `/auth/google`, `/auth/google/callback` | none | | redirects; feature-flagged (`AUTH_GITHUB`, `AUTH_GOOGLE`); 404 when disabled |
| POST | `/auth/logout` | session | | `204` |
| GET | `/me` | account | | `{ account: { id, email, displayName, plan }, limits: { maxActiveSubdomains, maxCustomNames, ... }, providers: { github: boolean, google: boolean, magic: true } }` (providers also at public `GET /auth/providers`) |
| DELETE | `/me` | session | | `204` (deletes account and owned subdomains) |
| GET | `/me/tokens` | session | | `{ tokens: { id, name, createdAt, lastUsedAt }[] }` |
| DELETE | `/me/tokens/:id` | session | | `204` |
| POST | `/auth/device` | none | `{ clientName?: string }` | `{ deviceCode, userCode, verificationUri: "https://nanana.lat/device", verificationUriComplete: "https://nanana.lat/device?code=ABCD-EFGH", interval: 5, expiresIn: 600 }` |
| POST | `/auth/device/token` | none | `{ deviceCode }` | `200 { accessToken: "nna_...", account }` or `400 {"error":{"code":"authorization_pending"\|"slow_down"\|"expired_token"\|"access_denied"}}` |
| POST | `/auth/device/approve` | session | `{ userCode }` | `204` |

## Tunnel (`wss://api.nanana.lat/tunnel?sub=<slug>`)

Upgrade headers: `Authorization: Bearer <nnt_ or nna_>`, `X-Nanana-Protocol: 1`, optional `X-Nanana-Client: nanana-cli/<version>`.
Reject codes (HTTP before upgrade): 401 unauthorized, 403 forbidden (nna_ does not own sub), 404 not_found, 426 upgrade_required (protocol too old).

Text frames are JSON with `t`; binary frames carry bodies:

- **Binary frame layout:** bytes 0-15 = request id (the UUID's 16 raw bytes), bytes 16.. = body chunk (<= 64 KiB). A body is complete when `bodyLen` bytes were received for that id; `bodyLen: 0` means no binary frames follow.
- Server -> CLI:
  - `{"t":"hello","protocol":1,"sub":"<slug>","url":"https://<slug>.nanana.lat","dashboard":"https://<slug>.tools.nanana.lat","serverTime":"..."}`
  - `{"t":"req","id":"<uuid>","method":"POST","path":"/pay?x=1","headers":{"k":"v" | ["v1","v2"]},"bodyLen":123,"replay":false}` then binary body frames.
  - `{"t":"bye","reason":"replaced"|"deleted"|"expired"|"server_shutdown"}` then server closes.
  - `{"t":"ping"}` every 20 s.
- CLI -> server:
  - `{"t":"res","id":"<uuid>","status":200,"headers":{...},"bodyLen":45}` then binary body frames.
  - `{"t":"err","id":"<uuid>","code":"ECONNREFUSED"|"ETIMEDOUT"|"EHOSTUNREACH"|"EOTHER","msg":"..."}`
  - `{"t":"pong"}` in reply to ping.
- Limits: 20 in-flight requests per tunnel; CLI must answer within 25 s (server times out and uses the offline status); max response relay 10 MB; either side closes after 60 s of silence.
- Hop-by-hop headers are removed by the server before sending `req`; the CLI sets `Host` to the local target host:port itself (unless `--preserve-host`), and adds `X-Forwarded-For/Proto/Host` using `headers["x-forwarded-*"]` values supplied by the server.

## Webhook ingress (`https://<slug>.nanana.lat/*`)

Any method/path. Responses as in SPEC §5. Extra: unknown slug `404`, expired slug (tombstoned custom name) `410`, oversize `413`, rate limited `429`.

## Admin (read-only, owner only)

`GET /admin/stats` (session of an account whose email is in `ADMIN_EMAILS`; 403 otherwise) -> `{ accounts: number, subdomains: { total, active, cold, anonymous, custom }, tunnelsOnline: number, capturedRequests: number, requestsLastHour: number, uptimeSeconds: number, version: string }`.
`GET /auth/providers` (public) -> `{ github: boolean, google: boolean, magic: true }`.

## Misc

`GET /healthz` -> `{ "ok": true }`. `GET /version` -> `{ "version": "x.y.z", "minCliProtocol": 1 }`.
