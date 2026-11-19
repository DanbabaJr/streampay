# Variables for stacks/aws-ec2: the same three modules as the hobby path, placed
# on a machine that exists in a cloud.
#
# This stack is the only one in the repo that needs credentials to apply, so CI
# only validates it. The render story is identical to minimal-single-vm:
# modules/vm produces the bundle, and here it is carried to the host by
# cloud-init instead of by scp.

variable "region" {
  description = "AWS region the stack lives in."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z0-9]+)+-[0-9]$", var.region))
    error_message = "region must be an AWS region code such as us-east-1."
  }
}

variable "name" {
  description = "Name prefix for every object and the instance tag. Keep it unique per stack in the region: the bundle bucket is derived from it."
  type        = string
  default     = "streampay"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,28}[a-z0-9]$", var.name))
    error_message = "name must be a lowercase label, 3-30 characters, used verbatim in hostnames, bucket names and tags."
  }
}

variable "contract_id" {
  description = "Soroban contract id the indexer observes (C... strkey)."
  type        = string

  validation {
    condition     = can(regex("^C[A-Z2-7]{55}$", var.contract_id))
    error_message = "contract_id must be a Soroban contract id: C followed by 55 base32 characters (56 total)."
  }
}

variable "network" {
  description = "Stellar network: testnet, futurenet or mainnet."
  type        = string
  default     = "testnet"

  validation {
    condition     = contains(["testnet", "futurenet", "mainnet"], var.network)
    error_message = "network must be testnet, futurenet or mainnet."
  }
}

variable "rpc_url" {
  description = "Soroban RPC endpoint. Empty uses the public endpoint for the chosen network."
  type        = string
  default     = ""

  validation {
    condition     = var.rpc_url == "" || can(regex("^https?://[A-Za-z0-9._:/-]+$", var.rpc_url))
    error_message = "rpc_url must be empty or an http(s) URL with no query string."
  }
}

variable "horizon_url" {
  description = "Horizon endpoint. Empty uses the public endpoint for the chosen network."
  type        = string
  default     = ""

  validation {
    condition     = var.horizon_url == "" || can(regex("^https?://[A-Za-z0-9._:/-]+$", var.horizon_url))
    error_message = "horizon_url must be empty or an http(s) URL with no query string."
  }
}

variable "images" {
  description = <<-EOT
    Image references. A machine you did not build the images on cannot see a
    :local tag, so on this path the three StreamPay images normally point at a
    registry you push to. Set build_local=true to have install.sh build them from
    the git checkout it clones on the instance instead.
  EOT
  type = object({
    indexer      = optional(string, "streampay/indexer:local")
    reconciler   = optional(string, "streampay/reconciler:local")
    sentinel     = optional(string, "streampay/ttl-sentinel:local")
    prometheus   = optional(string, "prom/prometheus:v2.50.1")
    alertmanager = optional(string, "prom/alertmanager:v0.27.0")
    grafana      = optional(string, "grafana/grafana:10.4.0")
    caddy        = optional(string, "caddy:2.8-alpine")
  })
  default = {}
}

# -----------------------------------------------------------------------------
# Placement
# -----------------------------------------------------------------------------

variable "vpc_id" {
  description = "Existing VPC to place the instance in. Empty means create a two-subnet VPC with an internet gateway and route table."
  type        = string
  default     = ""

  validation {
    condition     = var.vpc_id == "" || can(regex("^vpc-[0-9a-f]{8,17}$", var.vpc_id))
    error_message = "vpc_id must be empty or an ID like vpc-0123456789abcdef0."
  }
}

variable "subnet_id" {
  description = "Existing subnet for the instance. Only used when vpc_id is set; the data volume is created in that subnet's AZ."
  type        = string
  default     = ""

  validation {
    condition     = var.subnet_id == "" || can(regex("^subnet-[0-9a-f]{8,17}$", var.subnet_id))
    error_message = "subnet_id must be empty or an ID like subnet-0123456789abcdef0."
  }
}

variable "availability_zone" {
  description = "AZ for the created subnets and the data volume when you are not supplying a subnet. Empty picks the region's first AZ, which is a coin flip you should not take in production."
  type        = string
  default     = ""

  validation {
    condition     = var.availability_zone == "" || can(regex("^[a-z]{2}(-[a-z0-9]+)+-[0-9][a-z]$", var.availability_zone))
    error_message = "availability_zone must be empty or a zone code such as us-east-1a."
  }
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. The whole stack runs as seven containers: t3.small (2 CPU,
    2 GB) holds indexer + reconciler + sentinel + Prometheus + Alertmanager +
    Grafana + Caddy at hobby volume, and the first thing that OOMs at real volume
    is Prometheus. Memory is the knob that matters, not vCPU.
  EOT
  type        = string
  default     = "t3.small"

  validation {
    condition     = can(regex("^[a-z0-9]+\\.[a-z0-9]+(\\.[a-z0-9]+)?$", var.instance_type))
    error_message = "instance_type must look like t3.small or c6i.xlarge."
  }
}

