#!/usr/bin/env bash
# Deploy an image tag on the instance. Run as root through SSM Run Command:
#
#   /opt/nanana/deploy.sh <image-tag>
#
# 1. render /opt/nanana/.env from SSM Parameter Store
# 2. ECR login, record IMAGE_TAG / ECR_REGISTRY in .env
# 3. docker compose pull   (if this fails, nothing running is touched)
# 4. docker compose up -d --remove-orphans
# 5. wait for http://127.0.0.1:3001/healthz; on failure print logs, roll back to
#    the previous tag if there was one, and exit non-zero
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
DIR="/opt/nanana"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

cd "$DIR"

compose() { docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" "$@"; }

env_get() { # env_get KEY  (value from .env, empty if unset)
  [[ -f "$DIR/.env" ]] || return 0
  sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$DIR/.env" | tail -n1
}

set_env() { # set_env KEY VALUE (appends to .env; render-env.sh has already rewritten it)
  printf "%s='%s'\n" "$1" "$2" >>"$DIR/.env"
}

write_runtime_env() { # write_runtime_env TAG
  "$DIR/render-env.sh" "$DIR/.env"
  set_env IMAGE_TAG "$1"
  set_env ECR_REGISTRY "$REGISTRY"
  chmod 600 "$DIR/.env"
}

wait_healthy() {
  local host deadline
  host="api.$(env_get BASE_DOMAIN)"
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  echo "waiting up to ${HEALTH_TIMEOUT}s for http://127.0.0.1:3001/healthz (Host: $host)"
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 5 -H "Host: $host" http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
      echo "healthy"
      return 0
    fi
    sleep 3
  done
  return 1
}

PREV_TAG="$(env_get IMAGE_TAG)"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com"

echo "== deploy ${TAG} (previous: ${PREV_TAG:-none}) =="
write_runtime_env "$TAG"

aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"

echo "== pull =="
if ! compose pull; then
  echo "pull failed; leaving the running containers untouched" >&2
  if [[ -n "$PREV_TAG" ]]; then write_runtime_env "$PREV_TAG"; fi
  exit 1
fi

echo "== up =="
compose up -d --remove-orphans

if ! wait_healthy; then
  echo "== UNHEALTHY after deploy of ${TAG} ==" >&2
  compose ps >&2 || true
  for svc in api postgres caddy; do
    echo "---- logs: $svc (last 80 lines) ----" >&2
    compose logs --no-color --tail 80 "$svc" >&2 || true
  done
  if [[ -n "$PREV_TAG" && "$PREV_TAG" != "$TAG" ]]; then
    echo "== rolling back to ${PREV_TAG} ==" >&2
    write_runtime_env "$PREV_TAG"
    compose up -d --remove-orphans || true
    if wait_healthy; then echo "rollback healthy" >&2; else echo "rollback ALSO unhealthy" >&2; fi
  fi
  exit 1
fi

# First deploy: take the initial base backup right away so PITR works from day one.
if ! timeout 60 docker exec -u postgres nanana-postgres wal-g backup-list </dev/null 2>/dev/null | grep -q base_; then
  echo "no base backup yet; starting one in the background"
  systemctl start --no-block nanana-backup.service || true
fi

docker image prune -f >/dev/null 2>&1 || true

echo "== compose ps =="
compose ps
echo "deploy ${TAG} OK"
