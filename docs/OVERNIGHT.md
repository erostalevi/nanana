# Overnight log

Autonomy granted by the owner: apply AWS infra (cap $25/mo, never destroy existing resources), create `erostalevi/nanana-releases` (public), merge own PRs to main with auto-deploy, push directly for scaffolding/docs, set Actions variables and branch protection, install local tooling (terraform, colima/docker, Playwright). OAuth apps (GitHub/Google) are NOT created yet: ship magic-link only, SSO feature-flagged off. Operator for legal pages: individual in Chile, contact abuse@nanana.lat.

## Blockers and TODOs for the owner
1. **Confirm the SNS subscription email** (alerts for instance down, disk, backups, budget). Until you click it, no alarm email is delivered.
2. **GitHub/Google sign-in**: create the OAuth apps and add the keys to SSM (`/nanana/prod/GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, then set `AUTH_GITHUB`/`AUTH_GOOGLE` to `true` and redeploy). Callbacks: `https://api.nanana.lat/auth/github/callback`, `https://api.nanana.lat/auth/google/callback`. Magic-link login works today.
3. **`RELEASES_TOKEN`** (fine-grained PAT, contents:write on `erostalevi/nanana-releases`) as a repo secret, so tagging `cli-vX.Y.Z` publishes CLI releases automatically. v0.1.0 was uploaded by hand.
4. **Root AWS keys** are still what the CLI uses. Create an admin IAM user/SSO and deactivate the root keys.
5. Optional: GitHub branch protection on `main` (needs a plan that supports it for private repos), and request SES inbound/forwarding tests (abuse@ and support@ forward to your Gmail; the forwarder is untested end to end).
6. `infra/terraform.tfvars` holds your emails and is gitignored; keep it (or recreate from the example) to run `tofu plan` locally.

## Log
- DNS delegation of nanana.lat to Route 53 verified live.
- M0-M3 + M6 (API) done: ingress capture, SSE, lifecycle, mocks, HMAC, tunnel gateway, replay + SSRF guard, accounts (magic link, device flow, OAuth flagged, admin stats). 30 unit + 48 e2e tests pass.
- Go CLI built (32 tests, -race) and verified against the real API, locally and in production (tunnel, replay, mock).
- Web app built (65 tests): landing, docs, legal, account, admin and the live dashboard.
- AWS applied with OpenTofu (94 resources, nothing destroyed): EC2 t3.micro + data volume, Route 53 records, SES, ECR, S3 backups with us-west-2 replication, DLM snapshots, alarms, budget, OIDC roles.
- Fixes found while deploying: bash 3 empty arrays in scripts, SG description characters, XFS label length (12 chars), GitHub immutable OIDC subject, Caddy hosted-zone placeholder, Caddy DNS propagation wait, Postgres image missing CA certificates (WAL-G could not reach S3).
- Production is live: https://nanana.lat, https://api.nanana.lat, `<sub>.nanana.lat` ingress, `<sub>.tools.nanana.lat` dashboards. Verified: HTTPS wildcard certs, anonymous subdomain creation, webhook capture with real source IP, live CLI tunnel, SES domain verified (account already out of the sandbox).
- Backups verified: base backups and WAL archiving land in S3 (0 failures) and the restore drill passed.
- CLI v0.1.0 published to https://github.com/erostalevi/nanana-releases/releases and `curl -fsSL https://nanana.lat/install.sh | sh` tested.
- Leftover probe objects in the backup bucket (`pg16/probe-host`) are harmless; deleting them needs the break-glass role.
