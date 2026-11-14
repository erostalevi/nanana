# --------------------------------------------------------------------------------
# Postgres backups: WAL-G (WAL archive + weekly base backups) -> S3, replicated
# cross-region, plus daily EBS snapshots via DLM. Data safety has priority.
# --------------------------------------------------------------------------------

# ---- break-glass role: the ONLY principal allowed to delete backup objects ----

data "aws_iam_policy_document" "breakglass_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${local.account_id}:root"]
    }
    dynamic "condition" {
      for_each = var.breakglass_require_mfa ? [1] : []
      content {
        test     = "Bool"
        variable = "aws:MultiFactorAuthPresent"
        values   = ["true"]
      }
    }
  }
}

resource "aws_iam_role" "breakglass" {
  name                 = "nanana-backup-breakglass"
  description          = "Break-glass: can delete/manage objects in the nanana backup buckets. Assume only deliberately."
  assume_role_policy   = data.aws_iam_policy_document.breakglass_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "breakglass" {
  statement {
    actions = [
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      aws_s3_bucket.backup.arn,
      "${aws_s3_bucket.backup.arn}/*",
      aws_s3_bucket.replica.arn,
      "${aws_s3_bucket.replica.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "breakglass" {
  name   = "backup-delete"
  role   = aws_iam_role.breakglass.id
  policy = data.aws_iam_policy_document.breakglass.json
}

# ---- primary backup bucket (us-east-1) ----------------------------------------

resource "aws_s3_bucket" "backup" {
  bucket = local.backup_bucket_name

  tags = {
    Name = local.backup_bucket_name
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Retention is by lifecycle (S3 itself, not subject to the delete-deny policy).
# 40 days = 30 days PITR + 7 days between weekly base backups + margin, so a base
# backup older than any point in the PITR window always still exists.
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "expire-backups"
    status = "Enabled"
    filter {}

    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.backup]
}

data "aws_iam_policy_document" "backup_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Nobody (including the instance role and the account root user's normal
  # credentials) can delete objects or versions, except the break-glass role.
  statement {
    sid    = "DenyDeleteExceptBreakGlass"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = ["${aws_s3_bucket.backup.arn}/*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.breakglass.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = data.aws_iam_policy_document.backup_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.backup]
}

# ---- replica bucket (us-west-2) -----------------------------------------------

resource "aws_s3_bucket" "replica" {
  provider = aws.replica
  bucket   = local.replica_bucket_name

  tags = {
    Name = local.replica_bucket_name
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.replica.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "replica" {
  provider                = aws.replica
  bucket                  = aws_s3_bucket.replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.replica.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.replica.id

  rule {
    id     = "expire-backups"
    status = "Enabled"
    filter {}

    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.replica]
}

data "aws_iam_policy_document" "replica_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.replica.arn, "${aws_s3_bucket.replica.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyDeleteExceptBreakGlass"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = ["${aws_s3_bucket.replica.arn}/*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.breakglass.arn, aws_iam_role.replication.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.replica.id
  policy   = data.aws_iam_policy_document.replica_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.replica]
}

# ---- cross-region replication --------------------------------------------------

data "aws_iam_policy_document" "replication_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  name               = "nanana-backup-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_assume.json
}

data "aws_iam_policy_document" "replication" {
  statement {
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.backup.arn]
  }
  statement {
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.backup.arn}/*"]
  }
  statement {
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateTags",
    ]
    resources = ["${aws_s3_bucket.replica.arn}/*"]
  }
}

resource "aws_iam_role_policy" "replication" {
  name   = "replicate-backups"
  role   = aws_iam_role.replication.id
  policy = data.aws_iam_policy_document.replication.json
}

resource "aws_s3_bucket_replication_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  role   = aws_iam_role.replication.arn

  rule {
    id     = "replicate-all"
    status = "Enabled"
    filter {}

    # Deletes (and expiry markers) are NOT replicated: the replica keeps data
    # even if something is wrongly deleted in the primary.
    delete_marker_replication {
      status = "Disabled"
    }

    destination {
      bucket        = aws_s3_bucket.replica.arn
      storage_class = "STANDARD"
    }
  }

  depends_on = [
    aws_s3_bucket_versioning.backup,
    aws_s3_bucket_versioning.replica,
  ]
}

# ---- daily EBS snapshots of the data volume (DLM) --------------------------------

data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "nanana-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "pgdata" {
  description        = "nanana pgdata 7 daily and 4 weekly snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Snapshot = "nanana-pgdata"
    }

    schedule {
      name = "daily"
      create_rule {
        cron_expression = "cron(30 5 * * ? *)"
      }
      retain_rule {
        count = 7
      }
      tags_to_add = {
        SnapshotKind = "daily"
        project      = "nanana"
      }
      copy_tags = true
    }

    schedule {
      name = "weekly"
      create_rule {
        cron_expression = "cron(30 6 ? * SUN *)"
      }
      retain_rule {
        count = 4
      }
      tags_to_add = {
        SnapshotKind = "weekly"
        project      = "nanana"
      }
      copy_tags = true
    }
  }
}

# ---- artifacts bucket (compose file + scripts shipped by CI) ---------------------

resource "aws_s3_bucket" "artifacts" {
  bucket = local.artifacts_bucket_name
  tags = {
    Name = local.artifacts_bucket_name
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-deploy-artifacts"
    status = "Enabled"
    filter {
      prefix = "deploy/"
    }
    expiration {
      days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "artifacts_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifacts_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}
