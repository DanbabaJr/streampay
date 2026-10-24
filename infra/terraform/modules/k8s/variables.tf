variable "namespace" {
  description = "Kubernetes namespace the whole stack lives in. Every rendered object carries it, and the NetworkPolicies only ever speak to peers inside it."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,61}[a-z0-9]$", var.namespace))
    error_message = "namespace must be a valid DNS label (lowercase letters, digits, hyphens)."
  }
}

variable "services" {
  description = "Long-running workloads and monitoring containers, straight from modules/services (all_services)."
  type = list(object({
    name       = string
    key        = string
    image      = string
    command    = list(string)
    args       = list(string)
    env        = map(string)
    secret_env = list(string)
    ports = list(object({
      name      = string
      container = number
      expose    = bool
    }))
    health_path  = optional(string)
    metrics_path = optional(string)
    data_volume = optional(object({
      mount = string
      name  = string
    }))
    log_volume = optional(bool, false)
    depends_on = optional(list(string), [])
  }))
}

variable "extender" {
  description = "One-shot TTL extender from modules/services, rendered as a CronJob only when enabled."
  type = object({
    enabled    = bool
    name       = string
    image      = string
    command    = list(string)
    args       = list(string)
    env        = map(string)
    secret_env = list(string)
    execute    = optional(bool, false)
  })
}

variable "chain" {
  description = "Normalized network + contract id from modules/services."
  type = object({
    network            = string
    contract_id        = string
    rpc_url            = string
    horizon_url        = string
    network_passphrase = string
  })
}

variable "config_files" {
  description = "Rendered monitoring/service configuration from modules/services, keyed exactly as modules/vm expects (prometheus.yml, prometheus-rules.yml, alertmanager-template.yml, alertmanager-rewrite.sh, grafana-datasource.yml, grafana-provider.yml, grafana-dashboard.json)."
  type        = map(string)

  validation {
    condition = alltrue([
      for k in ["prometheus.yml", "prometheus-rules.yml", "alertmanager-template.yml", "alertmanager-rewrite.sh", "grafana-datasource.yml", "grafana-provider.yml", "grafana-dashboard.json"] :
      contains(keys(var.config_files), k)
    ])
    error_message = "config_files must carry every key the stack mounts; see modules/k8s/variables.tf for the required set."
  }
}

variable "sentinel_config_json" {
  description = "ttl-sentinel JSON config file content."
  type        = string
}

variable "secrets" {
  description = "Output of modules/secrets for strategy=k8s_secret: names and Secret references only, never values."
  type = object({
    strategy                      = string
    secret_paths_by_service       = map(string)
    fetch_script                  = string
    vault_agent_config            = optional(string)
    secret_names                  = list(string)
    k8s_secret_names_by_service   = map(string)
    k8s_env_from_by_service       = map(list(object({ secretRef = object({ name = string, optional = bool }) })))
    k8s_secret_bootstrap_commands = string
    threat_notes                  = map(string)
  })
}

variable "storage_class_name" {
  description = "StorageClass for the data PVCs. Empty string means the cluster default. Set it explicitly when the default is a ReadWriteOnce block storage class, which is what the indexer's SQLite file needs."
  type        = string
  default     = ""
}

variable "storage_requests" {
  description = "PVC size per service key. The indexer keeps an SQLite ledger, Prometheus keeps a TSDB: both grow, and a full volume takes the stack down in a way that looks like a contract bug."
  type        = map(string)
  default = {
    indexer      = "10Gi"
    sentinel     = "2Gi"
    prometheus   = "20Gi"
    alertmanager = "2Gi"
    grafana      = "5Gi"
  }
}

variable "access_modes" {
  description = "Access modes for every data PVC. Keep ReadWriteOnce: the indexer runs SQLite in WAL mode, which corrupts on a shared filesystem, and nothing else here needs to be shared."
  type        = list(string)
  default     = ["ReadWriteOnce"]
}

variable "resources" {
  description = "Requests and limits per service key. A requests/limits pair makes the scheduler place the pods on a node that can hold them, which is the difference between a slow stack and a CrashLoopBackOff on a small cluster."
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
  description = "Names of docker-registry Secrets to attach to the pod template. Only needed once the images live in a private registry; the minimal path builds them from this repo."
  type        = list(string)
  default     = []
}

variable "image_pull_policy" {
  description = "pullPolicy for our own images. If you tag builds with :latest you must use Always or a re-deploy silently keeps running the old image; a digest-pinned tag can use IfNotPresent."
  type        = string
  default     = "IfNotPresent"

  validation {
    condition     = contains(["Always", "IfNotPresent", "Never"], var.image_pull_policy)
    error_message = "image_pull_policy must be Always, IfNotPresent or Never."
  }
}

variable "ingress_class_name" {
  description = "IngressClassName for the public listener. Empty string omits the field and lets the cluster pick its default ingress class."
  type        = string
  default     = "nginx"
}

variable "ingress_host" {
  description = "Hostname the dashboard (and indexer API, when exposed) is served on. Empty renders an ingress with no host match, which most controllers then serve as the catch-all rule."
  type        = string
  default     = ""

  validation {
    condition     = var.ingress_host == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.ingress_host))
    error_message = "ingress_host must be empty or a fully qualified lowercase hostname (no scheme, no port, no path)."
  }
}

