# nanana.lat infrastructure

Everything that runs nanana.lat in production: one EC2 box, Docker Compose, OpenTofu,
GitHub Actions. Source of truth for requirements is `SPEC.md` section 14 and 15.
This document is the operator's manual.

Repository layout:

| Path | What |
|---|---|
| `infra/` | OpenTofu (Terraform syntax) for all AWS resources, `bootstrap.sh`, `init.sh`, helper scripts |
| `infra/scripts/seed-secrets.sh` | creates `/nanana/prod/*` in SSM Parameter Store |
| `infra/scripts/restore-drill.sh` | restores the latest backup into a scratch Postgres |
| `infra/files/` | systemd units and the metrics script baked into the instance user-data |
| `infra/lambda/forwarder.py` | SES inbound forwarder (abuse@ / support@) |
| `deploy/` | what runs on the instance: `docker-compose.yml`, `deploy.sh`, `render-env.sh`, three images |
| `deploy/api`, `deploy/caddy`, `deploy/postgres` | Dockerfiles (Caddy image also builds the React app and carries `install.sh`) |
| `.github/workflows/` | `ci.yml`, `deploy.yml`, `release-cli.yml` |

## Architecture

```
                         Route 53 zone nanana.lat (pre-existing)
   A  nanana.lat | *.nanana.lat | *.tools.nanana.lat | api.nanana.lat  -> Elastic IP
   CNAME www -> nanana.lat     MX -> SES inbound     DKIM / SPF / DMARC for SES

                               Elastic IP
                                   |
                     SG: tcp 80/443 only (v4+v6), no SSH
                                   |
   +------------------- EC2 t3.micro, Amazon Linux 2023, IMDSv2 ----------------------+
   |  root gp3 20 GB          data gp3 10 GB  -> /var/lib/nanana/pgdata (own volume)  |
   |  1 GB swapfile                                                                   |
   |                                                                                  |
   |  docker compose (restart: unless-stopped, json-file log rotation)                |
   |   +-------------+  :3001   +-------------+   5432   +---------------------+     |
   |   | caddy 96m   |--------->| api 320m    |--------->| postgres 16 280m    |     |
   |   | TLS DNS-01  |  (Nest)  | node 24     |          | + WAL-G archiving   |     |
   |   | SPA, /install.sh       +-------------+          +----------+----------+     |
   |   +------+------+                                              |                |
   |          | Route 53 TXT (instance role)                        | wal-push, base |
   |  systemd: nanana.service (compose up at boot), nanana-metrics.timer (5 min),     |
   |           nanana-backup.timer (weekly base backup)                               |
   +----------+---------------------------------------------------+------------------+
              |                                                   |
      Let's Encrypt                                  S3 nanana-backups-<acct> (us-east-1)
                                                      versioned, SSE, no deletes except
   GitHub Actions --OIDC--> nanana-gh-deploy           break-glass, lifecycle 40 d
      build amd64 images -> ECR (api, caddy, postgres)     |  cross-region replication
      S3 artifacts (compose + scripts)                     v
      SSM Run Command -> deploy.sh                S3 nanana-backups-replica-<acct> (us-west-2)

   EBS snapshots of the data volume: DLM, 7 daily + 4 weekly.
   Alerts: CloudWatch alarms + AWS Budget -> SNS nanana-alerts -> email.
   Mail:  SES inbound (abuse@, support@) -> S3 -> Lambda -> forwards to the owner.
          SES outbound (noreply@) from the API through the instance role.
```

Routing (Caddy, `deploy/caddy/Caddyfile`):

| Host | Served by |
|---|---|
| `nanana.lat`, `www.nanana.lat` | static React app (SPA fallback); `/install.sh` is the CLI installer |
| `*.tools.nanana.lat` | same static React app (dashboards) |
| `api.nanana.lat` and every other `*.nanana.lat` | reverse proxy to `api:3001` (WebSocket and SSE safe, 12 MB body limit) |

Certificates: one for `nanana.lat` + `www`, wildcards for `*.nanana.lat` and `*.tools.nanana.lat`,
all by DNS-01 against Route 53 using the instance role.