variable "ami_id" {
  description = "AMI to boot. Empty looks up the current Ubuntu 24.04 LTS AMD64 image published by Canonical in this region."
  type        = string
  default     = ""

  validation {
    condition     = var.ami_id == "" || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id must be empty or an ID like ami-0123456789abcdef0."
  }
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH. Empty means no key is installed, which is the right answer when you use SSM Session Manager instead: no inbound port 22 at all."
  type        = string
  default     = ""
}

variable "allowed_ssh_cidrs" {
  description = "CIDRs allowed to reach port 22. Empty (the default) opens no SSH rule: reach the box with SSM Session Manager, or set this to your own /32 (`curl -s https://ifconfig.me`/32) if you must have ssh."
  type        = list(string)
  default     = []
}

variable "allowed_https_cidrs" {
  description = "CIDRs allowed to reach the public listener. A dashboard with a live funded-key stack behind it should not be 0.0.0.0/0 unless it is authenticating; pin it to your office or a Cloudflare/WAF range."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "root_volume_size_gb" {
  description = "Root volume size. Holds images, logs and the OS; the ledger lives on the data volume."
  type        = number
  default     = 20
}

variable "data_volume_size_gb" {
  description = "Separate gp3 volume mounted at the stack's data root. 0 puts the data on the root volume: fine for a week of testnet, wrong for anything you would miss. A separate volume is what survives this instance being replaced when user_data changes."
  type        = number
  default     = 30

  validation {
    condition     = var.data_volume_size_gb == 0 || (var.data_volume_size_gb >= 8 && var.data_volume_size_gb <= 16384)
    error_message = "data_volume_size_gb must be 0 (no separate volume) or at least 8 GiB."
  }
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------

variable "secrets_strategy" {
  description = <<-EOT
    How secret values reach the containers on this host:
      ssm   - AWS SSM SecureString, fetched at boot by fetch-secrets.sh through
              the instance profile. Nothing lands in git, state or an image, and
              reads are CloudTrail-auditable. The instance role is scoped to
              exactly the parameters under ssm_path_prefix.
      vault - HashiCorp Vault through Vault Agent (config rendered into the
              bundle); needs a reachable, unsealed Vault and network trust.
      file  - an operator-delivered 0600 union file (Ansible/SCP); plaintext on
              disk, no cloud dependency.
      env   - host environment of the machine that runs install.sh; simplest and
              the weakest, since /proc/1/environ then holds a funded key.
  EOT
  type        = string
  default     = "ssm"

  validation {
    condition     = contains(["ssm", "vault", "file", "env"], var.secrets_strategy)
    error_message = "secrets_strategy on this path must be ssm, vault, file or env (k8s_secret belongs to stacks/kubernetes)."
  }
}

variable "ssm_path_prefix" {
  description = "strategy=ssm: parameters are read from <prefix>/<SECRET_NAME>. The instance role is limited to exactly this hierarchy, so the prefix is also the blast radius."
  type        = string
  default     = ""

  validation {
    condition     = var.ssm_path_prefix == "" || can(regex("^/[a-zA-Z0-9_/._-]+[a-zA-Z0-9_/.-]$", var.ssm_path_prefix))
    error_message = "ssm_path_prefix must be an absolute SSM hierarchy such as /streampay/testnet."
  }
}

variable "ssm_region" {
  description = "strategy=ssm: region passed to the AWS CLI by fetch-secrets.sh. Empty uses the instance's own region (the one this stack runs in)."
  type        = string
  default     = ""
}

variable "vault_mount" {
  description = "strategy=vault: KV v2 path holding the secret map, e.g. kv/streampay/testnet."
  type        = string
  default     = ""
}

variable "operator_secret_file" {
  description = "strategy=file: absolute path on the instance of the operator-owned union file. Delivered out of band; Terraform never sees its contents."
  type        = string
  default     = ""

  validation {
    condition     = var.operator_secret_file == "" || can(regex("^/", var.operator_secret_file))
    error_message = "operator_secret_file must be an absolute path."
  }
}

variable "strict_secret_names" {
  description = "Names the source must provide or fetch-secrets.sh fails. The funded extender key is added automatically once the extender spends."
  type        = list(string)
  default     = []
}

variable "enable_session_manager" {
  description = "Attach AmazonSSMManagedInstanceCore so you can open a shell with `aws ssm start-session` instead of an inbound port 22. Turn it off only if your account forbids that managed policy, in which case allowed_ssh_cidrs and key_name become mandatory."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "strategy=ssm: customer-managed KMS key ARN that encrypts your SecureStrings. Empty means the account-managed aws/ssm key, whose ARN cannot be named in a policy, so the Decrypt grant is bounded by kms:ViaService instead."
  type        = string
  default     = ""

  validation {
    condition     = var.kms_key_arn == "" || can(regex("^arn:aws(-cn)?:kms:[a-z0-9-]+:[0-9]{12}:key/[a-z0-9-]+$", var.kms_key_arn))
    error_message = "kms_key_arn must be empty or a key ARN like arn:aws:kms:us-east-1:123456789012:key/1234abcd-... ."
  }
}

# -----------------------------------------------------------------------------
# Bundle transport
# -----------------------------------------------------------------------------

variable "bundle_bucket" {
  description = "Existing private S3 bucket for the rendered bundle. Empty creates one named <name>-bundle-<account>-<region>. Objects stay private: the instance reads them through its own role."
  type        = string
  default     = ""

  validation {
    condition     = var.bundle_bucket == "" || can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bundle_bucket))
    error_message = "bundle_bucket must be empty or a valid lowercase bucket name."
  }
}

