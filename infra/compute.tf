data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  # Everything that gets written onto the host at first boot.
  host_files = {
    "/usr/local/sbin/nanana-metrics"             = { mode = "0755", content = file("${path.module}/files/nanana-metrics.sh") }
    "/etc/systemd/system/nanana.service"         = { mode = "0644", content = file("${path.module}/files/nanana.service") }
    "/etc/systemd/system/nanana-metrics.service" = { mode = "0644", content = file("${path.module}/files/nanana-metrics.service") }
    "/etc/systemd/system/nanana-metrics.timer"   = { mode = "0644", content = file("${path.module}/files/nanana-metrics.timer") }
    "/etc/systemd/system/nanana-backup.service"  = { mode = "0644", content = file("${path.module}/files/nanana-backup.service") }
    "/etc/systemd/system/nanana-backup.timer"    = { mode = "0644", content = file("${path.module}/files/nanana-backup.timer") }
  }

  user_data = templatefile("${path.module}/userdata.sh.tftpl", {
    region                = local.region
    data_volume_id_nodash = replace(aws_ebs_volume.data.id, "-", "")
    files                 = local.host_files
    compose_version       = "v5.7.1"
    compose_sha256        = "af426722a8af5de812fcee30cc1c39f0639f5f723cbadefb25e5d4db054064cf"
    buildx_version        = "v0.39.0"
    buildx_sha256         = "5fb31a097304fbf6dd4038649a0decf32c2b9510e4047acd7d68b9d700c46194"
  })
}

# Postgres data lives on its own volume so replacing the instance never touches it.
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.chosen.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name     = "nanana-pgdata"
    role     = "pgdata"
    Snapshot = "nanana-pgdata"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true
  disable_api_termination     = true
  monitoring                  = false
  user_data                   = local.user_data

  # No key pair on purpose: access is through SSM Session Manager only.

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # containers need the instance role (WAL-G, SES, Route 53)
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
    tags = {
      Name = "nanana-root"
    }
  }

  tags = {
    Name = "nanana-app"
    role = "app"
  }

  lifecycle {
    # A newer AMI or edited user-data must never silently replace the box
    # (termination protection would block it anyway). Replace deliberately with
    # `tofu apply -replace=aws_instance.app` after disabling protection.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id

  # Never force-detach the database volume from Terraform.
  skip_destroy = true
}

resource "aws_eip" "app" {
  domain = "vpc"

  tags = {
    Name = "nanana-app"
  }
}

resource "aws_eip_association" "app" {
  allocation_id = aws_eip.app.id
  instance_id   = aws_instance.app.id
}
