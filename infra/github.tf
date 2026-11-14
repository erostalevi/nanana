# --------------------------------------------------------------------------------
# GitHub Actions OIDC: no long-lived AWS keys in GitHub.
#   nanana-gh-deploy : push to main only. ECR push + SSM deploy. NO infra rights
#                      (OpenTofu apply is run by the owner locally, not by CI).
#   nanana-gh-plan   : pull_request only. Read-only, for `tofu plan`.
# --------------------------------------------------------------------------------

locals {
  github_oidc_url = "token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://${local.github_oidc_url}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://${local.github_oidc_url}"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "gh_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values   = ["${var.github_sub_prefix}:ref:refs/heads/main"]
    }
  }
}

data "aws_iam_policy_document" "gh_plan_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values   = ["${var.github_sub_prefix}:pull_request"]
    }
  }
}

# ---- deploy role ---------------------------------------------------------------------------

resource "aws_iam_role" "gh_deploy" {
  name                 = "nanana-gh-deploy"
  assume_role_policy   = data.aws_iam_policy_document.gh_deploy_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "gh_deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for r in aws_ecr_repository.repo : r.arn]
  }

  statement {
    sid       = "FindInstance"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
  statement {
    sid       = "SsmRunShellDocument"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${local.region}::document/AWS-RunShellScript"]
  }
  statement {
    sid       = "SsmSendToTaggedInstance"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/project"
      values   = ["nanana"]
    }
  }
  statement {
    sid = "SsmCommandStatus"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:ListCommands",
      "ssm:DescribeInstanceInformation",
    ]
    resources = ["*"]
  }

  # Non-secret config only: the role has no kms:Decrypt, so SecureStrings stay unreadable.
  statement {
    sid     = "ReadConfigParameters"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*",
    ]
  }

  statement {
    sid       = "UploadDeployArtifacts"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/deploy/*"]
  }
}

resource "aws_iam_role_policy" "gh_deploy" {
  name   = "deploy"
  role   = aws_iam_role.gh_deploy.id
  policy = data.aws_iam_policy_document.gh_deploy.json
}

# ---- plan role (read-only) -----------------------------------------------------------------

resource "aws_iam_role" "gh_plan" {
  name                 = "nanana-gh-plan"
  assume_role_policy   = data.aws_iam_policy_document.gh_plan_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "gh_plan" {
  statement {
    sid = "ReadInfra"
    actions = [
      "ec2:Describe*",
      "ec2:GetEbsEncryptionByDefault",
      "iam:Get*",
      "iam:List*",
      "route53:Get*",
      "route53:List*",
      "ses:Get*",
      "ses:List*",
      "ses:Describe*",
      "sns:Get*",
      "sns:List*",
      "cloudwatch:Describe*",
      "cloudwatch:Get*",
      "cloudwatch:List*",
      "budgets:ViewBudget",
      "budgets:Describe*",
      "dlm:Get*",
      "lambda:Get*",
      "lambda:List*",
      "logs:Describe*",
      "logs:List*",
      "ecr:DescribeRepositories",
      "ecr:ListTagsForResource",
      "ecr:GetLifecyclePolicy",
      "ecr:GetRepositoryPolicy",
      "ssm:DescribeParameters",
      "ssm:ListTagsForResource",
    ]
    resources = ["*"]
  }

  # AMI lookup (public parameter), and nothing under /nanana.
  statement {
    sid       = "ReadPublicAmiParameter"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${local.region}::parameter/aws/service/ami-amazon-linux-latest/*"]
  }

  # Bucket CONFIGURATION only (no object reads outside the state file).
  statement {
    sid = "ReadBucketConfig"
    actions = [
      "s3:GetBucket*",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:GetEncryptionConfiguration",
      "s3:GetAccelerateConfiguration",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.backup.arn,
      aws_s3_bucket.replica.arn,
      aws_s3_bucket.inbound.arn,
      aws_s3_bucket.artifacts.arn,
      "arn:${data.aws_partition.current.partition}:s3:::${local.state_bucket_name}",
    ]
  }

  # State file. (CI plans with -lock=false so it never needs write access.)
  statement {
    sid       = "ReadState"
    actions   = ["s3:GetObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${local.state_bucket_name}/nanana/*"]
  }
}

resource "aws_iam_role_policy" "gh_plan" {
  name   = "plan-readonly"
  role   = aws_iam_role.gh_plan.id
  policy = data.aws_iam_policy_document.gh_plan.json
}
