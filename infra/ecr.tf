locals {
  ecr_repos = toset(["nanana-api", "nanana-caddy", "nanana-postgres"])
}

resource "aws_ecr_repository" "repo" {
  for_each             = local.ecr_repos
  name                 = each.key
  image_tag_mutability = "MUTABLE" # `latest` is re-pushed on every deploy

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
