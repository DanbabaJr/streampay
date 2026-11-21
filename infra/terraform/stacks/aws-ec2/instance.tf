# The machine itself: an instance, an Elastic IP, and (unless
# data_volume_size_gb=0) a separate encrypted gp3 volume for the ledger. The data
# volume is what makes `terraform apply` safe to run twice: a replacement of the
# instance for a config change does not re-index from zero.

resource "aws_ebs_volume" "data" {
  count = local.use_data_volume ? 1 : 0

  availability_zone = local.az
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "${var.name}-data"
    # SQLite in WAL mode on a shared or network-filesystem volume corrupts; this
    # volume attaches to exactly one instance, which is the guarantee the indexer
    # needs.
    streampay_io_role = "indexer-and-tsdb-data"
  }
}

resource "aws_instance" "stack" {
  ami                         = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu[0].id
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.stack.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = false

  key_name = var.key_name != "" ? var.key_name : null

  user_data_replace_on_change = var.replace_instance_on_config_change
  user_data = templatefile("${path.root}/templates/user_data.sh.tftpl", {
    bundle_bucket    = local.bucket
    bundle_prefix    = var.bundle_prefix
    host_bundle_dir  = local.host_bundle_dir
    install_dir      = var.install_dir
    config_dir       = var.config_dir
    data_root        = var.data_root
    region           = var.region
    build_local      = var.build_local
    repo_url         = var.repo_url
    repo_ref         = var.repo_ref
    repo_root        = var.build_local ? "/opt/streampay/src" : var.install_dir
    data_volume_id   = local.use_data_volume ? aws_ebs_volume.data[0].id : ""
    ssm_path_prefix  = local.ssm_path_prefix
    secrets_strategy = var.secrets_strategy
    bundle_sha256    = module.vm.bundle_sha256
    stack_unit       = local.stack_unit
  })

  metadata_options {
    http_endpoint = "enabled"
    # IMDSv2 only: a hop limit of 1 also means a container that was not given the
    # credentials cannot walk up and take the instance role.
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
    tags = {
      Name = "${var.name}-root"
    }
  }

  # An instance is disposable here; the data volume is not. Keeping them separate
  # is the reason a re-apply does not need a snapshot dance first.
  tags = {
    Name = "${var.name}"
    # The bundle this host installs is identified by hash, so a running host and a
    # pending plan can be compared without ssh.
    streampay_io_bundle_sha = module.vm.bundle_sha256
  }
}

resource "aws_volume_attachment" "data" {
  count = local.use_data_volume ? 1 : 0

  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data[0].id
  instance_id                    = aws_instance.stack.id
  stop_instance_before_detaching = true
}

resource "aws_eip" "stack" {
  domain = "vpc"

  tags = { Name = "${var.name}" }
}

resource "aws_eip_association" "stack" {
  allocation_id = aws_eip.stack.id
  instance_id   = aws_instance.stack.id
}
