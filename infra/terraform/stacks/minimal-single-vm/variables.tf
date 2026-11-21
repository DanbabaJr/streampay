# Variables for the minimal single-VM stack: the hobbyist path.
#
# The rule for what belongs here: if a first-time operator has to think about it,
# it is a variable. If it only matters when something breaks, it has a default
# that docs/DEPLOYMENT.md tells them how to override.

variable "contract_id" {
  description = "Soroban contract id the indexer observes (C... strkey). This is the one thing the stack cannot guess."
  type        = string

  validation {
    condition     = can(regex("^C[A-Z2-7]{55}$", var.contract_id))
    error_message = "contract_id must be a Soroban contract id: C followed by 55 base32 characters (56 total)."
  }
}

variable "network" {
  description = "Stellar network: testnet, futurenet or mainnet. Leaves the RPC/Horizon URLs at the public endpoints for that network unless you pin them."
  type        = string
  default     = "testnet"

  validation {
    condition     = contains(["testnet", "futurenet", "mainnet"], var.network)
    error_message = "network must be testnet, futurenet or mainnet."
  }
}

variable "rpc_url" {
  description = "Soroban RPC endpoint. Empty uses the public endpoint for the chosen network; a self-hosted core rpc is the usual answer once you are past hobby volume."
  type        = string
  default     = ""

  validation {
    condition     = var.rpc_url == "" || can(regex("^https?://[A-Za-z0-9._:/-]+$", var.rpc_url))
    error_message = "rpc_url must be empty or an http(s) URL with no path query string."
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

variable "secrets_strategy" {
  description = <<-EOT
    How secret values reach the containers. Terraform only ever knows names, so
    none of these put a plaintext value into git, terraform state or the bundle:
      env   - the fetch script reads the environment it runs in (simplest; the
              values sit in the host environment of the systemd unit)
      file  - one operator-owned KEY=VALUE file, mode 0600, split per service
      ssm   - AWS SSM SecureString at boot through the instance profile
      vault - HashiCorp Vault through Vault Agent (agent config is rendered)
  EOT
  type        = string
  default     = "env"

  validation {
    condition     = contains(["env", "file", "ssm", "vault"], var.secrets_strategy)
    error_message = "secrets_strategy must be env, file, ssm or vault on the VM path (k8s_secret belongs to stacks/kubernetes)."
  }
}

variable "operator_secret_file" {
  description = "secrets_strategy=file: absolute path of the operator-managed union file the split reads. Keep it outside the bundle directory and outside git."
  type        = string
  default     = ""

  validation {
    condition     = var.operator_secret_file == "" || can(regex("^/", var.operator_secret_file))
    error_message = "operator_secret_file must be an absolute path."
  }
}

variable "ssm_path_prefix" {
  description = "secrets_strategy=ssm: SecureStrings are read from <prefix>/<SECRET_NAME>."
  type        = string
  default     = ""

  validation {
    condition     = var.ssm_path_prefix == "" || can(regex("^/[a-zA-Z0-9_/._-]+[a-zA-Z0-9_/.-]$", var.ssm_path_prefix))
    error_message = "ssm_path_prefix must be empty or an absolute SSM hierarchy such as /streampay/testnet."
  }
}

variable "ssm_region" {
  description = "secrets_strategy=ssm: region for the AWS CLI call. Empty uses the instance's own region."
  type        = string
  default     = ""

  validation {
    condition     = var.ssm_region == "" || can(regex("^[a-z]{2}(-[a-z0-9]+)+-[0-9]$", var.ssm_region))
    error_message = "ssm_region must be empty or an AWS region code such as us-east-1."
  }
}

variable "vault_mount" {
  description = "secrets_strategy=vault: KV v2 mount and path holding the secret map, e.g. kv/streampay/testnet."
  type        = string
  default     = ""

  validation {
    condition     = var.vault_mount == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9/_-]*$", var.vault_mount))
    error_message = "vault_mount must be empty or a KV path such as kv/streampay/testnet (no leading slash, no spaces)."
  }
}

variable "strict_secret_names" {
  description = "Names the source must provide or the fetch fails, regardless of optional_secrets. Put the funded extender key here once the extender is enabled."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for n in var.strict_secret_names : can(regex("^[A-Z][A-Z0-9_]*$", n))])
    error_message = "Every strict_secret_names entry must be an uppercase environment-style name such as STREAMPAY_EXTENDER_SECRET."
  }
}

