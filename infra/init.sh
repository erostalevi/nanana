#!/usr/bin/env bash
# Initialise OpenTofu against the state bucket created by bootstrap.sh.
# Usage: ./init.sh [extra tofu init args]
set -euo pipefail
cd "$(dirname "$0")"

PROFILE_ARGS=()
if [[ -n "${AWS_PROFILE:-}" ]]; then PROFILE_ARGS=(--profile "$AWS_PROFILE"); fi

ACCOUNT_ID="$(aws sts get-caller-identity "${PROFILE_ARGS[@]}" --query Account --output text)"
BUCKET="nanana-tfstate-${ACCOUNT_ID}"

exec tofu init -backend-config="bucket=${BUCKET}" "$@"
