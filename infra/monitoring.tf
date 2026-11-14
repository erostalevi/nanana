# --------------------------------------------------------------------------------
# Alerts: SNS topic (email) + CloudWatch alarms + monthly budget.
# The email subscription must be CONFIRMED by clicking the link AWS sends.
# --------------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "nanana-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
  statement {
    sid       = "AllowBudgets"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "nanana-ec2-status-check-failed"
  alarm_description   = "EC2 instance or system status check failing for 10 minutes."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "disk" {
  for_each = toset(["root", "data"])

  alarm_name          = "nanana-disk-used-${each.key}"
  alarm_description   = "Disk usage on the ${each.key} volume is above 80%."
  namespace           = local.metrics_namespace
  metric_name         = "DiskUsedPercent"
  dimensions          = { Volume = each.key }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Missing data is treated as breaching: if the metrics timer or the host dies we
# want to hear about it. Expect these two to alarm until the first deploy.
resource "aws_cloudwatch_metric_alarm" "wal_lag" {
  alarm_name          = "nanana-wal-archive-lag"
  alarm_description   = "No successful WAL archive to S3 for more than 15 minutes (or Postgres down). Point-in-time recovery is degraded."
  namespace           = local.metrics_namespace
  metric_name         = "WalArchiveLagSeconds"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "postgres_down" {
  alarm_name          = "nanana-postgres-down"
  alarm_description   = "The Postgres container is not accepting connections."
  namespace           = local.metrics_namespace
  metric_name         = "PostgresUp"
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_budgets_budget" "monthly" {
  name         = "nanana-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts]
}