variable "bundle_dir" {
  description = "Where the rendered bundle is written. Defaults to this stack's build/ directory (git-ignored) so a workstation run never touches /opt; set it to install_dir on the VM so the bundle is applied in place."
  type        = string
  default     = null

  validation {
    condition     = var.bundle_dir == null || can(regex("^/[A-Za-z0-9._/-]+$", var.bundle_dir))
    error_message = "bundle_dir must be null or an absolute POSIX path with no spaces."
  }
}

variable "local_repo_root" {
  description = "Checkout of this repo on the machine running Terraform. Used only to hash the Dockerfiles into the apply trigger, so editing an image definition re-runs the bootstrap."
  type        = string
  default     = null

  validation {
    condition     = var.local_repo_root == null || can(regex("^/[A-Za-z0-9._/-]+$", var.local_repo_root))
    error_message = "local_repo_root must be null or an absolute POSIX path with no spaces."
  }
}

variable "install_dir" {
  description = "Host directory the stack is installed into by install.sh."
  type        = string
  default     = "/opt/streampay"

  validation {
    condition     = can(regex("^/[A-Za-z0-9._/-]+$", var.install_dir))
    error_message = "install_dir must be an absolute POSIX path with no spaces."
  }
}

variable "config_dir" {
  description = "Host directory holding the rendered config and the 0600 secret files."
  type        = string
  default     = "/etc/streampay"

  validation {
    condition     = can(regex("^/[A-Za-z0-9._/-]+$", var.config_dir))
    error_message = "config_dir must be an absolute POSIX path with no spaces."
  }
}

variable "repo_root" {
  description = "Path of this repo's checkout on the machine that runs install.sh; the local image builds read their contexts from here."
  type        = string
  default     = "/opt/streampay/src"

  validation {
    condition     = can(regex("^/[A-Za-z0-9._/-]+$", var.repo_root))
    error_message = "repo_root must be an absolute POSIX path with no spaces."
  }
}

variable "apply_locally" {
  description = "Run the bootstrap on the machine Terraform runs on. Set true on the VM itself (that is the one-command path); leave false when the bundle is carried to the host by hand or by cloud-init."
  type        = bool
  default     = false
}

variable "bootstrap_command" {
  description = "Override how install.sh is invoked, e.g. [\"ssh\", \"root@host\", \"sh /opt/streampay/install.sh\"] when Terraform runs on your laptop and the stack runs elsewhere."
  type        = list(string)
  default     = null
}

variable "build_local" {
  description = "Build the three StreamPay images from the repo checkout. The hobbyist path needs no registry; turn this off once you publish images."
  type        = bool
  default     = true
}

variable "skip_image_build" {
  description = "Skip the docker build step in the bootstrap (images already present on the host)."
  type        = bool
  default     = false
}

variable "images" {
  description = "Image references. Leave the three StreamPay images at :local when build_local=true; pin the monitoring images by digest once this matters to someone other than you."
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

variable "tls_mode" {
  description = "acme (Let's Encrypt, needs a DNS name), internal (Caddy's own CA: encrypted, untrusted), file (you already hold a certificate), off (plain HTTP behind a TLS terminator)."
  type        = string
  default     = "internal"

  validation {
    condition     = contains(["acme", "internal", "file", "off"], var.tls_mode)
    error_message = "tls_mode must be acme, internal, file or off."
  }
}

variable "tls_domain" {
  description = "Public hostname for the listener. Required when tls_mode=acme."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_domain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.tls_domain))
    error_message = "tls_domain must be empty or a fully qualified lowercase hostname (no scheme, port or path)."
  }
}

variable "tls_email" {
  description = "Let's Encrypt registration address (tls_mode=acme). An alias is better than a personal address: ACME stores it."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_email == "" || can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$", var.tls_email))
    error_message = "tls_email must be empty or a plain email address."
  }
}

