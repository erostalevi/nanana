# nanana CLI

Forward webhooks sent to `<slug>.nanana.lat` to a service on your machine, and manage your subdomains.
Single static binary (Go, CGO off) for macOS, Linux and Windows.

## Quick start

```sh
nanana -t=nnt_xxxxxxxx -p=3000                 # shorthand for `nanana tunnel`
nanana -t=nnt_xxxxxxxx -p=3000 -h=192.168.1.20 # forward to another machine on your LAN
nanana login && nanana tunnel myslug -p 3000   # logged in: no token needed for subdomains you own
```

On start it prints the public URL, dashboard URL and forwarding target, then one line per proxied request:

```
15:04:05 POST    /pay?x=1 200 12ms
15:04:09 POST    /pay?x=1 200 9ms [replay]
15:04:12 GET     /health ERR 2ms  ECONNREFUSED: nothing is listening on http://127.0.0.1:3000
```

Colors only appear on a TTY and `NO_COLOR` is respected. `--json` prints one JSON object per line
(`connected`, `disconnected`, `request` events) for scripting.

> `-h` is the **target host**, so help is `--help` only.

## Commands

| Command | Description |
|---|---|
| `nanana -t=<token> -p=<port> [-h=<host>]` | Shorthand for `nanana tunnel` |
| `nanana tunnel [slug] -p <port>` | Forward a subdomain to a local port |
| `nanana login` / `logout` / `whoami` | Browser device-flow login, remove local credentials, show the account |
| `nanana list` | Your subdomains and states |
| `nanana create [name]` | New subdomain (a custom `name` needs an account); prints the `nnt_` token once |
| `nanana delete <slug> [--yes]` | Delete a subdomain (asks for confirmation unless `--yes`) |
| `nanana claim -t <nnt_token> [--slug <slug>]` | Attach an anonymous subdomain to your account |
| `nanana version` / `update-check` | Print version; look for a newer release (failures are tolerated) |

### `tunnel` flags

| Flag | Meaning |
|---|---|
| `-t, --token` | `nnt_` subdomain token or `nna_` account token |
| `-p, --port` | Local port (required unless `--url`) |
| `-h, --host` | Local host, default `127.0.0.1` |
| `--scheme http\|https` | Local scheme, default `http` |
| `--url http://host:port` | Target as a URL; replaces `-h/-p/--scheme` |
| `--sub <slug>` | Subdomain slug (env `NANANA_SUB`); see below |
| `--preserve-host` | Keep the original `Host` header (default: rewrite to the target `host:port`) |
| `--no-tail` | Do not print per-request lines |
| `--json` | Machine-readable output |
| `--insecure` | Skip TLS verification for an https target (self-signed dev certs) |

Global: `--api <url>` (env `NANANA_API`, default `https://api.nanana.lat`).

## Authentication and how the slug is found

Token resolution order: `-t` flag, env `NANANA_TOKEN`, credentials file
(`$XDG_CONFIG_HOME/nanana/credentials.json`, else `~/.config/nanana/credentials.json`, Windows `%AppData%\nanana\credentials.json`;
mode 0600). Credentials saved for a different API base than the one in use are ignored, so a token is never sent to a server that did not issue it.

The tunnel endpoint needs the slug (`/tunnel?sub=<slug>`), so the slug is chosen as follows:

1. positional `nanana tunnel <slug>`, then `--sub <slug>`, then env `NANANA_SUB`;
2. otherwise, with an `nnt_` token, the CLI calls **`GET /subdomains/_self`** (authenticated by that token) and uses the returned `slug`;
3. an `nna_` account token always needs a slug (`nanana list` shows yours).

**API requirement:** `GET /subdomains/_self` is not in `docs/API.md` yet. It must return the `Subdomain` for the presented `nnt_` token
(401 for invalid tokens). `claim` uses the same lookup when `--slug` is omitted.
`claim` takes the subdomain token via `-t` and authenticates as you with the account token from `NANANA_TOKEN` (`nna_...`) or the credentials file.

## Behavior notes

- One live tunnel per subdomain: starting a second one replaces the first, which exits with code **2** ("replaced").
- Reconnects automatically with exponential backoff (1s to 30s, jittered). It does not reconnect after the server says the
  subdomain was replaced, deleted or expired. Handshake errors 401, 403, 404 and 426 are fatal and explained.
- Up to 20 requests in flight; redirects are not followed (passed back to the sender); local requests time out after 25 s;
  responses over 10 MB are reported as an `EOTHER` error. Failures are reported as `ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH` or `EOTHER`.
- Ctrl+C closes the tunnel gracefully.
- Exit codes: 0 ok, 1 error, 2 tunnel replaced.

## Build and test

```sh
make test        # go test -race ./...
make build       # ./dist/nanana
make build-all   # cross-compile all targets into ./dist with plain `go build`
```

Releases use GoReleaser (`.goreleaser.yaml`) and publish to GitHub `erostalevi/nanana-releases`.
The version is injected with `-ldflags "-X main.version=<v>"`.
