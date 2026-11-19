# Bundle transport: Terraform renders the bundle into build/ (exactly as the
# hobby path does), uploads it to a private prefix, and the instance pulls it with
# its own role. No SCP, no ssh key, no credential in state.

locals {
  create_bucket = var.bundle_bucket == ""
  bucket        = local.create_bucket ? aws_s3_bucket.bundle[0].id : var.bundle_bucket
}

resource "aws_s3_bucket" "bundle" {
  count = local.create_bucket ? 1 : 0

  # Derived from account + region, so two stacks with different `name` never
  # collide on a global bucket name, and `terraform destroy` removes a bucket that
  # only ever held rendered configuration.
  bucket = local.bundle_bucket

  tags = {
    Name = "${var.name}-bundle"
    # Rendered config, not user data: the bundle contains env var *names*, a
    # contract id and monitoring rules. It is private because the contract id and
    # the alert routing are yours, not because it holds keys.
    streampay_io_content = "rendered-config-no-secrets"
  }
}

resource "aws_s3_bucket_public_access_block" "bundle" {
  count = local.create_bucket ? 1 : 0

  bucket = aws_s3_bucket.bundle[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bundle" {
  count = local.create_bucket ? 1 : 0

  bucket = aws_s3_bucket.bundle[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "bundle" {
  count = local.create_bucket ? 1 : 0

  bucket = aws_s3_bucket.bundle[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          "arn:aws:s3:::${local.bundle_bucket}",
          "arn:aws:s3:::${local.bundle_bucket}/*",
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        # Defense against a misconfigured ACL handing the bundle to the world:
        # only this account's principals may read it at all.
        Sid       = "DenyCrossAccountRead"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::${local.bundle_bucket}",
          "arn:aws:s3:::${local.bundle_bucket}/*",
        ]
        Condition = {
          StringNotEquals = { "aws:PrincipalAccount" = data.aws_caller_identity.current.account_id }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.bundle]
}

resource "aws_s3_object" "bundle" {
  for_each = local.bundle_objects

  bucket                 = local.bucket
  key                    = each.value.key
  source                 = each.value.source
  server_side_encryption = "AES256"

  # The files come from module.vm's local_file resources; without this the upload
  # would race the render and read a file that does not exist yet.
  depends_on = [module.vm, aws_s3_bucket_policy.bundle]

  tags = { Name = "${var.name}-bundle" }
}