variable "replace_instance_on_config_change" {
  description = "Replace the instance when the rendered bundle changes (user_data_replace_on_change). True means a config edit converges the host by itself; false means Terraform reports the change and you run install.sh on the host. The data volume is not replaced either way."
  type        = bool
  default     = true
}

variable "bundle_prefix" {
  description = "Key prefix inside the bucket for this stack's bundle."
  type        = string
  default     = "bundle"

  validation {
    condition     = can(regex("^[a-zA-Z0-9._/-]{1,64}$", var.bundle_prefix))
    error_message = "bundle_prefix must be a plain S3 prefix with no leading slash."
  }
}

variable "build_local" {
  description = "Build the three StreamPay images on the instance from a git checkout (repo_url/repo_ref). False means install.sh pulls var.images instead, which is what you want once the images are published."
  type        = bool
  default     = false
}

variable "repo_url" {
  description = "build_local: repository to clone on the instance. Only a public https URL belongs here: a clone URL carrying a read token is how that token ends up in terraform state and in the instance's shell history, and this stack will not do that for you. Publish the images to a registry instead (build_local=false)."
  type        = string
  default     = ""

  validation {
    condition     = var.repo_url == "" || can(regex("^(https://|git@|ssh://)[A-Za-z0-9@:./_-]+$", var.repo_url))
    error_message = "repo_url must be empty or an https/ssh clone URL with no query string or embedded secret-looking characters."
  }
}

variable "repo_ref" {
  description = "build_local: branch or tag to check out. Pin a tag or a commit once other people depend on this machine."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]{1,100}$", var.repo_ref))
    error_message = "repo_ref must be a plain git ref name (letters, digits, dot, slash, hyphen, underscore)."
  }
}

# -----------------------------------------------------------------------------
# Listener and tuning (same knobs as the minimal path)
# -----------------------------------------------------------------------------

variable "tls_mode" {
  description = "acme (Let's Encrypt; needs tls_domain), internal (Caddy's own CA), file (you supply a cert delivered by the secret mechanism), off (plain HTTP)."
  type        = string
  default     = "acme"

  validation {
    condition     = contains(["acme", "internal", "file", "off"], var.tls_mode)
    error_message = "tls_mode must be acme, internal, file or off."
  }
}

variable "tls_domain" {
  description = "Public hostname for the listener. Required when tls_mode=acme, and it must already resolve to the EIP this stack creates or ACME will fail and the stack will serve nothing."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_domain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.tls_domain))
    error_message = "tls_domain must be empty or a fully qualified lowercase hostname (no scheme, port or path)."
  }
}

variable "tls_email" {
  description = "Let's Encrypt registration address (tls_mode=acme). Use an alias: ACME stores the address it is given."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_email == "" || can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.tls_email))
    error_message = "tls_email must be empty or a plain email address."
  }
}

variable "tls_cert_file" {
  description = "tls_mode=file: path on the instance holding the certificate chain, delivered by the secret mechanism."
  type        = string
  default     = ""
}

variable "tls_key_file" {
  description = "tls_mode=file: path on the instance holding the private key, mode 0600."
  type        = string
  default     = ""
}

variable "install_dir" {
  description = "Host directory the stack is installed into."
  type        = string
  default     = "/opt/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.install_dir))
    error_message = "install_dir must be an absolute POSIX path with no spaces."
  }
}

variable "config_dir" {
  description = "Host directory holding the rendered config and the 0600 secret files."
  type        = string
  default     = "/etc/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.config_dir))
    error_message = "config_dir must be an absolute POSIX path with no spaces."
  }
}

