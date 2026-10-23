# Variables for stacks/kubernetes: the org-facing path.
#
# Anything a cluster owner must decide is here; anything the modules can derive
# (URLs, env maps, ports, config files) is derived in modules/services. Values
# of secrets are never a variable in this stack, in any strategy.

variable "contract_id" {
  description = "Soroban contract id the indexer observes (C... strkey)."
  type        = string

  validation {
    condition     = can(regex("^C[A-Z2-7]{55}$", var.contract_id))
    error_message = "contract_id must be a Soroban contract id: C followed by 55 base32 characters (56 total)."
  }
}

variable "namespace" {
  description = "Namespace the stack lives in. Every rendered object carries it, and the NetworkPolicies only ever speak to peers inside it."
  type        = string
  default     = "streampay"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,61}[a-z0-9]$", var.namespace))
    error_message = "namespace must be a valid DNS label (lowercase letters, digits, hyphens)."
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
    Image references. A cluster cannot see tags you built into your laptop's
    docker daemon, so the three StreamPay images must point at a registry the
    kubelet can pull from (see image_pull_secrets). The :local defaults are what
    CI renders against; they only work on kind/minikube with a loaded image.
  EOT
  type = object({
    indexer      = optional(string, "streampay/indexer:local")
    reconciler   = optional(string, "streampay/reconciler:local")
    sentinel     = optional(string, "streampay/ttl-sentinel:local")
    prometheus   = optional(string, "prom/prometheus:v2.50.1")
    alertmanager = optional(string, "prom/alertmanager:v0.27.0")
    grafana      = optional(string, "grafana/grafana:10.4.0")
  })
  default = {}
}

variable "manifest_dir" {
  description = "Where manifests.yaml and its README are written. Defaults to this stack's build/ directory, which is git-ignored: a rendered cluster file holding your contract id has no business being committed."
  type        = string
  default     = null

  validation {
    condition     = var.manifest_dir == null || can(regex("^[A-Za-z0-9._:/\\\\-]", var.manifest_dir))
    error_message = "manifest_dir must be a plain filesystem path with no spaces or shell metacharacters."
  }
}

variable "apply_with_kubectl" {
  description = "Also run kubectl apply on the rendered manifests from this Terraform run. Off by default because most platform teams want GitOps to own the apply; the file is the deliverable."
  type        = bool
  default     = false
}

variable "kubectl_command" {
  description = "How to invoke kubectl when apply_with_kubectl=true, e.g. [\"gke-kubectl\", \"--project\", \"p\"]. The manifest path is appended."
  type        = list(string)
  default     = ["kubectl", "apply", "-f"]

  validation {
    condition     = length(var.kubectl_command) > 0 && var.kubectl_command[0] != ""
    error_message = "kubectl_command must start with the executable name."
  }
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------

variable "k8s_secret_prefix" {
  description = "Each service gets its own Secret named <prefix>-<service>. Splitting them is the point: the Grafana pod never sees the funded extender key."
  type        = string
  default     = "streampay-secrets"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,240}$", var.k8s_secret_prefix))
    error_message = "k8s_secret_prefix must be a lowercase DNS subdomain prefix."
  }
}

variable "k8s_secret_optional" {
  description = "When false, pods refuse to start until the Secret exists: fail fast on a missing funded key instead of running half-configured. Turn it true only while you are still bringing the dashboard up."
  type        = bool
  default     = false
}

variable "strict_secret_names" {
  description = "Names the operator must supply or the bootstrap commands fail. The funded extender key is added automatically once the extender spends."
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Placement and resources
# -----------------------------------------------------------------------------

variable "storage_class_name" {
  description = "StorageClass for the data PVCs. Empty means the cluster default; set it explicitly when the default is not block storage, because the indexer's SQLite file needs a real RWO volume."
  type        = string
  default     = ""

  validation {
    condition     = var.storage_class_name == "" || can(regex("^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$", var.storage_class_name))
    error_message = "storage_class_name must be empty or a lowercase DNS-style name."
  }
}

variable "storage_requests" {
  description = "PVC size per service key. Prometheus and the indexer both grow without stopping; a full volume looks exactly like a contract bug from the outside."
  type        = map(string)
  default = {
    indexer      = "10Gi"
    sentinel     = "2Gi"
    prometheus   = "20Gi"
    alertmanager = "2Gi"
    grafana      = "5Gi"
  }
}

variable "resources" {
  description = "Requests and limits per service key. Requests are what the scheduler guarantees; without them a node under memory pressure evicts the indexer mid-write."
  type = map(object({
    requests_cpu    = optional(string)
    requests_memory = optional(string)
    limits_cpu      = optional(string)
    limits_memory   = optional(string)
  }))
  default = {
    indexer      = { requests_cpu = "100m", requests_memory = "256Mi", limits_cpu = "1", limits_memory = "1Gi" }
    reconciler   = { requests_cpu = "50m", requests_memory = "128Mi", limits_cpu = "500m", limits_memory = "512Mi" }
    sentinel     = { requests_cpu = "50m", requests_memory = "128Mi", limits_cpu = "500m", limits_memory = "512Mi" }
    prometheus   = { requests_cpu = "200m", requests_memory = "512Mi", limits_cpu = "2", limits_memory = "2Gi" }
    alertmanager = { requests_cpu = "50m", requests_memory = "128Mi", limits_cpu = "500m", limits_memory = "512Mi" }
    grafana      = { requests_cpu = "100m", requests_memory = "256Mi", limits_cpu = "1", limits_memory = "1Gi" }
  }
}

variable "image_pull_secrets" {
  description = "docker-registry Secret names for a private registry. Empty means the images are public or pre-pulled on the nodes."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for s in var.image_pull_secrets : can(regex("^[a-z][a-z0-9.-]{0,252}[a-z0-9]$", s))])
    error_message = "Each image_pull_secrets entry must be a lowercase DNS-style Secret name."
  }
}

