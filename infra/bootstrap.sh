#!/usr/bin/env bash
# Idempotently create the S3 bucket that holds the OpenTofu state.
#
#   AWS_PROFILE=... ./bootstrap.sh
#
# Bucket: nanana-tfstate-<account-id> in us-east-1, versioned, encrypted,
# public access blocked, TLS-only. Safe to re-run; it never deletes anything.
set -euo pipefail

REGION="us-east-1"
PROFILE_ARGS=()
if [[ -n "${AWS_PROFILE:-}" ]]; then PROFILE_ARGS=(--profile "$AWS_PROFILE"); fi
aws_() { aws "${PROFILE_ARGS[@]}" --region "$REGION" "$@"; }

ACCOUNT_ID="$(aws_ sts get-caller-identity --query Account --output text)"
BUCKET="nanana-tfstate-${ACCOUNT_ID}"
echo "Account: ${ACCOUNT_ID}"
echo "Bucket:  ${BUCKET}"

if aws_ s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket already exists, re-applying settings."
else
  # us-east-1 must not receive a LocationConstraint.
  aws_ s3api create-bucket --bucket "$BUCKET" >/dev/null
  echo "Bucket created."
fi

aws_ s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws_ s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws_ s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

aws_ s3api put-bucket-ownership-controls --bucket "$BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"],
      "Condition": {"Bool": {"aws:SecureTransport": "false"}}
    }
  ]
}
JSON
)"
aws_ s3api put-bucket-policy --bucket "$BUCKET" --policy "$POLICY"

# Keep old state versions for a year, then let them expire.
aws_ s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-old-state-versions","Status":"Enabled","Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":365},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'

aws_ s3api put-bucket-tagging --bucket "$BUCKET" \
  --tagging 'TagSet=[{Key=project,Value=nanana}]'

cat <<MSG

Done. Next:
  cd infra && cp terraform.tfvars.example terraform.tfvars   # edit emails
  ./init.sh
  tofu plan
MSG
