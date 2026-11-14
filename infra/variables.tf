variable "alert_email" {
  description = "Address that receives CloudWatch/Budget alerts (SNS email subscription). Never commit it."
  type        = string
}

variable "forward_email" {
  description = "Address that receives mail sent to abuse@ and support@ (also verified as an SES identity while in sandbox). Never commit it."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository (owner/name) allowed to assume the CI roles."
  type        = string
  default     = "erostalevi/nanana"
}

variable "aws_profile" {
  description = "AWS CLI profile to use. null = default credential chain."
  type        = string
  default     = null
}

variable "domain" {
  description = "Base domain. The Route 53 hosted zone with this name must already exist."
  type        = string
  default     = "nanana.lat"
}

variable "instance_type" {
  description = "EC2 instance type (t3.micro by default; resize to t3.small if memory is tight)."
  type        = string
  default     = "t3.micro"
}

variable "root_volume_gb" {
  type    = number
  default = 20
}

variable "data_volume_gb" {
  type    = number
  default = 10
}

variable "monthly_budget_usd" {
  type    = number
  default = 25
}

variable "create_github_oidc_provider" {
  description = "Create the account-wide GitHub OIDC provider. Set false if one already exists (it is then looked up instead)."
  type        = bool
  default     = true
}

variable "breakglass_require_mfa" {
  description = "Require MFA to assume the backup break-glass role. Leave false while operating with root access keys (they cannot carry an MFA context)."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Days before S3 expires backup objects. Must exceed 30 (PITR window) + 7 (weekly base backup interval) so every point in the last 30 days stays restorable."
  type        = number
  default     = 40

  validation {
    condition     = var.backup_retention_days >= 38
    error_message = "backup_retention_days must be at least 38 to guarantee 30 days of point-in-time recovery."
  }
}
