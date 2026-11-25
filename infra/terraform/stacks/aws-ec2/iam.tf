# The instance profile is the only credential the host gets, and it is scoped to
# two things: reading this stack's bundle objects, and (for strategy=ssm) reading
# exactly the parameters the bundle names. No managed AdministratorAccess, no
# wildcard SSM ARN, no write access to the bucket.

resource "aws_iam_role" "instance" {
  name = "${var.name}-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  description = "Reads the ${var.name} bundle from S3 and, for strategy=ssm, its own SecureString parameters"

  tags = { Name = "${var.name}-instance" }
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

# Session Manager is the reason allowed_ssh_cidrs can stay empty: a shell with no
# inbound port, authorized by your IAM identity instead of a key on the box. This
# managed policy grants the channel (ssmmessages/ec2messages) and nothing else --
# in particular it is not the policy that reads the SecureStrings, which is the
# scoped statement below.
resource "aws_iam_role_policy_attachment" "session_manager" {
  count = var.enable_session_manager ? 1 : 0

  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "bundle_read" {
  name = "${var.name}-bundle-read"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadOwnBundle"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        # The prefix is part of the resource ARN rather than a condition: this
        # role can read this stack's bundle and nothing else in the bucket.
        Resource = ["arn:aws:s3:::${local.bundle_bucket}/${var.bundle_prefix}/*"]
      },
      {
        Sid      = "ListOwnBundlePrefix"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${local.bundle_bucket}"]
        Condition = {
          StringLike = {
            "s3:prefix" = "${var.bundle_prefix}/*"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "ssm_read" {
  count = var.secrets_strategy == "ssm" ? 1 : 0

  name = "${var.name}-ssm-read"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadStackParameters"
        Effect = "Allow"
        # GetParameter only: no DescribeParameters and no GetParametersByPath, so
        # the role cannot enumerate the hierarchy it is allowed to read by name.
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        # One ARN per name modules/secrets was told about. Adding a secret to a
        # service means re-applying this stack, which is the point: the grant and
        # the need change together.
        Resource = local.ssm_parameter_arns
      },
      {
        Sid      = "DecryptWithSsmServiceKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.kms_key_arn != "" ? [var.kms_key_arn] : ["*"]
        # SecureStrings are encrypted with the account-managed aws/ssm key, whose
        # ARN cannot be written down in advance, so the grant is bounded by the
        # service and the account instead. Pin kms_key_arn once you use a
        # customer-managed key and this becomes a single-ARN statement.
        Condition = {
          StringEquals = {
            "kms:ViaService"    = "ssm.${var.region}.amazonaws.com"
            "kms:CallerAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}