variable "tls_cert_file" {
  description = "tls_mode=file: host path of the certificate chain, delivered by the secret mechanism."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_cert_file == "" || can(regex("^/[A-Za-z0-9._/-]+$", var.tls_cert_file))
    error_message = "tls_cert_file must be empty or an absolute POSIX path with no spaces."
  }
}

variable "tls_key_file" {
  description = "tls_mode=file: host path of the private key, expected mode 0600."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_key_file == "" || can(regex("^/[A-Za-z0-9._/-]+$", var.tls_key_file))
    error_message = "tls_key_file must be empty or an absolute POSIX path with no spaces."
  }
}

variable "grafana_host_port" {
  description = "Loopback port Grafana listens on (127.0.0.1 by default). 0 means reach it only through the TLS listener."
  type        = number
  default     = 3000

  validation {
    condition     = var.grafana_host_port >= 0 && var.grafana_host_port <= 65535
    error_message = "grafana_host_port must be a TCP port between 0 and 65535 (0 keeps it off the host)."
  }
}

variable "prometheus_host_port" {
  description = "Loopback port for Prometheus. It has no authentication, so it stays unpublished by default; use an SSH tunnel or Grafana."
  type        = number
  default     = 0

  validation {
    condition     = var.prometheus_host_port >= 0 && var.prometheus_host_port <= 65535
    error_message = "prometheus_host_port must be a TCP port between 0 and 65535 (0 keeps it off the host)."
  }
}

variable "indexer_host_port" {
  description = "Loopback port for the indexer API. 0 keeps it on the docker network only."
  type        = number
  default     = 0

  validation {
    condition     = var.indexer_host_port >= 0 && var.indexer_host_port <= 65535
    error_message = "indexer_host_port must be a TCP port between 0 and 65535 (0 keeps it container-only)."
  }
}

variable "admin_bind_address" {
  description = "Address the operator-only ports bind on. Keep it on loopback."
  type        = string
  default     = "127.0.0.1"

  validation {
    condition     = can(regex("^[0-9]{1,3}([.][0-9]{1,3}){3}$|^::1$|^localhost$", var.admin_bind_address))
    error_message = "admin_bind_address must be an IPv4 address, localhost or ::1 — the operator ports are not meant to be public."
  }
}

variable "expose_indexer_api" {
  description = "Route the indexer's read endpoints through the TLS listener so a hosted frontend can query this stack."
  type        = bool
  default     = false
}

variable "reconciler_enabled" {
  description = "Run the reconciler (the service that finalizes outbox rows and settles streams on-chain). Turn it off only when another host already runs it: two reconcilers double-spend the outbox."
  type        = bool
  default     = true
}

variable "sentinel_enabled" {
  description = "Run ttl-sentinel: watches stream TTLs and alerts when a ledger extension is overdue."
  type        = bool
  default     = true
}

variable "extender_enabled" {
  description = "Let the stack fund TTL extensions from a funded key. Implies a real cost in XLM per pass, so it is off until you say otherwise."
  type        = bool
  default     = false
}

variable "extender_dry_run" {
  description = "Compute the extension plan and log it, sign nothing. Start here, then flip to false once the plan looks right."
  type        = bool
  default     = true
}

variable "extender_threshold_ledgers" {
  description = "Extend streams whose remaining TTL is below this many ledgers."
  type        = number
  default     = 200000

  validation {
    condition     = var.extender_threshold_ledgers >= 1 && var.extender_threshold_ledgers < 6312000
    error_message = "extender_threshold_ledgers must be at least 1 and below Soroban's max_entry_ttl of 6312000."
  }
}

variable "extender_to_ledgers" {
  description = "Ledgers to extend to when a stream falls below the threshold. Must exceed the threshold and stay under Soroban's max_entry_ttl (6312000)."
  type        = number
  default     = 500000

  validation {
    condition     = var.extender_to_ledgers > var.extender_threshold_ledgers && var.extender_to_ledgers <= 6312000
    error_message = "extender_to_ledgers must exceed extender_threshold_ledgers and stay at or below Soroban's max_entry_ttl (6312000); otherwise extension never lifts the cliff."
  }
}