## Cost (us-east-1, on-demand, approximate)

| Item | $/month |
|---|---|
| EC2 t3.micro | 7.60 |
| Public IPv4 (Elastic IP) | 3.65 |
| Root gp3 20 GB | 1.60 |
| Data gp3 10 GB | 0.80 |
| EBS snapshots (incremental, 11 kept) | 0.30 to 0.60 |
| S3 backups (primary + replica) and replication transfer | 0.30 to 1.00 |
| ECR (3 repos, 10 images each) | 0.15 to 0.30 |
| CloudWatch (alarms and 4 custom metrics are in the free tier; PutMetricData calls) | 0.35 |
| SES, Lambda, SNS, Budgets | about 0 at this volume |
| Route 53 hosted zone (already exists) | 0.50 |
| **Total** | **about 15 to 17** |

The budget alarm is $25/month across the whole account (80% and 100% actual, 100% forecast).
CPU credits are `standard`, so a CPU spike can never create surprise bills.

## First-time bootstrap runbook

Prerequisites on your machine: AWS CLI configured for the account (us-east-1), OpenTofu (`tofu`),
Docker (optional, for local image checks), `gh` (for repo variables).

### 1. State bucket

```bash
cd infra
./bootstrap.sh          # creates nanana-tfstate-<account-id>; safe to re-run
```

### 2. Variables

```bash
cp terraform.tfvars.example terraform.tfvars   # gitignored
$EDITOR terraform.tfvars                       # alert_email, forward_email (never commit)
```

Optional: `github_repo` (default `erostalevi/nanana`), `aws_profile` (default null).

### 3. Init, plan, review, apply

```bash
./init.sh               # tofu init with -backend-config bucket=nanana-tfstate-<account-id>
tofu plan -out=tfplan
tofu apply tfplan       # the owner applies; CI only plans
```

Notes on the first apply:

- The Route 53 zone `nanana.lat` is only looked up, never created or changed.
- If the account already has a GitHub OIDC provider, set `create_github_oidc_provider = false`
  (the account had none when this was written; the default creates it).
- `aws_ses_domain_identity_verification` waits for the DNS record created in the same apply.
- Two emails arrive and each needs ONE click: the SNS subscription confirmation (to `alert_email`)
  and the SES address verification (to `forward_email`, required while SES is in the sandbox).
- The instance takes 3 to 5 minutes after creation to finish `user-data`
  (`/var/log/nanana-bootstrap.log` on the box, readable through Session Manager).
- Until the first deploy, the `nanana-wal-archive-lag` and `nanana-postgres-down` alarms fire by
  design (missing data counts as breaching). They clear after the first deploy.

### 4. GitHub repository settings

From the outputs (`tofu output`):

```bash
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(tofu output -raw github_deploy_role_arn)"
gh variable set AWS_PLAN_ROLE_ARN   --body "$(tofu output -raw github_plan_role_arn)"
gh secret set ALERT_EMAIL            # CI plan needs the same values as terraform.tfvars
gh secret set FORWARD_EMAIL
gh secret set RELEASES_TOKEN         # see "Manual steps", needed only for CLI releases
```

### 5. Seed secrets and config

```bash
infra/scripts/seed-secrets.sh --dry-run   # shows what it would create
infra/scripts/seed-secrets.sh
```

Creates, only if missing (never overwrites a secret):
`SESSION_SECRET`, `ENCRYPTION_KEY` (32 random bytes, base64), `IP_HASH_SECRET`, `POSTGRES_PASSWORD`,
`DATABASE_URL` (SecureString), and the non-secret config `NODE_ENV`, `BASE_DOMAIN`, `PORT`,
`TRUST_PROXY`, `MAIL_DRIVER=ses`, `MAIL_FROM`, `AWS_REGION`, `PUBLIC_API_URL`, `AUTH_GITHUB=false`,
`AUTH_GOOGLE=false`, `HOSTED_ZONE_ID`, `BACKUP_BUCKET`. `--force-config` resets the non-secret
values to these defaults. The values never pass through OpenTofu or its state.

