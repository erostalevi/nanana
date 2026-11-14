#!/usr/bin/env bash
# Publishes custom CloudWatch metrics (namespace Nanana). Run every 5 minutes
# by nanana-metrics.timer.
#
#   DiskUsedPercent{Volume=root|data}   percent used
#   WalArchiveLagSeconds                seconds since the last successful WAL
#                                       archive (99999 when Postgres is down
#                                       or archiving is failing)
#   PostgresUp                          1/0
set -uo pipefail

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
NS="Nanana"
PG_CONTAINER="nanana-postgres"
DEPLOYED_MARKER="/opt/nanana/.env"

put() { # name value unit [dimension]
  local args=(--namespace "$NS" --metric-name "$1" --value "$2" --unit "$3")
  if [[ -n "${4:-}" ]]; then args+=(--dimensions "$4"); fi
  aws cloudwatch put-metric-data "${args[@]}" || echo "put-metric-data failed for $1" >&2
}

pct() { df --output=pcent "$1" 2>/dev/null | tail -n1 | tr -dc '0-9'; }

root_pct="$(pct /)"
data_pct="$(pct /var/lib/nanana/pgdata)"
[[ -n "$root_pct" ]] && put DiskUsedPercent "$root_pct" Percent Volume=root
[[ -n "$data_pct" ]] && put DiskUsedPercent "$data_pct" Percent Volume=data

psql_() { docker exec -u postgres "$PG_CONTAINER" psql -X -At -d postgres "$@"; }

up=0
lag=99999
if [[ -f "$DEPLOYED_MARKER" ]] && psql_ -c 'select 1' >/dev/null 2>&1; then
  up=1
  # Tiny logged write + WAL switch so an idle database still archives a segment
  # every cycle; otherwise "lag" would grow while nothing is wrong.
  psql_ -c 'create table if not exists wal_heartbeat (id int primary key, ts timestamptz not null)' >/dev/null 2>&1
  psql_ -c "insert into wal_heartbeat values (1, now()) on conflict (id) do update set ts = excluded.ts" >/dev/null 2>&1
  psql_ -c 'select pg_switch_wal()' >/dev/null 2>&1
  sleep 20 # give archive_command a moment
  # If the latest attempt failed, count lag from the last success (or from postmaster start).
  v="$(psql_ -c "select floor(extract(epoch from now() - coalesce(last_archived_time, pg_postmaster_start_time())))::bigint from pg_stat_archiver" 2>/dev/null || true)"
  if [[ "$v" =~ ^[0-9]+$ ]]; then lag="$v"; fi
fi
put PostgresUp "$up" Count
put WalArchiveLagSeconds "$lag" Seconds
