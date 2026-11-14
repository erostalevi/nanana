#!/usr/bin/env bash
# Restore the latest WAL-G backup into a SCRATCH Postgres container and report row
# counts. Never touches the live database. Run on the instance as root (it needs
# the instance role to read the backup bucket), e.g. through SSM:
#
#   aws ssm start-session --target <instance-id>
#   sudo /opt/nanana/restore-drill.sh                       # latest state
#   sudo /opt/nanana/restore-drill.sh --target-time '2026-12-01 14:30:00+00'   # PITR
#
# Options:
#   --target-time TS   recover to this timestamp (point in time) instead of the latest WAL
#   --image IMAGE      postgres image (default: the one the live container runs)
#   --keep             do not delete the scratch container/data afterwards
#
# Needs free disk roughly equal to the database size on the ROOT volume
# (scratch data goes to /var/tmp, not to the pgdata volume).
set -euo pipefail

TARGET_TIME=""
IMAGE=""
KEEP=0
while (($#)); do
  case "$1" in
    --target-time) TARGET_TIME="${2:?}"; shift 2 ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ENV_FILE="/opt/nanana/.env"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
get_env() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$ENV_FILE" 2>/dev/null | tail -n1; }

BUCKET="${BACKUP_BUCKET:-$(get_env BACKUP_BUCKET)}"
if [[ -z "$BUCKET" ]]; then
  BUCKET="nanana-backups-$(aws sts get-caller-identity --query Account --output text)"
fi
if [[ -z "$IMAGE" ]]; then
  IMAGE="$(docker inspect -f '{{.Config.Image}}' nanana-postgres 2>/dev/null || true)"
fi
[[ -n "$IMAGE" ]] || { echo "cannot determine postgres image; pass --image" >&2; exit 2; }

NAME="nanana-restore-drill"
WORK="$(mktemp -d /var/tmp/nanana-restore.XXXXXX)"
DATA="$WORK/pgdata"
PREFIX_URL="s3://${BUCKET}/pg16"
SCRATCH_PW="drill-$(openssl rand -hex 8)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ "$KEEP" == 0 ]]; then
    rm -rf "$WORK"
  else
    echo "kept scratch data in $WORK"
  fi
}
trap cleanup EXIT

dock_env=(-e "WALG_S3_PREFIX=$PREFIX_URL" -e "AWS_REGION=$AWS_DEFAULT_REGION" -e WALG_COMPRESSION_METHOD=lz4)

echo "== image:  $IMAGE"
echo "== source: $PREFIX_URL"
echo "== backups available:"
docker run --rm "${dock_env[@]}" --entrypoint wal-g "$IMAGE" backup-list || {
  echo "FAILED: cannot list backups (no backup taken yet, or no access to the bucket)" >&2
  exit 1
}

echo "== fetching LATEST base backup into $DATA"
mkdir -p "$DATA"
chown 999:999 "$DATA"
docker run --rm --user 999:999 "${dock_env[@]}" -v "$DATA:/restore" --entrypoint wal-g "$IMAGE" \
  backup-fetch /restore LATEST

# Recovery: replay archived WAL on top of the base backup, then promote.
{
  echo "restore_command = '/usr/local/bin/wal-g wal-fetch \"%f\" \"%p\"'"
  echo "recovery_target_timeline = 'latest'"
  echo "recovery_target_action = 'promote'"
  if [[ -n "$TARGET_TIME" ]]; then
    echo "recovery_target_time = '$TARGET_TIME'"
    echo "recovery_target_inclusive = true"
  fi
} >>"$DATA/postgresql.auto.conf"
touch "$DATA/recovery.signal"
chown -R 999:999 "$DATA"

echo "== starting scratch postgres ($NAME)"
docker run -d --name "$NAME" --memory 400m "${dock_env[@]}" \
  -e PGUSER=nanana -e POSTGRES_PASSWORD="$SCRATCH_PW" -e PGDATA=/var/lib/postgresql/data \
  -v "$DATA:/var/lib/postgresql/data" \
  "$IMAGE" postgres -c config_file=/etc/postgresql/nanana.conf \
  -c archive_mode=off -c archive_command=/bin/true -c listen_addresses='' >/dev/null

psql_() { docker exec -u postgres "$NAME" psql -X -At -U nanana -d "${1:-nanana}" -c "$2"; }

echo "== waiting for recovery to finish (up to 15 min)"
deadline=$((SECONDS + 900))
ready=0
while ((SECONDS < deadline)); do
  if ! docker ps -q -f "name=^${NAME}\$" | grep -q .; then
    echo "FAILED: scratch container exited" >&2
    docker logs --tail 60 "$NAME" >&2 || true
    exit 1
  fi
  state="$(psql_ postgres 'select pg_is_in_recovery()' 2>/dev/null || true)"
  if [[ "$state" == "f" ]]; then ready=1; break; fi
  sleep 5
done
if [[ "$ready" != 1 ]]; then
  echo "FAILED: recovery did not complete in time" >&2
  docker logs --tail 60 "$NAME" >&2 || true
  exit 1
fi
echo "recovery complete"

echo
echo "== restored row counts (scratch)"
tables=(account identity session cli_token device_auth magic_link subdomain slug_tombstone)
for t in "${tables[@]}"; do
  if [[ "$(psql_ nanana "select to_regclass('public.\"$t\"') is not null")" == "t" ]]; then
    printf '  %-16s %s\n' "$t" "$(psql_ nanana "select count(*) from \"$t\"")"
  else
    printf '  %-16s (table does not exist yet)\n' "$t"
  fi
done
echo "  --- unlogged (never backed up, expected 0 after restore) ---"
for t in captured_request replay mock_rule; do
  if [[ "$(psql_ nanana "select to_regclass('public.\"$t\"') is not null")" == "t" ]]; then
    printf '  %-16s %s\n' "$t" "$(psql_ nanana "select count(*) from \"$t\"")"
  fi
done
echo "  latest subdomain created_at: $(psql_ nanana "select coalesce(max(created_at)::text,'-') from subdomain" 2>/dev/null || echo '-')"
echo "  latest account created_at:   $(psql_ nanana "select coalesce(max(created_at)::text,'-') from account" 2>/dev/null || echo '-')"
echo "  last heartbeat in WAL:       $(psql_ postgres "select coalesce(ts::text,'-') from wal_heartbeat limit 1" 2>/dev/null || echo '-')"

if docker ps -q -f name=nanana-postgres | grep -q .; then
  echo
  echo "== live database row counts (for comparison)"
  for t in account identity subdomain; do
    if [[ "$(docker exec -u postgres nanana-postgres psql -X -At -U nanana -d nanana -c "select to_regclass('public.\"$t\"') is not null")" == "t" ]]; then
      printf '  %-16s %s\n' "$t" "$(docker exec -u postgres nanana-postgres psql -X -At -U nanana -d nanana -c "select count(*) from \"$t\"")"
    fi
  done
fi

echo
echo "RESTORE DRILL PASSED: backup fetched, WAL replayed, database accepts queries."
