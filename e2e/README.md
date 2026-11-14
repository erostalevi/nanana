# nanana e2e suite

Playwright (Chromium, headless) end-to-end tests plus an automated accessibility audit (axe-core) for the
nanana.lat web app. Everything runs against a **local stack that the suite starts itself**. It never talks to
production or AWS.

```bash
pnpm install
pnpm --filter e2e exec playwright install chromium   # once

pnpm --filter e2e test                 # whole suite (about 2 minutes)
pnpm --filter e2e test -- tests/mock.spec.ts          # one file
pnpm --filter e2e test -- -g "HMAC"                   # by title
pnpm --filter e2e test:ui              # Playwright UI mode
pnpm --filter e2e report               # open the last HTML report
pnpm --filter e2e typecheck
```

(From inside `e2e/` the same scripts work without `--filter e2e`.)

Requirements: Node 22+, pnpm, PostgreSQL 16 running locally with an empty-able database named `nanana_test`
(`createdb nanana_test`; migrations are applied by the API on boot). Override the connection with
`E2E_DATABASE_URL`. **The suite TRUNCATEs every table in that database**, so never point it at data you care about.

## How the stack is managed

`global-setup.ts` runs once per `playwright test` invocation:

1. Refuses to start if port 3201 (API) or 5173 (Vite) is already taken.
2. Rebuilds `apps/api/dist` with `pnpm --filter api build` when it is missing or older than any file in
   `apps/api/src`.
3. Truncates the database, then spawns (detached, own process group, output in `e2e/.run/*.log`):
   - the API: `node apps/api/dist/main.js` with `PORT=3201 BASE_DOMAIN=localhost DATABASE_URL=...nanana_test
     MAIL_DRIVER=console RUN_JOBS=false REPLAY_ALLOW_PRIVATE=true`, plus `TRUST_PROXY=true` (lets helpers send a
     unique `X-Forwarded-For`, because the API rate-limits magic links to 5/min per IP) and `NO_COLOR=1`. It runs with
     `e2e/.run` as cwd so `apps/api/.env` is never loaded.
   - Vite: `vite --port 5173 --strictPort` in `apps/web` with `VITE_API_URL=http://localhost:3201`.
4. Waits for `/healthz` and the Vite root, and hands Playwright a teardown that stops both process groups
   (SIGTERM, then SIGKILL) and waits for the ports to be free.

Per test, an automatic fixture (`cleanDb`) truncates the database again (single worker, so this is safe). That keeps
tests independent and resets the "3 anonymous endpoints per IP per day" and per-account limits.

### Origins

| What | URL |
|---|---|
| Web app (landing, docs, login, account...) | `http://localhost:5173` |
| Dashboard | `http://<slug>.tools.localhost:5173/#t=<token>` |
| API (used by the web app, bare localhost so session cookies are same-site) | `http://localhost:3201` |
| Webhook ingress | `http://<slug>.localhost:3201/...` |

Chromium resolves `*.localhost` to loopback. The test helper `sendHook()` connects to `127.0.0.1:3201` and sets the
`Host` header itself, so it does not depend on the OS resolver.

### Helpers (`lib/`)

- `api.ts`: `createEndpoint`, `sendHook`, `signIn` (real magic-link flow, leaves the cookie in the browser context),
  `apiCall`.
- `mail.ts`: reads magic links from the API log (`e2e/.run/api.log`, the `[mail:console]` message), robust against
  repeated mails because it takes the last one for that address.
- `tunnel.ts`: `FakeTunnel`, a fake CLI speaking docs/API.md's tunnel protocol (JSON text frames and binary frames
  prefixed with the 16 raw bytes of the request UUID).
- `stub.ts`: a tiny HTTP server standing in for the developer's app (replay target).
- `a11y.ts`: axe wrapper that collects findings for many page states.
- `db.ts`: `resetDb`, `dbQuery`.

## Accessibility audit

`tests/a11y.spec.ts` scans every route state worth scanning (landing incl. created endpoint and FAQ, docs, login,
device, account signed in with its dialogs, legal pages, 404, auth error, dashboard empty, with requests of every body
kind and every detail tab, replay bar, popovers, settings/mock/delete dialogs, access screens) in light and dark
themes, on desktop and a 375x812 phone. It also has keyboard-only flows.

- **serious / critical** violations fail the test, with rule, state and CSS target in the message.
- **moderate / minor** violations never fail; they are written to `e2e/a11y-report/report.md` (plus one JSON per run)
  and attached to the HTML report.
- Rules: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa and axe best-practices.

## Debugging

- Logs of the stack: `e2e/.run/api.log` (all API output, including magic links) and `e2e/.run/vite.log`.
- A failing test keeps a screenshot; on the first retry a trace is recorded:
  `pnpm exec playwright show-trace test-results/<test>/trace.zip`. `pnpm --filter e2e report` opens the HTML report.
- Run headed with `pnpm --filter e2e test -- --headed --workers=1 -g "title"`, or step through with
  `PWDEBUG=1 pnpm --filter e2e test -- -g "title"`.
- To poke at the stack manually, run a test with `--debug` (the stack stays up while the inspector is open).
- Retries: 1 locally, 2 when `CI` is set. Timeout 45 s per test (150 s for the long axe walks).

### Stuck processes

If the runner is killed with SIGKILL the teardown cannot run. Free the ports and re-run:

```bash
lsof -ti tcp:3201 -ti tcp:5173 | xargs kill
```
