variable "services" {
  description = "Long-running containers, straight from modules/services (all_services)."
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
  description = "One-shot TTL extender from modules/services; scheduled by a systemd timer only when enabled."
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
  description = "Rendered monitoring/service configuration from modules/services, keyed by bundle-relative path."
  type        = map(string)
}

variable "sentinel_config_json" {
  description = "ttl-sentinel JSON config file content."
  type        = string
}

variable "secrets" {
  description = "Output of modules/secrets. Only names, paths and the fetch script -- never values."
  type = object({
    strategy                      = string
    secret_paths_by_service       = map(string)
    fetch_script                  = string
    vault_agent_config            = optional(string)
    secret_names                  = list(string)
    k8s_secret_bootstrap_commands = string
    threat_notes                  = map(string)
  })
}

variable "bundle_dir" {
  description = "Where the rendered bundle is written. On the target machine point this at install_dir so the bundle is applied in place."
  type        = string
}

variable "install_dir" {
  description = "Host directory the bundle is installed into (compose file, systemd units)."
  type        = string
  default     = "/opt/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.install_dir))
    error_message = "install_dir must be an absolute POSIX path."
  }
}

variable "config_dir" {
  description = "Host directory holding rendered config and the 0600 secret files."
  type        = string
  default     = "/etc/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.config_dir))
    error_message = "config_dir must be an absolute POSIX path."
  }
}

variable "host_data_root" {
  description = "Host root for the bind-mounted service state (indexer SQLite, sentinel state). Must be a local filesystem: SQLite runs in WAL mode and does not tolerate NFS or multi-attach volumes."
  type        = string
  default     = "/var/lib/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.host_data_root))
    error_message = "host_data_root must be an absolute POSIX path."
  }
}

variable "host_log_root" {
  description = "Host root for the bind-mounted JSONL alert logs of the workload services."
  type        = string
  default     = "/var/log/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.host_log_root))
    error_message = "host_log_root must be an absolute POSIX path."
  }
}

variable "repo_root" {
  description = "Checkout of this repo on the target host; the local image builds read their contexts from here."
  type        = string
  default     = "/opt/streampay/src"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.repo_root))
    error_message = "repo_root must be an absolute POSIX path."
  }
}

variable "build_local" {
  description = "Build the three StreamPay images from the repo checkout instead of pulling them (the hobbyist path needs no registry)."
  type        = bool
  default     = true
}

variable "caddy_image" {
  description = "TLS terminating proxy image."
  type        = string
  default     = "caddy:2.8-alpine"
}

variable "project_name" {
  description = "Compose project name; also the prefix of the rendered systemd unit names."
  type        = string
  default     = "streampay"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,40}$", var.project_name))
    error_message = "project_name must be a lowercase DNS-label-like name."
  }
}

variable "admin_bind_address" {
  description = "Address the operator-only ports bind on. Keep loopback and reach them through an SSH tunnel; set 0.0.0.0 only when something in front enforces auth."
  type        = string
  default     = "127.0.0.1"

  validation {
    condition     = can(regex("^(127\\.0\\.0\\.1|0\\.0\\.0\\.0|::1)$", var.admin_bind_address))
    error_message = "admin_bind_address must be 127.0.0.1, ::1 or 0.0.0.0."
  }
}

variable "grafana_host_port" {
  description = "Host port for Grafana on admin_bind_address. 0 disables the direct binding entirely (TLS proxy only)."
  type        = number
  default     = 3000

  validation {
    condition     = var.grafana_host_port == 0 || (var.grafana_host_port >= 1024 && var.grafana_host_port <= 65535)
    error_message = "grafana_host_port must be 0 (off) or an unprivileged port."
  }
}

variable "prometheus_host_port" {
  description = "Host port for Prometheus on admin_bind_address. Prometheus has no authentication, so the default is unpublished: view it through Grafana or an SSH tunnel."
  type        = number
  default     = 0

  validation {
    condition     = var.prometheus_host_port == 0 || (var.prometheus_host_port >= 1024 && var.prometheus_host_port <= 65535)
    error_message = "prometheus_host_port must be 0 (off) or an unprivileged port."
  }
}

variable "indexer_host_port" {
  description = "Host port for the indexer API on admin_bind_address. 0 keeps it reachable only from the TLS proxy and the docker network."
  type        = number
  default     = 0
}

variable "tls_mode" {
  description = <<-EOT
    How the public listener gets TLS:
      acme     - Caddy gets a certificate from Let's Encrypt. Needs a DNS A/AAAA
                 record for tls_domain pointing at this host and 80/443 open.
      internal - Caddy's own local CA: encrypted, not trusted by browsers. Use
                 for an IP-only host or a private network; distribute the CA.
      file     - you already hold a certificate (ACM/Smallstep/private CA); the
                 paths are mounted read-only and are expected to be provisioned
                 by the secret delivery mechanism, not committed.
      off      - plain HTTP. Only sane when something in front terminates TLS.
  EOT
  type        = string
  default     = "internal"

  validation {
    condition     = contains(["acme", "internal", "file", "off"], var.tls_mode)
    error_message = "tls_mode must be acme, internal, file or off."
  }
}

