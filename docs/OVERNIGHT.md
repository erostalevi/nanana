# Overnight log

Autonomy granted by the owner: apply AWS infra (cap $25/mo, never destroy existing resources), create `erostalevi/nanana-releases` (public), merge own PRs to main with auto-deploy, push directly for scaffolding/docs, set Actions variables and branch protection, install local tooling (terraform, colima/docker, Playwright). OAuth apps (GitHub/Google) are NOT created yet: ship magic-link only, SSO feature-flagged off. Operator for legal pages: individual in Chile, contact abuse@nanana.lat.

## Blockers and TODOs for the owner
- OpenTofu (`tofu`) is used instead of Terraform (the terraform formula is gone from Homebrew); HCL is identical.
- OAuth apps for GitHub/Google are not created: `AUTH_GITHUB`/`AUTH_GOOGLE` stay false until you add client IDs/secrets (callbacks: `https://api.nanana.lat/auth/github/callback`, `https://api.nanana.lat/auth/google/callback`).
- `RELEASES_TOKEN` (fine-grained PAT with contents:write on erostalevi/nanana-releases) must be added as a repo secret for the automated CLI release workflow; until then CLI binaries are uploaded manually.

## Log
- DNS delegation of nanana.lat to Route 53 verified live.
- M0-M3 + M6 (API) done: ingress capture, SSE, lifecycle, mocks, HMAC, tunnel gateway, replay + SSRF guard, accounts (magic link, device flow, OAuth flagged, admin stats). 29 unit + 48 e2e tests pass.
- Go CLI built by a subagent (32 tests pass with -race) and verified manually against the real API: tunnel, replay-through-tunnel and mock all work end to end.
- Created public repo erostalevi/nanana-releases.