variable "image_pull_policy" {
  description = "pullPolicy for the StreamPay images. :latest requires Always or a redeploy silently keeps the old image; a digest pin can use IfNotPresent."
  type        = string
  default     = "IfNotPresent"

  validation {
    condition     = contains(["Always", "IfNotPresent", "Never"], var.image_pull_policy)
    error_message = "image_pull_policy must be Always, IfNotPresent or Never."
  }
}

variable "node_selector" {
  description = "nodeSelector for every pod, e.g. to keep the SQLite-backed indexer on a node with a local volume."
  type        = map(string)
  default     = {}
}

variable "run_as_user" {
  description = "Override the uid a service runs as, keyed by service. Only useful after rebuilding an image with a different USER."
  type        = map(number)
  default     = {}
}

variable "read_only_rootfs" {
  description = "Read-only root filesystem plus emptyDirs at the paths that must stay writable. The manifest set accounts for every writable path, so leave this on."
  type        = bool
  default     = true
}

variable "skip_namespaced_manifest" {
  description = "Do not render the Namespace object (your platform team, GitOps app-of-apps or OpenShift project creates it)."
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Public listener
# -----------------------------------------------------------------------------

variable "ingress_class_name" {
  description = "ingressClassName for the public listener. Empty omits it and lets the cluster default apply."
  type        = string
  default     = "nginx"
}

variable "ingress_host" {
  description = "Hostname for the dashboard (and the indexer API when exposed). Empty renders a host-less, catch-all rule."
  type        = string
  default     = ""

  validation {
    condition     = var.ingress_host == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.ingress_host))
    error_message = "ingress_host must be empty or a fully qualified lowercase hostname (no scheme, port or path)."
  }
}

variable "ingress_tls_mode" {
  description = <<-EOT
    How the public listener gets its certificate:
      cert-manager     - annotation plus a tls Secret the issuer maintains.
      existing-secret  - reference a kubernetes.io/tls Secret you created.
      off              - plain HTTP; only sane behind a proxy you authenticate at.
  EOT
  type        = string
  default     = "cert-manager"

  validation {
    condition     = contains(["cert-manager", "existing-secret", "off"], var.ingress_tls_mode)
    error_message = "ingress_tls_mode must be cert-manager, existing-secret or off."
  }
}

variable "cert_manager_cluster_issuer" {
  description = "Issuer/ClusterIssuer name for ingress_tls_mode=cert-manager. Without it cert-manager ignores the Ingress and no certificate is ever issued."
  type        = string
  default     = ""
}

variable "ingress_tls_secret" {
  description = "tls Secret the ingress references: written by cert-manager, or pre-created for existing-secret."
  type        = string
  default     = "streampay-tls"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,61}[a-z0-9]$", var.ingress_tls_secret))
    error_message = "ingress_tls_secret must be a valid DNS label."
  }
}

variable "ingress_tls_is_namespaced_issuer" {
  description = "Use cert-manager.io/issuer instead of the cluster-scoped one. A tenant namespace usually should not be able to order certificates from the platform issuer."
  type        = bool
  default     = false
}

variable "ingress_annotations" {
  description = "Extra controller annotations (proxy-body-size, whitelist-source-range, modsecurity)."
  type        = map(string)
  default     = {}
}

variable "expose_indexer_api" {
  description = "Publish the indexer's read endpoints on the ingress so a hosted frontend can call them. /health and /metrics stay cluster-internal either way."
  type        = bool
  default     = false
}

variable "ingress_controller_namespace_label" {
  description = "Namespace label identifying the ingress controller, e.g. {\"streampay.io/ingress\" = \"true\"}. Empty keeps the default-deny policy, so the dashboard is port-forward only."
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Workload toggles and tuning
# -----------------------------------------------------------------------------

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
  description = "Render the TTL-extender CronJob. It spends real XLM per pass, so it is off until you say otherwise."
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
  description = "CronJob schedule, five fields, UTC. Kubernetes has no concept of your local time."
  type        = string
  default     = "5 * * * *"

  validation {
    condition     = can(regex("^[0-9*/,-]+( [0-9*/,-]+){3} [0-9*/,-]+$", var.extender_schedule))
    error_message = "extender_schedule must be a five-field cron expression such as \"5 * * * *\"."
  }
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
  description = "TSDB retention. The PVC size above is the real limit."
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
  description = "Extra Prometheus scrape targets as job => host:port. In-cluster targets are addressed by Service name, e.g. \"infra-reconciler\" = \"streampay-infra-reconciler:9464\"."
  type        = map(string)
  default     = {}
}

variable "additional_notes" {
  description = "Appended verbatim to the rendered apply README so the instructions travel with the manifests."
  type        = string
  default     = ""
}
