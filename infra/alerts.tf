# --------------------------------------------------------------------------------
# Alert delivery through SES: SNS -> Lambda -> email.
# Unlike an SNS email subscription this needs no confirmation click.
# --------------------------------------------------------------------------------

data "archive_file" "alert_mailer" {
  type        = "zip"
  source_file = "${path.module}/lambda/alert_mailer.py"
  output_path = "${path.module}/.build/alert_mailer.zip"
}

resource "aws_iam_role" "alert_mailer" {
  name               = "nanana-alert-mailer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_cloudwatch_log_group" "alert_mailer" {
  name              = "/aws/lambda/nanana-alert-mailer"
  retention_in_days = 30
}

data "aws_iam_policy_document" "alert_mailer" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.alert_mailer.arn}:*"]
  }
  statement {
    actions   = ["ses:SendEmail"]
    resources = ["arn:${data.aws_partition.current.partition}:ses:${local.region}:${local.account_id}:identity/*"]
  }
}

resource "aws_iam_role_policy" "alert_mailer" {
  name   = "alert-mailer"
  role   = aws_iam_role.alert_mailer.id
  policy = data.aws_iam_policy_document.alert_mailer.json
}

resource "aws_lambda_function" "alert_mailer" {
  function_name    = "nanana-alert-mailer"
  role             = aws_iam_role.alert_mailer.arn
  runtime          = "python3.12"
  handler          = "alert_mailer.handler"
  filename         = data.archive_file.alert_mailer.output_path
  source_code_hash = data.archive_file.alert_mailer.output_base64sha256
  timeout          = 15
  memory_size      = 128

  environment {
    variables = {
      ALERT_TO     = var.alert_email
      FROM_ADDRESS = local.mail_from
      SES_REGION   = local.region
    }
  }

  depends_on = [aws_cloudwatch_log_group.alert_mailer, aws_iam_role_policy.alert_mailer]
}

resource "aws_lambda_permission" "alerts_sns" {
  statement_id  = "AllowSnsInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.alert_mailer.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "alert_mailer" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.alert_mailer.arn

  depends_on = [aws_lambda_permission.alerts_sns]
}