### 6. First deploy

Merge to `main` (or run the Deploy workflow manually from `main`). The workflow builds the three
images for linux/amd64, pushes them to ECR tagged with the commit sha and `latest`, uploads
`docker-compose.yml`, `deploy.sh`, `render-env.sh`, `restore-drill.sh` to
`s3://nanana-artifacts-<acct>/deploy/<sha>/`, then runs on the instance through SSM:

1. `render-env.sh` writes `/opt/nanana/.env` (mode 600) from all of `/nanana/prod/*`.
2. ECR login, `IMAGE_TAG` and `ECR_REGISTRY` appended to `.env`.
3. `docker compose pull` (if it fails, running containers are not touched).
4. `docker compose up -d --remove-orphans`.
5. Waits for `http://127.0.0.1:3001/healthz`. On failure it prints logs, rolls back to the previous
   tag if there was one, and exits non-zero.
6. If no base backup exists yet it starts one in the background.

The first start also issues the certificates (about a minute). The workflow finishes by polling
`https://api.nanana.lat/healthz`.

### 7. Verify

- `curl https://api.nanana.lat/healthz`
- Confirm a base backup exists and WAL is arriving:
  `aws s3 ls s3://nanana-backups-<acct>/pg16/ --recursive | tail`
- Run the restore drill once (see below) before launch, then monthly.
- Check the alarms are OK and the SNS email subscription is confirmed.

### Day to day

- Deploy: merge to `main`. Re-run: Actions, Deploy, "Run workflow" from `main`.
- Shell on the box (no SSH exists): `aws ssm start-session --target <instance-id>`.
- Logs: `docker compose -f /opt/nanana/docker-compose.yml logs -f api` (json-file, 3 x 10 MB per container).
- Infra changes: edit `infra/`, open a PR (CI posts the plan), merge, then run `tofu apply` locally.
  CI never applies: giving a GitHub role the rights to apply this stack would make it close to
  administrator, which defeats the point of OIDC with least privilege.

## Backups and restore

Layers, from fastest to most remote:

1. **Postgres on its own EBS volume** (`delete_on_termination=false`, `prevent_destroy`, instance
   termination protection). Replacing or losing the instance does not touch the data.
2. **WAL-G continuous archiving** to `s3://nanana-backups-<acct>/pg16/`: every WAL segment is pushed
   by `archive_command` (also forced at least every 2 minutes with activity, and every 5 minutes by
   the metrics timer's heartbeat). A **base backup runs weekly** (Sunday 03:00 UTC, timer
   `nanana-backup.timer`). Result: point-in-time recovery to any second in the last 30 days.
3. **Bucket protection**: versioning, SSE-S3, public access blocked, TLS only, and a bucket policy
   that denies `DeleteObject`/`DeleteObjectVersion` to everyone except the break-glass role.
   The instance role cannot delete either. Retention is by S3 lifecycle: 40 days (30 days PITR plus
   7 days between weekly base backups plus margin, so a base backup older than any point in the
   window always still exists), noncurrent versions after 7 days.
4. **Cross-region replica** in `us-west-2` (same protections; deletes are not replicated).
5. **Daily EBS snapshots** of the data volume by Data Lifecycle Manager: 7 daily + 4 weekly.

Captured payloads (`captured_request`, `replay`, `mock_rule`) are UNLOGGED tables: they are not in WAL
or backups on purpose, and are empty after any restore.

### Restore drill

Restores the latest base backup plus archived WAL into a scratch container (never touches the live
database) and prints row counts for `account`, `identity`, `session`, `cli_token`, `device_auth`,
`magic_link`, `subdomain`, `slug_tombstone`, next to the live counts.

```bash
aws ssm start-session --target <instance-id>
sudo /opt/nanana/restore-drill.sh                                    # latest
sudo /opt/nanana/restore-drill.sh --target-time '2026-12-01 14:30:00+00'   # point in time
```

It needs free space on the root volume about the size of the database. Run it before launch and
monthly. A passing run ends with `RESTORE DRILL PASSED`.

### Real restore procedures