variable "data_root" {
  description = "Host directory the stack's state lives in. With a data volume this is its mount point, so keep it out of the bundle directory."
  type        = string
  default     = "/var/lib/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.data_root))
    error_message = "data_root must be an absolute POSIX path with no spaces."
  }
}

variable "grafana_host_port" {
  description = "Port the dashboard is published on. It is bound to the admin address (loopback by default), so this is what you ssh -L to, not what the internet sees."
  type        = number
  default     = 3001

  validation {
    condition     = var.grafana_host_port >= 1 && var.grafana_host_port <= 65535
    error_message = "grafana_host_port must be a valid TCP port."
  }
}

variable "prometheus_host_port" {
  description = "Prometheus host port. 0 keeps it off the host: Prometheus has no authentication, so on a machine with a public IP the default is 0 and you look at it through Grafana or an SSH tunnel."
  type        = number
  default     = 0
}

variable "indexer_host_port" {
  description = "Indexer host port (0 keeps it container-only; Caddy still proxies it when expose_indexer_api is on)."
  type        = number
  default     = 0
}

variable "expose_indexer_api" {
  description = "Route the indexer's read endpoints through the public listener so a hosted frontend can call them."
  type        = bool
  default     = false
}

variable "reconciler_enabled" {
  description = "Run the reconciler. Turn it off only when another host already runs it: two reconcilers double-spend the outbox."
  type        = bool
  default     = true
}

variable "sentinel_enabled" {
  description = "Run ttl-sentinel: watches stream TTLs and alerts when an extension is overdue."
  type        = bool
  default     = true
}

variable "extender_enabled" {
  description = "Let the stack fund TTL extensions from a funded key. Real XLM per pass, so it is off until you say otherwise."
  type        = bool
  default     = false
}

variable "extender_dry_run" {
  description = "Compute the extension plan and log it, sign nothing. Start here."
  type        = bool
  default     = true
}

variable "extender_threshold_ledgers" {
  description = "Extend streams whose remaining TTL is below this many ledgers."
  type        = number
  default     = 200000
}

variable "extender_to_ledgers" {
  description = "Ledgers to extend to. Must exceed the threshold and stay under Soroban's max_entry_ttl (6312000)."
  type        = number
  default     = 500000
}

variable "extender_monthly_budget_xlm" {
  description = "Stop funding once this much XLM has been spent in the calendar month."
  type        = string
  default     = "1"
}

variable "extender_schedule" {
  description = "systemd calendar expression for the extender timer."
  type        = string
  default     = "hourly"
}

variable "indexer_start_ledger" {
  description = "Ledger to begin indexing from. null starts at the current latest."
  type        = number
  default     = null
}

variable "indexer_poll_interval_ms" {
  description = "Ledger poll interval; the indexer refuses anything below 250 ms."
  type        = number
  default     = 5000
}

variable "rpc_fallback_urls" {
  description = "Extra Soroban RPC endpoints the indexer rotates through under rate limiting."
  type        = list(string)
  default     = []
}

variable "prometheus_retention" {
  description = "TSDB retention. The data volume size is the real limit."
  type        = string
  default     = "15d"
}

variable "alert_repeat_interval" {
  description = "How often Alertmanager re-sends an unresolved warning."
  type        = string
  default     = "4h"
}

variable "alert_receivers" {
  description = "Alert routing. Each entry names the env var carrying its webhook URL: a webhook URL is a credential, so it is substituted at container start and never written to git or state."
  type = list(object({
    name           = string
    match_severity = optional(string)
    secret_env     = optional(string)
    static_url     = optional(string)
  }))
  default = [
    { name = "default-webhook", secret_env = "STREAMPAY_ALERT_SINK_URL" },
    { name = "p0-pager-webhook", match_severity = "critical", secret_env = "STREAMPAY_P0_ALERT_SINK_URL" },
  ]

  validation {
    condition = alltrue([
      for r in var.alert_receivers :
      (r.secret_env != null && r.secret_env != "") || (r.static_url != null && r.static_url != "")
    ])
    error_message = "Every alert_receivers entry needs secret_env or static_url; a receiver with no sink silently drops alerts."
  }
}

variable "metrics_targets" {
  description = "Extra Prometheus scrape targets as job => host:port (node_exporter, a second indexer)."
  type        = map(string)
  default     = {}
}

variable "read_only_rootfs" {
  description = "Read-only root filesystem plus a tmpfs at /tmp for the containers that tolerate it."
  type        = bool
  default     = true
}

variable "log_max_size" {
  description = "Per-container JSON log rotation size."
  type        = string
  default     = "10m"
}

variable "additional_notes" {
  description = "Appended verbatim to the rendered bundle README."
  type        = string
  default     = ""
}
