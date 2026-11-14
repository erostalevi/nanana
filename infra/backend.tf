# State lives in an S3 bucket created by infra/bootstrap.sh, with native S3
# locking (no DynamoDB). The bucket name contains the account id, so it is
# supplied at init time:
#
#   ./init.sh            (wraps the command below)
#   tofu init -backend-config="bucket=nanana-tfstate-<account-id>"
terraform {
  backend "s3" {
    key          = "nanana/prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