**A. Instance died, data volume fine.** The volume survives with its data. Replace the instance:
disable termination protection (`aws ec2 modify-instance-attribute --instance-id i-... --no-disable-api-termination`),
`tofu apply -replace=aws_instance.app`, wait for user-data, then run the Deploy workflow. The new
instance mounts the existing filesystem (it is only formatted when empty). Postgres replays its own WAL
and starts.

**B. Data volume lost or corrupted, S3 backups fine** (the usual disaster path):

```bash
aws ssm start-session --target <instance-id>
sudo systemctl stop nanana.service           # stops compose
# the mount point itself stays; move the old cluster aside inside it (skip if the volume is empty/new)
sudo mv /var/lib/nanana/pgdata/pgdata /var/lib/nanana/pgdata/pgdata.broken
sudo mkdir -p /var/lib/nanana/pgdata/pgdata && sudo chown -R 999:999 /var/lib/nanana/pgdata
source /opt/nanana/.env
IMG=$(docker inspect -f '{{.Config.Image}}' nanana-postgres)
docker run --rm --user 999:999 -v /var/lib/nanana/pgdata:/restore \
  -e WALG_S3_PREFIX="s3://${BACKUP_BUCKET}/pg16" -e AWS_REGION=us-east-1 --entrypoint wal-g "$IMG" \
  backup-fetch /restore/pgdata LATEST
# tell Postgres to recover from the archive, optionally to a point in time:
cat >> /var/lib/nanana/pgdata/pgdata/postgresql.auto.conf <<'EOF'
restore_command = '/usr/local/bin/wal-g wal-fetch "%f" "%p"'
recovery_target_timeline = 'latest'
recovery_target_action = 'promote'
# recovery_target_time = '2026-12-01 14:30:00+00'
EOF
touch /var/lib/nanana/pgdata/pgdata/recovery.signal
sudo chown -R 999:999 /var/lib/nanana/pgdata
sudo systemctl start nanana.service
docker logs -f nanana-postgres     # wait for "database system is ready to accept connections"
```

Then trigger a new base backup: `sudo systemctl start nanana-backup.service`.
(WAL-G uses `AWS_REGION` and the instance role; `PGUSER` is set in the compose file and not needed here.)
Try the whole thing with `restore-drill.sh` first so the commands are familiar.

**C. From an EBS snapshot.** Create a volume from the newest snapshot of the data volume (tag
`Snapshot=nanana-pgdata`) in the instance's AZ, stop the stack, swap volumes, start. Postgres performs
crash recovery. Snapshots are crash-consistent, which Postgres handles. WAL archiving continues in a new
timeline; run a base backup afterwards.

**D. us-east-1 lost.** Use the replica bucket `nanana-backups-replica-<acct>` (us-west-2) as
`WALG_S3_PREFIX=s3://nanana-backups-replica-<acct>/pg16` from a new stack in another region
(procedure B on the new host).

## Break-glass role

Role `nanana-backup-breakglass` is the only principal the backup bucket policies let delete objects
or versions. It exists so a mistake (or an attacker with the instance role) cannot destroy backups,
while the owner is not locked out.

```bash
aws sts assume-role --role-arn "$(cd infra && tofu output -raw breakglass_role_arn)" \
  --role-session-name breakglass --duration-seconds 900
# export the returned AccessKeyId/SecretAccessKey/SessionToken, then for example:
aws s3api list-object-versions --bucket nanana-backups-<acct> --prefix pg16/basebackups_005/
aws s3api delete-object --bucket nanana-backups-<acct> --key <key> --version-id <id>
```

It is trusted for the account root principal, so anything in the account with `sts:AssumeRole` rights
can use it; set `breakglass_require_mfa = true` once you operate through an IAM user with MFA
(root access keys cannot carry an MFA context, so it is off by default).
Consequence: `tofu destroy` of the backup buckets is blocked by design (and by `prevent_destroy`).
If you ever lock yourself out of the bucket policy, the account root user can always delete the bucket
policy itself.

## Alerts