variable "ingress_tls_mode" {
  description = <<-EOT
    How the ingress gets its certificate:
      cert-manager      - adds the cert-manager.io/cluster-issuer annotation and a
                          tls block backed by a Secret cert-manager maintains.
      existing-secret   - references a tls Secret you created out of band (Load
                          balancer cert copied in, ACM imported, corporate CA).
      off               - plain HTTP ingress. Only for an internal namespace
                         behind an authenticating proxy you control.
  EOT
  type        = string
  default     = "cert-manager"

  validation {
    condition     = contains(["cert-manager", "existing-secret", "off"], var.ingress_tls_mode)
    error_message = "ingress_tls_mode must be cert-manager, existing-secret or off."
  }
}

variable "ingress_tls_secret" {
  description = "Name of the kubernetes.io/tls Secret the ingress references. With cert-manager this is the Secret the issuer writes; with existing-secret it must already hold cert/key."
  type        = string
  default     = "streampay-tls"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,61}[a-z0-9]$", var.ingress_tls_secret))
    error_message = "ingress_tls_secret must be a valid DNS label."
  }
}

variable "cert_manager_cluster_issuer" {
  description = "ClusterIssuer (or Issuer, via ingress_tls_is_namespaced_issuer) that services the certificate. Required for ingress_tls_mode=cert-manager."
  type        = string
  default     = ""
}

variable "ingress_tls_is_namespaced_issuer" {
  description = "Use the namespaced issuer.io/issuer annotation instead of the cluster-scoped one. A tenant namespace usually should not be able to ask for certificates from the platform ClusterIssuer."
  type        = bool
  default     = false
}

variable "ingress_annotations" {
  description = "Extra ingress annotations (controller specific: proxy-body-size, ssl-redirect, whitelist-source-range)."
  type        = map(string)
  default     = {}
}

variable "expose_indexer_api" {
  description = "Add the indexer's read endpoints to the ingress so a hosted frontend can call them. Off by default: /health and /metrics stay cluster-internal either way."
  type        = bool
  default     = false
}

variable "ingress_controller_namespace_label" {
  description = "NamespaceSelector label that marks the namespace holding the ingress controller, e.g. {\"streampay.io/ingress\" = \"true\"}. NetworkPolicy only allows the controller's pods if this is set; leave it empty to keep the dashboard reachable only via port-forward."
  type        = map(string)
  default     = {}
}

variable "prometheus_scrape_pod_label" {
  description = "Label selector value used to permit scrape traffic inside the namespace. All stack pods carry it, so one rule covers Prometheus pulling from every target."
  type        = string
  default     = "streampay"

  validation {
    condition     = can(regex("^[a-z][a-z0-9.-]{0,62}$", var.prometheus_scrape_pod_label))
    error_message = "prometheus_scrape_pod_label must be a lowercase label value."
  }
}

variable "extender_schedule" {
  description = "Cron expression (schedule field) for the one-shot TTL extender CronJob. Use a UTC schedule; Kubernetes has no concept of your local time."
  type        = string
  default     = "5 * * * *"

  validation {
    condition     = can(regex("^[0-9*/,-]+( [0-9*/,-]+){3} [0-9*/,-]+$", var.extender_schedule))
    error_message = "extender_schedule must be a five-field cron expression such as \"5 * * * *\"."
  }
}

variable "history_limits" {
  description = "successfulJobsPending / failedJobsHistoryLimit for the extender CronJob. The failed history is what tells you the funder stopped working, so do not zero it."
  type = object({
    successful = optional(number, 3)
    failed     = optional(number, 3)
  })
  default = { successful = 3, failed = 3 }
}

variable "pod_annotations" {
  description = "Annotations merged into every pod template (prometheus.io/scrape style hints, openmetrics relabeling, per-distribution requirements)."
  type        = map(string)
  default     = {}
}

variable "node_selector" {
  description = "nodeSelector applied to every pod. Useful to keep the SQLite-backed indexer on a node with a local volume."
  type        = map(string)
  default     = {}
}

variable "read_only_rootfs" {
  description = "Run containers with a read-only root filesystem plus tmpfs-like emptyDirs at the paths they legitimately write. On by default here because the manifest set accounts for every writable path."
  type        = bool
  default     = true
}

variable "run_as_user" {
  description = "Override the uid a service runs as, keyed by service key. The defaults match the images in this repo and the official monitoring images; change one only when you rebuilt an image with a different USER."
  type        = map(number)
  default     = {}

  validation {
    condition     = alltrue([for uid in values(var.run_as_user) : uid >= 1000 || uid == 65534 || uid == 472])
    error_message = "run_as_user must be an unprivileged uid (>= 1000, or the uid the upstream image ships); root containers are not an option here."
  }
}

variable "skip_namespaced_manifest" {
  description = "Do not render the Namespace object (the namespace is created by your platform team, GitOps app-of-apps, or an OpenShift project)."
  type        = bool
  default     = false
}

variable "additional_notes" {
  description = "Extra paragraphs appended to the rendered apply-instructions README."
  type        = string
  default     = ""
}
