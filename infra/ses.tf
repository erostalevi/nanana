# --------------------------------------------------------------------------------
# SES (us-east-1): outbound identity + inbound mail for abuse@ / support@
# SES production access (leaving the sandbox) is requested separately.
# --------------------------------------------------------------------------------

resource "aws_ses_domain_identity" "main" {
  domain = var.domain
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

resource "aws_ses_domain_identity_verification" "main" {
  domain = aws_ses_domain_identity.main.id

  depends_on = [aws_route53_record.ses_verification]
}

# Needed while in the sandbox: SES only delivers to verified addresses.
# SES emails this address a confirmation link that must be clicked once.
resource "aws_ses_email_identity" "forward" {
  email = var.forward_email
}

# ---- private bucket for raw inbound mail ------------------------------------------

resource "aws_s3_bucket" "inbound" {
  bucket = local.inbound_bucket_name
  tags = {
    Name = local.inbound_bucket_name
  }
}

resource "aws_s3_bucket_public_access_block" "inbound" {
  bucket                  = aws_s3_bucket.inbound.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_ownership_controls" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    id     = "expire-inbound-mail"
    status = "Enabled"
    filter {
      prefix = "inbound/"
    }
    expiration {
      days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "inbound_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.inbound.arn, "${aws_s3_bucket.inbound.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid     = "AllowSesPut"
    actions = ["s3:PutObject"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    resources = ["${aws_s3_bucket.inbound.arn}/inbound/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ses:${local.region}:${local.account_id}:receipt-rule-set/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  policy = data.aws_iam_policy_document.inbound_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.inbound]
}

# ---- forwarder Lambda ------------------------------------------------------------------

data "archive_file" "forwarder" {
  type        = "zip"
  source_file = "${path.module}/lambda/forwarder.py"
  output_path = "${path.module}/.build/forwarder.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "forwarder" {
  name               = "nanana-mail-forwarder"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "forwarder" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.forwarder.arn}:*"]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.inbound.arn}/inbound/*"]
  }
  statement {
    actions   = ["ses:SendRawEmail"]
    resources = ["arn:${data.aws_partition.current.partition}:ses:${local.region}:${local.account_id}:identity/*"]
  }
}

resource "aws_iam_role_policy" "forwarder" {
  name   = "forwarder"
  role   = aws_iam_role.forwarder.id
  policy = data.aws_iam_policy_document.forwarder.json
}

resource "aws_cloudwatch_log_group" "forwarder" {
  name              = "/aws/lambda/nanana-mail-forwarder"
  retention_in_days = 30
}

resource "aws_lambda_function" "forwarder" {
  function_name    = "nanana-mail-forwarder"
  role             = aws_iam_role.forwarder.arn
  runtime          = "python3.12"
  handler          = "forwarder.handler"
  filename         = data.archive_file.forwarder.output_path
  source_code_hash = data.archive_file.forwarder.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      BUCKET       = aws_s3_bucket.inbound.bucket
      KEY_PREFIX   = "inbound/"
      FORWARD_TO   = var.forward_email
      FROM_ADDRESS = local.mail_from
      SES_REGION   = local.region
    }
  }

  depends_on = [aws_cloudwatch_log_group.forwarder, aws_iam_role_policy.forwarder]
}

resource "aws_lambda_permission" "ses_invoke" {
  statement_id   = "AllowSesInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.forwarder.function_name
  principal      = "ses.amazonaws.com"
  source_account = local.account_id
  source_arn     = "arn:${data.aws_partition.current.partition}:ses:${local.region}:${local.account_id}:receipt-rule-set/${aws_ses_receipt_rule_set.main.rule_set_name}:receipt-rule/*"
}

# ---- receipt rules ------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "nanana-inbound"
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}

resource "aws_ses_receipt_rule" "forward" {
  name          = "abuse-support-forward"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = local.inbound_addresses
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.inbound.bucket
    object_key_prefix = "inbound/"
  }

  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.forwarder.arn
    invocation_type = "Event"
  }

  depends_on = [
    aws_s3_bucket_policy.inbound,
    aws_lambda_permission.ses_invoke,
  ]
}