SNS topic `nanana-alerts` emails `alert_email`. Alarms: EC2 status check failed (10 min), disk above 80%
on root and on the data volume, WAL archive lag above 15 minutes (also fires if Postgres is down or
the metrics timer stops), Postgres container down, and the $25/month budget (80% actual, 100% actual,
100% forecast; account-wide). Custom metrics (namespace `Nanana`) come from `nanana-metrics.timer`
every 5 minutes: `DiskUsedPercent{Volume=root|data}`, `WalArchiveLagSeconds`, `PostgresUp`.

## Rotating secrets

All parameters are under `/nanana/prod/`. After changing any value, deploy again (the Deploy workflow, or
`/opt/nanana/deploy.sh <current-tag>` through SSM): `render-env.sh` rebuilds `.env` and compose recreates
the containers whose environment changed.

```bash
# generic: write a new value (overwrite is deliberate here)
aws ssm put-parameter --name /nanana/prod/SESSION_SECRET --type SecureString --overwrite \
  --value "$(openssl rand -hex 32)"
```

| Secret | Effect of rotating |
|---|---|
| `SESSION_SECRET` | all web sessions are signed out. Safe. |
| `IP_HASH_SECRET` | per-IP creation limits reset (old hashes no longer match). Safe. |
| `ENCRYPTION_KEY` | **breaks stored HMAC secrets** (AES-256-GCM). Only rotate with a re-encryption migration; otherwise users re-enter their HMAC secrets. |
| `POSTGRES_PASSWORD` + `DATABASE_URL` | change the role password first: `docker exec -u postgres nanana-postgres psql -U nanana -c "ALTER USER nanana PASSWORD '<new>'"`, update BOTH parameters (`DATABASE_URL` embeds the password), then deploy. |

Values must not contain a single quote or newline (`render-env.sh` refuses them). SecureStrings use the
default `aws/ssm` KMS key; the instance role decrypts through SSM only (`kms:ViaService`).

## Resizing

- **Instance**: set `instance_type = "t3.small"` in `terraform.tfvars`, `tofu apply`. AWS stops and starts
  the instance in place (about a minute of downtime; the Elastic IP, both volumes and DNS stay).
  Then raise the compose `mem_limit` values if you want to use the memory
  (for example api 640m, postgres 560m) and the Postgres `shared_buffers` in `deploy/postgres/nanana.conf`.
- **Data volume**: raise `data_volume_gb`, `tofu apply`, then on the box `sudo xfs_growfs /var/lib/nanana/pgdata`.
- **Root volume**: raise `root_volume_gb`, `tofu apply`, then `sudo growpart /dev/nvme0n1 1 && sudo xfs_growfs /`.
- Edits to `infra/userdata.sh.tftpl` and `infra/files/*` only apply to NEW instances (`user_data` and `ami`
  are in `ignore_changes` so a newer AMI can never replace the box silently). To change a host file on the
  running instance, edit it over SSM and keep the repo copy in sync, or replace the instance (procedure A).

## Security notes

- No SSH, no key pair, security group allows only 80/443. Shell access is SSM Session Manager.
- IMDSv2 required, hop limit 2. **Tradeoff:** containers need the instance role (WAL-G, SES, Route 53), and
  Docker adds a network hop, so hop limit 1 would break them. The API is also exposed to server-side URL
  replay, and its SSRF guard rejects link-local addresses (including `169.254.169.254`) and resolves DNS
  itself. A host firewall rule that blocks the API container from the metadata service would be a second layer, but the API
  itself needs the role for SES, so the rule cannot be on by default. Mitigations in place: IMDSv2
  needs a PUT with a custom header, the instance role is narrow (no deletes in S3, TXT-only Route 53,
  no IAM), and the app-level guard. The compose network has a fixed subnet (`172.30.0.0/24`), so if SES
  ever moves to SMTP credentials you can add the opt-in rule on the host:
  `iptables -I DOCKER-USER -s 172.30.0.0/24 -d 169.254.169.254 -j DROP` (this also blocks caddy and
  postgres from the role, so it needs a split network first).
