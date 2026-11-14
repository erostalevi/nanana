output "instance_id" {
  value = aws_instance.app.id
}

output "elastic_ip" {
  value = aws_eip.app.public_ip
}

output "data_volume_id" {
  value = aws_ebs_volume.data.id
}

output "hosted_zone_id" {
  value = data.aws_route53_zone.main.zone_id
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "backup_bucket" {
  value = aws_s3_bucket.backup.bucket
}

output "backup_replica_bucket" {
  value = aws_s3_bucket.replica.bucket
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "inbound_mail_bucket" {
  value = aws_s3_bucket.inbound.bucket
}

output "breakglass_role_arn" {
  value = aws_iam_role.breakglass.arn
}

# Set these as GitHub repository variables.
output "github_deploy_role_arn" {
  description = "Repo variable AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.gh_deploy.arn
}

output "github_plan_role_arn" {
  description = "Repo variable AWS_PLAN_ROLE_ARN"
  value       = aws_iam_role.gh_plan.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "ses_dkim_tokens" {
  value = aws_ses_domain_dkim.main.dkim_tokens
}
