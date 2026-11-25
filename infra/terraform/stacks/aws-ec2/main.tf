# AWS EC2 stack: the minimal single-VM story on a machine that lives in a cloud.
#
# Same modules, different transport: modules/vm renders the bundle to this
# directory's build/, Terraform uploads it to a private S3 prefix, and cloud-init
# on the instance syncs it down and runs the very same install.sh the hobby path
# runs. There is no second implementation of "deploy" here, which is the whole
# point of the module split.
#
# This is the only stack in the repo that needs credentials to apply, so CI runs
# `terraform validate` on it and the human applies it.

locals {
  bundle_dir      = "${path.root}/build"
  host_bundle_dir = "/opt/streampay-bundle"
  # The checkout Terraform is running from, used only to hash the Dockerfiles
  # into the bundle. The instance has its own view of the repo (repo_root).
  checkout_root   = abspath("${path.root}/../../../..")
  create_network  = var.vpc_id == ""
  use_data_volume = var.data_volume_size_gb > 0
  strict_secret_names = concat(
    var.strict_secret_names,
    var.extender_enabled && !var.extender_dry_run ? ["TTL_SENTINEL_EXTENDER_SECRET"] : []
  )

  # The instance role is scoped to exactly the parameters the bundle reads, so
  # the list of *names* (which is configuration, not a secret) is what the policy
  # is built from.
  ssm_parameter_arns = var.secrets_strategy == "ssm" ? [
    for name in module.secrets.secret_names :
    "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_path_prefix}/${name}"
  ] : []

  # Defaults to a per-network hierarchy so two stacks on one account cannot read
  # each other's parameters through the same role.
  ssm_path_prefix = var.ssm_path_prefix != "" ? var.ssm_path_prefix : "/${var.name}/${var.network}"

  bundle_bucket = var.bundle_bucket != "" ? var.bundle_bucket : "${var.name}-bundle-${data.aws_caller_identity.current.account_id}-${var.region}"

  # modules/vm names the umbrella unit <project_name>-stack; cloud-init restarts it
  # by the same name, and the precondition below fails the plan if the two ever
  # disagree.
  stack_unit = "streampay-stack"

  az = var.availability_zone != "" ? var.availability_zone : (
    var.subnet_id != "" ? try(data.aws_subnet.existing[0].availability_zone, "") : try(data.aws_availability_zones.available[0].names[0], "")
  )

  public_cidr_blocks = length(var.allowed_https_cidrs) > 0 ? var.allowed_https_cidrs : ["0.0.0.0/0"]

  # Every rendered file, addressed the way the instance will fetch it.
  bundle_objects = {
    for path, mode in module.vm.bundle_files : path => {
      key    = "${var.bundle_prefix}/${path}"
      source = "${local.bundle_dir}/${path}"
      mode   = mode
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  count = var.availability_zone == "" && var.subnet_id == "" ? 1 : 0

  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_subnet" "existing" {
  count = var.subnet_id != "" ? 1 : 0

  id = var.subnet_id
}

# Ubuntu 24.04 LTS from Canonical: the ships-with-docker-compose-v2 story is the
# reason it is the default image here rather than Amazon Linux.
data "aws_ami" "ubuntu" {
  count = var.ami_id == "" ? 1 : 0

  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "terraform_data" "preflight" {
  input = {
    strategy  = var.secrets_strategy
    tls_mode  = var.tls_mode
    transport = local.bundle_bucket
  }

  lifecycle {
    precondition {
      condition     = var.tls_mode != "acme" || var.tls_domain != ""
      error_message = "tls_mode=acme needs tls_domain: Let's Encrypt will not issue for an IP address, and Caddy needs the name to request the certificate for."
    }

    precondition {
      condition     = var.tls_mode != "acme" || contains(local.public_cidr_blocks, "0.0.0.0/0") || contains(local.public_cidr_blocks, "::/0")
      error_message = "tls_mode=acme needs port 80 reachable from the internet: the ACME http-01 challenge comes from Let's Encrypt's servers, not from your CIDRs. Restrict allowed_https_cidrs only when tls_mode is file/off, or use a DNS-01 provider."
    }

    precondition {
      condition     = var.tls_mode != "file" || (var.tls_cert_file != "" && var.tls_key_file != "")
      error_message = "tls_mode=file needs tls_cert_file and tls_key_file: paths on the instance, delivered by the secret mechanism, never copied into the bundle."
    }

    precondition {
      condition     = var.secrets_strategy != "ssm" || can(regex("^/[A-Za-z0-9_/._-]+$", local.ssm_path_prefix))
      error_message = "strategy=ssm needs an absolute ssm_path_prefix (it defaults to /<name>/<network> when empty)."
    }

    precondition {
      condition     = var.secrets_strategy != "vault" || var.vault_mount != ""
      error_message = "strategy=vault needs vault_mount, e.g. kv/streampay/testnet."
    }

    precondition {
      condition     = var.build_local == false || var.repo_url != ""
      error_message = "build_local=true needs repo_url: install.sh builds the images from a checkout, and there is no checkout on a fresh instance without one."
    }

    precondition {
      condition     = var.build_local == false || can(regex("^https://", var.repo_url))
      error_message = "build_local clones without credentials, so repo_url must be a public https URL. Publish images to a registry for anything private."
    }

    precondition {
      condition     = var.key_name != "" || length(var.allowed_ssh_cidrs) == 0
      error_message = "Opening port 22 with no key_name installed gives you an unreachable SSH listener: set key_name, or leave allowed_ssh_cidrs empty and use SSM Session Manager."
    }

    precondition {
      condition     = var.enable_session_manager || var.key_name != ""
      error_message = "With Session Manager off and no key_name installed, and allowed_ssh_cidrs empty by default, nobody can reach this instance after it boots. Enable one of the two."
    }

    precondition {
      condition     = local.az != ""
      error_message = "Could not determine an availability zone: set availability_zone, or subnet_id, or check that the region has zones available for the caller."
    }

    precondition {
      condition = length(distinct([
        for p in [var.grafana_host_port, var.prometheus_host_port, var.indexer_host_port] : p if p != 0
        ])) == length([
        for p in [var.grafana_host_port, var.prometheus_host_port, var.indexer_host_port] : p if p != 0
      ])
      error_message = "grafana_host_port, prometheus_host_port and indexer_host_port must differ: two services cannot bind the same host port."
    }

    precondition {
      condition     = var.data_volume_size_gb > 0 || var.root_volume_size_gb >= 20
      error_message = "Without a data volume the ledger lives on the root volume: give root_volume_size_gb room for images, logs and the SQLite file."
    }

    precondition {
      condition     = contains(module.vm.systemd_units, "${local.stack_unit}.service")
      error_message = "cloud-init restarts ${local.stack_unit}.service, which modules/vm did not render: the project name and the unit name have drifted apart."
    }
  }
}
