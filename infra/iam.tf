data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "nanana-app-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_instance_profile" "app" {
  name = "nanana-app-instance"
  role = aws_iam_role.app.name
}

resource "aws_iam_role_policy_attachment" "app_ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app" {
  # ECR pull
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for r in aws_ecr_repository.repo : r.arn]
  }

  # Secrets/config under /nanana/prod/*
  statement {
    sid     = "ReadConfigParameters"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}",
      "arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*",
    ]
  }
  statement {
    sid       = "DecryptSecureStringsWithDefaultKey"
    actions   = ["kms:Decrypt"]
    resources = ["arn:${data.aws_partition.current.partition}:kms:${local.region}:${local.account_id}:key/*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }

  # WAL-G: read/write backups. Deliberately NO delete (retention is done by S3
  # lifecycle; the bucket policy also denies deletes).
  statement {
    sid       = "BackupBucketList"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.backup.arn]
  }
  statement {
    sid = "BackupObjectsReadWrite"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.backup.arn}/*"]
  }

  # Deploy artifacts (compose file + scripts uploaded by CI)
  statement {
    sid       = "ReadDeployArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/deploy/*"]
  }
  statement {
    sid       = "ListDeployArtifacts"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["deploy/*"]
    }
  }

  # Caddy DNS-01 (TXT records in our zone only)
  statement {
    sid       = "Route53ChangeTxtInZone"
    actions   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
    resources = [data.aws_route53_zone.main.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["TXT"]
    }
  }
  statement {
    sid       = "Route53Lookup"
    actions   = ["route53:ListHostedZones", "route53:ListHostedZonesByName"]
    resources = ["*"]
  }
  statement {
    sid       = "Route53GetChange"
    actions   = ["route53:GetChange"]
    resources = ["arn:${data.aws_partition.current.partition}:route53:::change/*"]
  }

  # Magic-link mail
  statement {
    sid       = "SesSend"
    actions   = ["ses:SendEmail", "ses:SendRawEmail", "sesv2:SendEmail"]
    resources = ["arn:${data.aws_partition.current.partition}:ses:${local.region}:${local.account_id}:identity/*"]
  }

  # Custom metrics
  statement {
    sid       = "PutMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.metrics_namespace]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "nanana-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}
