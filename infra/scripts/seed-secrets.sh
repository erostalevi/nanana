#!/usr/bin/env bash
# Create /nanana/prod/* parameters in SSM Parameter Store, idempotently.
#
#   AWS_PROFILE=... ./seed-secrets.sh [--force-config] [--dry-run]
#
# Secrets (SecureString) are generated randomly and NEVER overwritten
# (--no-overwrite). Non-secret config (String) is created if missing; pass
# --force-config to overwrite config values with the defaults below.
# Secret values are never printed. OpenTofu does not manage these parameters,
# so no secret ever lands in Terraform state.
set -euo pipefail

REGION="us-east-1"
PREFIX="/nanana/prod"
FORCE_CONFIG=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force-config) FORCE_CONFIG=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PROFILE_ARGS=()
if [[ -n "${AWS_PROFILE:-}" ]]; then PROFILE_ARGS=(--profile "$AWS_PROFILE"); fi
aws_() { aws ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} --region "$REGION" "$@"; }

ACCOUNT_ID="$(aws_ sts get-caller-identity --query Account --output text)"
umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

get_param() { # name -> value (decrypted) or empty
  aws_ ssm get-parameter --name "$PREFIX/$1" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || true
}

# put_new TYPE NAME VALUE : create only if missing
put_new() {
  local type="$1" name="$2" value="$3"
  if [[ "$DRY_RUN" == 1 ]]; then echo "[dry-run] would create $PREFIX/$name ($type)"; return; fi
  printf '%s' "$value" >"$TMP/value"
  if out="$(aws_ ssm put-parameter --name "$PREFIX/$name" --type "$type" --value "file://$TMP/value" \
      --no-overwrite --tags Key=project,Value=nanana 2>&1)"; then
    echo "created  $PREFIX/$name ($type)"
  elif grep -q ParameterAlreadyExists <<<"$out"; then
    echo "exists   $PREFIX/$name (kept)"
  else
    echo "$out" >&2
    exit 1
  fi
}

put_config() { # NAME VALUE (String; overwritten only with --force-config)
  local name="$1" value="$2"
  if [[ "$FORCE_CONFIG" == 1 && "$DRY_RUN" == 0 ]]; then
    aws_ ssm put-parameter --name "$PREFIX/$name" --type String --value "$value" --overwrite >/dev/null
    echo "set      $PREFIX/$name (String, forced)"
  else
    put_new String "$name" "$value"
  fi
}

# ---- secrets ------------------------------------------------------------------------
put_new SecureString SESSION_SECRET "$(openssl rand -hex 32)"
put_new SecureString ENCRYPTION_KEY "$(openssl rand -base64 32)" # 32 bytes, base64 (AES-256-GCM)
put_new SecureString IP_HASH_SECRET "$(openssl rand -hex 32)"
put_new SecureString POSTGRES_PASSWORD "$(openssl rand -hex 24)"

# DATABASE_URL embeds the password, so it is a SecureString. Reuse the stored password.
pw="$(get_param POSTGRES_PASSWORD)"
if [[ -z "$pw" || "$pw" == "None" ]]; then
  if [[ "$DRY_RUN" == 1 ]]; then pw="dry-run"; else echo "POSTGRES_PASSWORD missing after creation" >&2; exit 1; fi
fi
put_new SecureString DATABASE_URL "postgres://nanana:${pw}@postgres:5432/nanana"

# ---- non-secret config --------------------------------------------------------------
# shellcheck disable=SC2016  # the backticks are JMESPath literals, not shell
zone_id="$(aws_ route53 list-hosted-zones-by-name --dns-name nanana.lat --max-items 1 \
  --query 'HostedZones[?Name==`nanana.lat.`].Id | [0]' --output text | sed 's#/hostedzone/##')"
if [[ -z "$zone_id" || "$zone_id" == "None" ]]; then
  echo "hosted zone nanana.lat not found" >&2
  exit 1
fi

put_config NODE_ENV production
put_config BASE_DOMAIN nanana.lat
put_config PORT 3001
put_config TRUST_PROXY true
put_config MAIL_DRIVER ses
put_config MAIL_FROM noreply@nanana.lat
put_config AWS_REGION "$REGION"
put_config PUBLIC_API_URL https://api.nanana.lat
put_config AUTH_GITHUB false
put_config AUTH_GOOGLE false
put_config HOSTED_ZONE_ID "$zone_id"
put_config BACKUP_BUCKET "nanana-backups-${ACCOUNT_ID}"

echo
echo "Done. Parameters under $PREFIX:"
aws_ ssm describe-parameters --parameter-filters "Key=Path,Option=Recursive,Values=$PREFIX" \
  --query 'Parameters[].[Name,Type]' --output text | sort