variable "extender_monthly_budget_xlm" {
  description = "Stop funding once this much XLM has been spent in the calendar month. The sentinel keeps the meter on its state volume."
  type        = string
  default     = "1"

  validation {
    condition     = can(regex("^[0-9]+([.][0-9]+)?$", var.extender_monthly_budget_xlm))
    error_message = "extender_monthly_budget_xlm must be a non-negative decimal XLM amount such as \"1\" or \"12.5\"."
  }
}

variable "extender_schedule" {
  description = "systemd calendar expression for the extender timer."
  type        = string
  default     = "hourly"

  validation {
    condition     = length(trimspace(var.extender_schedule)) > 0
    error_message = "extender_schedule must be a non-empty systemd calendar expression such as hourly or *-*-* 00/6:00:00."
  }
}

variable "indexer_start_ledger" {
  description = "Ledger to begin indexing from. Leave unset to start at the current latest ledger; set it when re-indexing history, and remember the SQLite file already holds whatever it indexed before."
  type        = number
  default     = null

  validation {
    condition     = var.indexer_start_ledger == null ? true : var.indexer_start_ledger >= 1
    error_message = "indexer_start_ledger must be null (start at the latest ledger) or a ledger sequence of at least 1."
  }
}

variable "indexer_poll_interval_ms" {
  description = "Ledger poll interval. The indexer refuses anything below 250 ms."
  type        = number
  default     = 5000

  validation {
    condition     = var.indexer_poll_interval_ms >= 250 && var.indexer_poll_interval_ms <= 600000
    error_message = "indexer_poll_interval_ms must be between 250 and 600000; the indexer refuses anything below 250 ms."
  }
}

variable "rpc_fallback_urls" {
  description = "Extra Soroban RPC endpoints the indexer rotates through when the primary one rate-limits it."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for u in var.rpc_fallback_urls : can(regex("^https?://[A-Za-z0-9._:/-]+$", u))])
    error_message = "Every rpc_fallback_urls entry must be an http(s) URL with no query string."
  }
}

variable "prometheus_retention" {
  description = "TSDB retention for Prometheus. The disk on a hobby VM is the real limit here."
  type        = string
  default     = "15d"

  validation {
    condition     = can(regex("^[1-9][0-9]*[smhdwy]$", var.prometheus_retention))
    error_message = "prometheus_retention must be a Prometheus duration with a unit, such as 15d or 720h."
  }
}

variable "alert_repeat_interval" {
  description = "How often Alertmanager re-sends an unresolved warning."
  type        = string
  default     = "4h"

  validation {
    condition     = can(regex("^[1-9][0-9]*[smhdwy]$", var.alert_repeat_interval))
    error_message = "alert_repeat_interval must be a duration with a unit, such as 4h or 30m."
  }
}

variable "alert_receivers" {
  description = "Alert routing. Each entry names the env var that carries its webhook URL: a webhook URL is a credential, so it is substituted at container start and never written to git or state."
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
  description = "Extra Prometheus scrape targets as job => host:port (node_exporter, a second indexer, the contract's own metrics)."
  type        = map(string)
  default     = {}
}

variable "read_only_rootfs" {
  description = "Run the containers with a read-only root filesystem plus a tmpfs at /tmp."
  type        = bool
  default     = false
}

variable "log_max_size" {
  description = "Per-container JSON log rotation size."
  type        = string
  default     = "10m"

  validation {
    condition     = can(regex("^[1-9][0-9]*[kKmMgG]?$", var.log_max_size))
    error_message = "log_max_size must be a size such as 10m or 1g (docker's <number><unit> form)."
  }
}

variable "additional_notes" {
  description = "Appended verbatim to the rendered bundle README."
  type        = string
  default     = ""
}

variable "set_file_permissions" {
  description = "Apply rendered file modes through the local provider. The provider ignores them on Windows, where the bundle is only an artifact anyway."
  type        = bool
  default     = true
}
