data "aws_vpc" "default" {
  default = true
}

# t3.micro is not offered in every AZ of us-east-1; only use AZs that have it.
data "aws_ec2_instance_type_offerings" "az" {
  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
  location_type = "availability-zone"
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.az.locations
  }
}

locals {
  # Deterministic choice: the lexicographically first eligible subnet.
  subnet_id = sort(data.aws_subnets.default.ids)[0]
}

data "aws_subnet" "chosen" {
  id = local.subnet_id
}

resource "aws_security_group" "app" {
  name        = "nanana-app"
  description = "nanana app host: HTTP/HTTPS only, no SSH (use SSM Session Manager)"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = "nanana-app"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "http_v4" {
  security_group_id = aws_security_group.app.id
  description       = "HTTP (ACME redirect)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "http_v6" {
  security_group_id = aws_security_group.app.id
  description       = "HTTP (ACME redirect)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_ingress_rule" "https_v4" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "https_v6" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_egress_rule" "all_v4" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound (ECR, S3, SES, SSM, GitHub, LetsEncrypt, webhook replays)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all_v6" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound (IPv6)"
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}