variable "tls_domain" {
  description = "Public hostname for the listener. Required for tls_mode=acme; for internal/off it only drives the Host header."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_domain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$", var.tls_domain))
    error_message = "tls_domain must be a lowercase hostname without scheme or port."
  }
}

variable "tls_email" {
  description = "Registration address for Let's Encrypt (tls_mode=acme). Recommended: an alias, not a personal address, since ACME stores it."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$", var.tls_email))
    error_message = "tls_email must be empty or a plain email address."
  }
}

variable "tls_cert_file" {
  description = "tls_mode=file: host path of the certificate chain. Deliver it through the secrets mechanism; it must never be committed."
  type        = string
  default     = ""
}

variable "tls_key_file" {
  description = "tls_mode=file: host path of the private key (expected mode 0600)."
  type        = string
  default     = ""
}

variable "expose_indexer_api" {
  description = "Route the indexer's read endpoints through the TLS listener so the hosted frontend can call them. Metrics and health stay internal."
  type        = bool
  default     = false
}

variable "host_http_port" {
  description = "Public HTTP port (redirect target for ACME challenges too)."
  type        = number
  default     = 80
}

variable "host_https_port" {
  description = "Public HTTPS port."
  type        = number
  default     = 443
}

variable "container_limits" {
  description = "Per-service resource ceilings, keyed by service key. Stops one runaway poller from taking the VM down."
  type = map(object({
    memory     = optional(string)
    cpus       = optional(string)
    pids_limit = optional(number)
  }))
  default = {}
}

variable "log_max_size" {
  description = "Per-container log rotation size."
  type        = string
  default     = "10m"
}

variable "log_max_file" {
  description = "Per-container log rotation count."
  type        = number
  default     = 5
}

variable "read_only_rootfs" {
  description = "Mount container root filesystems read-only with a tmpfs at /tmp. Hardening worth enabling once you have confirmed no service needs to write elsewhere."
  type        = bool
  default     = false
}

variable "apply_locally" {
  description = "Run the bootstrap on the machine Terraform runs on (the fresh-VM path: Terraform is installed there and this is the machine being deployed to). Leave false when the bundle is carried to the host by cloud-init or a human."
  type        = bool
  default     = false
}

variable "bootstrap_command" {
  description = "Command used to run install.sh. Override for a target you reach over SSH, e.g. [\"ssh\", \"root@host\", \"bash /opt/streampay/install.sh\"]."
  type        = list(string)
  default     = null
}

variable "skip_image_build" {
  description = "Skip docker build in the bootstrap (images already published, or a registry mirror is in use)."
  type        = bool
  default     = false
}

variable "extender_schedule" {
  description = "systemd-calendar expression for the one-shot TTL extender when enabled."
  type        = string
  default     = "hourly"

  validation {
    condition     = can(regex("^[A-Za-z0-9:., *()/=@-]+$", var.extender_schedule))
    error_message = "extender_schedule must be a systemd calendar expression such as hourly, *-*-* */2:00:00 or oncalendar."
  }
}

variable "additional_notes" {
  description = "Extra paragraphs appended to the rendered bundle README (per-stack gotchas)."
  type        = string
  default     = ""
}

variable "image_builds" {
  description = "Images install.sh builds from the repo checkout when build_local=true: image tag plus context and Dockerfile paths, relative to repo_root."
  type = list(object({
    key        = string
    image      = string
    context    = string
    dockerfile = string
  }))
  default = []

  validation {
    condition     = alltrue([for b in var.image_builds : can(regex("^[a-z0-9][a-z0-9._/-]*(:[a-z0-9._-]+)?$", b.image))])
    error_message = "Every image_builds entry needs a valid lowercase image:tag reference."
  }

  validation {
    condition     = alltrue([for b in var.image_builds : !can(regex("^/|\\.\\.", b.context)) && !can(regex("^/|\\.\\.", b.dockerfile))])
    error_message = "image_builds context and dockerfile must be relative to repo_root (no leading slash, no ..)."
  }
}

variable "image_build_digests" {
  description = "Digest of each image source (Dockerfile + build context) keyed by image_builds key. Feed filesha256() of the Dockerfiles in so changing an image definition re-triggers the bootstrap."
  type        = map(string)
  default     = {}
}

variable "set_file_permissions" {
  description = "Apply the rendered file modes to the bundle with the local provider. The local provider ignores file_permission on Windows, so this only matters on the target host; set it false if a filesystem cannot carry modes."
  type        = bool
  default     = true
}
