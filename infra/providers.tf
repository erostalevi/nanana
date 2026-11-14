provider "aws" {
  region  = "us-east-1"
  profile = var.aws_profile

  default_tags {
    tags = {
      project = "nanana"
    }
  }
}

# Cross-region backup replica (disaster recovery).
provider "aws" {
  alias   = "replica"
  region  = "us-west-2"
  profile = var.aws_profile

  default_tags {
    tags = {
      project = "nanana"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
