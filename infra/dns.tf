# Records in the EXISTING nanana.lat hosted zone (data source in locals.tf; the
# zone itself is never created or modified by this stack).

locals {
  zone_id = data.aws_route53_zone.main.zone_id
}

resource "aws_route53_record" "apex" {
  zone_id = local.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}

resource "aws_route53_record" "wildcard" {
  zone_id = local.zone_id
  name    = "*.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}

resource "aws_route53_record" "wildcard_tools" {
  zone_id = local.zone_id
  name    = "*.tools.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}

resource "aws_route53_record" "api" {
  zone_id = local.zone_id
  name    = "api.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}

resource "aws_route53_record" "www" {
  zone_id = local.zone_id
  name    = "www.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = [var.domain]
}

# ---- SES ------------------------------------------------------------------------

resource "aws_route53_record" "ses_verification" {
  zone_id = local.zone_id
  name    = "_amazonses.${var.domain}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.main.verification_token]
}

resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = local.zone_id
  name    = "${aws_ses_domain_dkim.main.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.main.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "spf" {
  zone_id = local.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = local.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 600
  # p=none while we watch reports; tighten to quarantine/reject later.
  records = ["v=DMARC1; p=none; rua=mailto:abuse@${var.domain}"]
}

resource "aws_route53_record" "mx" {
  zone_id = local.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 600
  records = ["10 inbound-smtp.${local.region}.amazonaws.com"]
}
