#!/usr/bin/env bash
# Render /opt/nanana/.env from every SSM parameter under /nanana/prod/.
# Runs ON THE INSTANCE (as root) using the instance role. Output mode 600.
#
#   /nanana/prod/SESSION_SECRET  ->  SESSION_SECRET='...'
#
# Values are single-quoted so docker compose does not interpolate `$`. Values
# containing a single quote or a newline are rejected.
set -euo pipefail

PREFIX="${SSM_PREFIX:-/nanana/prod/}"
OUT="${1:-/opt/nanana/.env}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

umask 077
tmp="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

json="$(aws ssm get-parameters-by-path --path "$PREFIX" --recursive --with-decryption \
  --query 'Parameters[].{n:Name,v:Value}' --output json)"

count="$(jq 'length' <<<"$json")"
if [[ "$count" -eq 0 ]]; then
  echo "render-env: no parameters under $PREFIX (run infra/scripts/seed-secrets.sh)" >&2
  exit 1
fi

# jq does the quoting so backslashes and other characters survive untouched.
# It fails (and so does this script) on bad names, newlines or single quotes.
jq -r --arg p "$PREFIX" '
  .[] | (.n | ltrimstr($p)) as $k
  | if ($k | test("^[A-Za-z_][A-Za-z0-9_]*$") | not) then error("unusable parameter name: \(.n)")
    elif (.v | test("[\n\r\u0027]")) then error("value of \($k) contains a newline or single quote")
    else "\($k)=\u0027\(.v)\u0027" end
' <<<"$json" >"$tmp"

chmod 600 "$tmp"
mv "$tmp" "$OUT"
trap - EXIT
echo "render-env: wrote $count parameters to $OUT"