- The CSP in `deploy/caddy/Caddyfile` for the SPA hosts is strict (`script-src 'self'`, no inline scripts,
  `connect-src` limited to `self`, `api.nanana.lat` and `*.nanana.lat`). If the web app needs another origin
  (fonts, analytics), change it there.
- Access logs omit request bodies and query strings; Authorization and cookies are redacted by Caddy.
- GitHub roles: `nanana-gh-deploy` only for `refs/heads/main` (ECR push, SSM run on the tagged instance,
  S3 upload of deploy files, read of non-secret parameters; it cannot decrypt SecureStrings).
  `nanana-gh-plan` only for pull requests (read-only; state read only, plans run with `-lock=false`).
  The existing `erostalevi-landing-github-deploy` role belongs to another repo and is untouched.

## Manual steps for the owner (checklist)

Before the first apply:
- [ ] `infra/bootstrap.sh`, then fill `infra/terraform.tfvars` (alert and forward emails), `./init.sh`, review `tofu plan`, `tofu apply`.
- [ ] Click the **SNS subscription confirmation** email (alerts do nothing until you do).
- [ ] Click the **SES verification** email sent to `forward_email`.

GitHub:
- [ ] Set repository variables `AWS_DEPLOY_ROLE_ARN` and `AWS_PLAN_ROLE_ARN` (from `tofu output`).
- [ ] Set repository secrets `ALERT_EMAIL` and `FORWARD_EMAIL` (used only by the CI plan; without them the plan step is skipped).
- [ ] Create the public repo `erostalevi/nanana-releases` with an initial commit (GoReleaser creates the releases there).
- [ ] Create a fine-grained personal access token with **Contents: read and write on `erostalevi/nanana-releases` only**
      and store it as the repository secret `RELEASES_TOKEN`. Only the owner can create it; releases fail with a clear message without it.
      Tag a release with `git tag cli-v0.1.0 && git push origin cli-v0.1.0` (published as `v0.1.0` in the releases repo).
- [ ] Optional: branch protection on `main` requiring the CI jobs.

Before launch:
- [ ] `infra/scripts/seed-secrets.sh`, then the first deploy (merge to `main`).
- [ ] Confirm the first base backup completed and run `restore-drill.sh` (then monthly).
- [ ] **Request SES production access** (sandbox only mails verified addresses, so magic links do not reach users until then).
- [ ] When DMARC reports look clean, change the `_dmarc` record in `infra/dns.tf` from `p=none` to `quarantine`/`reject`.
- [ ] Consider moving off AWS root access keys to a scoped admin user (set `aws_profile`); the roles here are already least-privilege.
- [ ] OAuth apps (GitHub, Google) when you want SSO: create them, add client IDs/secrets as `/nanana/prod/...`
      SecureStrings, set `AUTH_GITHUB`/`AUTH_GOOGLE` to `true`, deploy.
- [ ] Monthly: restore drill; review the budget and alarm emails.

## Reference: AWS resources

All tagged `project=nanana`. EC2 instance (`role=app`, termination protection), Elastic IP, security group
`nanana-app`, EBS data volume `nanana-pgdata` (prevent_destroy), IAM roles `nanana-app-instance`,
`nanana-gh-deploy`, `nanana-gh-plan`, `nanana-backup-breakglass`, `nanana-backup-replication`, `nanana-dlm`,
`nanana-mail-forwarder`, GitHub OIDC provider (created by this stack unless disabled), ECR `nanana-api`,
`nanana-caddy`, `nanana-postgres` (scan on push, last 10 images), S3 `nanana-backups-<acct>`,
`nanana-backups-replica-<acct>` (us-west-2), `nanana-artifacts-<acct>`, `nanana-inbound-mail-<acct>`,
DLM policy, Route 53 records in the existing zone, SES identities and receipt rule set `nanana-inbound`
(activated), Lambda `nanana-mail-forwarder`, SNS topic `nanana-alerts`, CloudWatch alarms, budget `nanana-monthly`.
OpenTofu state: `s3://nanana-tfstate-<acct>/nanana/prod/terraform.tfstate` (created by `bootstrap.sh`, not by OpenTofu).
