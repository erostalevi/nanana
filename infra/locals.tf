locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = "us-east-1"

  backup_bucket_name    = "nanana-backups-${local.account_id}"
  replica_bucket_name   = "nanana-backups-replica-${local.account_id}"
  inbound_bucket_name   = "nanana-inbound-mail-${local.account_id}"
  artifacts_bucket_name = "nanana-artifacts-${local.account_id}"
  state_bucket_name     = "nanana-tfstate-${local.account_id}"

  ssm_prefix = "/nanana/prod"

  metrics_namespace = "Nanana"

  # Mail addresses handled by the SES receipt rule.
  inbound_addresses = ["abuse@${var.domain}", "support@${var.domain}"]
  mail_from         = "noreply@${var.domain}"
}

data "aws_route53_zone" "main" {
  name         = var.domain
  private_zone = false
}
