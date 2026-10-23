# Variables for the StreamPay service-configuration module.
#
# Everything here is *plain configuration*. Secrets never appear as a variable
# in this module: services receive only the *names* of the environment
# variables that carry their secrets, and the secrets module turns those names
# into per-platform wiring (SSM, Vault agent, host env, k8s secretKeyRef).

variable "chain" {
  description = <<-EOT
    Which Stellar network the stack observes and the contract id it indexes.
    Set `network` to testnet, futurenet or mainnet and leave the URLs empty to
    use the public endpoints for that network, or pin them to your own RPC/Horizon.
  EOT
  type = object({
    network            = optional(string, "testnet")
    contract_id        = string
    rpc_url            = optional(string, "")
    horizon_url        = optional(string, "")
    network_passphrase = optional(string, "")
  })

  validation {
    condition     = contains(["testnet", "futurenet", "mainnet"], var.chain.network)
    error_message = "chain.network must be one of testnet, futurenet, mainnet."
  }

  validation {
    # Stellar strkey: 56 chars, base32 alphabet, `C` for a contract account.
    condition     = can(regex("^C[A-Z2-7]{55}$", var.chain.contract_id))
    error_message = "chain.contract_id must be a Soroban contract id (C + 55 base32 characters, 56 total)."
  }
}

variable "runtime" {
  description = "Tuning knobs for the four workload services. Every field has an operationally sane default."
  type = object({
    indexer_port             = optional(number, 8787)
    indexer_poll_interval_ms = optional(number, 5000)
    indexer_database_path    = optional(string, "/var/lib/streampay/indexer/streampay.sqlite")
    indexer_rpc_fallbacks    = optional(list(string), [])
    indexer_rpc_max_rps      = optional(number, 10)
    indexer_start_ledger     = optional(number)

    reconciler_poll_interval_ms      = optional(number, 5000)
    reconciler_consistency_window_ms = optional(number, 30000)
    reconciler_log_level             = optional(string, "INFO")
    reconciler_id                    = optional(string, "primary-001")
    reconciler_stream_ids            = optional(list(string), [])
    reconciler_enabled               = optional(bool, true)

    sentinel_scan_interval_sec       = optional(number, 300)
    sentinel_state_path              = optional(string, "/var/lib/streampay/ttl-sentinel.state.json")
    sentinel_alerts_jsonl_path       = optional(string, "/var/log/streampay/sentinel-alerts.jsonl")
    sentinel_max_streams             = optional(number, 100000)
    sentinel_extender_enabled        = optional(bool, false)
    sentinel_extender_secret_env     = optional(string, "TTL_SENTINEL_EXTENDER_SECRET")
    sentinel_extender_monthly_budget = optional(string, "1")
    sentinel_extender_threshold      = optional(number, 200000)
    sentinel_extender_to             = optional(number, 500000)
    sentinel_extender_max_entries_tx = optional(number, 20)
    sentinel_extender_dry_run        = optional(bool, true)
    sentinel_enabled                 = optional(bool, true)

    scrape_interval       = optional(string, "5s")
    evaluation_interval   = optional(string, "5s")
    prometheus_retention  = optional(string, "15d")
    alert_repeat_interval = optional(string, "4h")
  })

  validation {
    condition     = var.runtime.indexer_poll_interval_ms >= 250
    error_message = "runtime.indexer_poll_interval_ms must be >= 250 (the indexer refuses anything lower)."
  }

  validation {
    condition     = contains(["DEBUG", "INFO", "WARN", "ERROR"], var.runtime.reconciler_log_level)
    error_message = "runtime.reconciler_log_level must be DEBUG, INFO, WARN or ERROR."
  }

  validation {
    condition = alltrue([
      for url in var.runtime.indexer_rpc_fallbacks :
      can(regex("^https?://", url))
    ])
    error_message = "Every runtime.indexer_rpc_fallbacks entry must be an http(s) URL."
  }

  # The container mount for the state file is derived from these paths, and
  # containers only understand POSIX paths.
  validation {
    condition = alltrue([
      for p in [var.runtime.indexer_database_path, var.runtime.sentinel_state_path, var.runtime.sentinel_alerts_jsonl_path] :
      can(regex("^/[A-Za-z0-9._/ -]+$", p))
    ])
    error_message = "runtime database/state/log paths must be absolute POSIX paths (no backslashes, no relative start): they are mounted into containers."
  }

  validation {
    # Extending *below* the threshold would re-extend everything on every scan;
    # the sentinel refuses it at runtime, so refuse it at plan time too.
    condition     = var.runtime.sentinel_extender_to > var.runtime.sentinel_extender_threshold
    error_message = "runtime.sentinel_extender_to must exceed sentinel_extender_threshold (extend-to is a floor, not a target)."
  }

  validation {
    condition     = var.runtime.sentinel_extender_to < 6312000
    error_message = "runtime.sentinel_extender_to must stay below Soroban max_entry_ttl (6312000 ledgers)."
  }
}

variable "images" {
  description = "Container images for the stack. Point these at your own registry-mirrored, digest-pinned tags for production."
  type = object({
    indexer      = optional(string, "streampay/indexer:local")
    reconciler   = optional(string, "streampay/reconciler:local")
    sentinel     = optional(string, "streampay/ttl-sentinel:local")
    prometheus   = optional(string, "prom/prometheus:v2.50.1")
    alertmanager = optional(string, "prom/alertmanager:v0.27.0")
    grafana      = optional(string, "grafana/grafana:10.4.0")
    caddy        = optional(string, "caddy:2.8-alpine")
    node         = optional(string, "node:22-alpine")
  })
}

variable "namespace_prefix" {
  description = "Prefix for k8s object names and for systemd/compose project naming."
  type        = string
  default     = "streampay"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$", var.namespace_prefix))
    error_message = "namespace_prefix must be a lowercase DNS label (a-z0-9 and dashes), 2-50 characters."
  }
}

variable "metrics_targets" {
  description = "Extra Prometheus scrape targets as job_name => host:port. Use this for the reconciler variant that exposes /metrics, node exporters, or a second indexer."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for job, target in var.metrics_targets :
      can(regex("^[A-Za-z0-9._-]+(:[0-9]{1,5})?$", target))
    ])
    error_message = "Each metrics_targets value must be host or host:port with no scheme or path."
  }
}

variable "alert_receivers" {
  description = "Routing table for Alertmanager. `secret_env` names a variable holding the sink URL: the URL is a credential, so it is expanded at container start and never stored in git or terraform state."
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
    error_message = "Every alert_receivers entry needs either secret_env (preferred) or static_url."
  }

  validation {
    condition = alltrue([
      for r in var.alert_receivers :
      r.static_url == null || can(regex("^https?://", r.static_url))
    ])
    error_message = "alert_receivers static_url must be an http(s) URL and must not contain credentials."
  }
}

variable "container_env_passthrough" {
  description = "Secret-bearing env var names, grouped by service, that the platform layer injects by reference (never by value). Keys are indexer|reconciler|sentinel|grafana|alertmanager."
  type        = map(list(string))
  default = {
    indexer      = []
    reconciler   = ["HORIZON_API_TOKEN", "SOROBAN_RPC_TOKEN", "WEBHOOK_URL"]
    sentinel     = ["TTL_SENTINEL_WEBHOOK_URL", "TTL_SENTINEL_EXTENDER_SECRET"]
    grafana      = ["GF_SECURITY_ADMIN_USER", "GF_SECURITY_ADMIN_PASSWORD"]
    alertmanager = ["STREAMPAY_ALERT_SINK_URL", "STREAMPAY_P0_ALERT_SINK_URL"]
  }
}
