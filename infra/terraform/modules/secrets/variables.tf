variable "strategy" {
  description = <<-EOT
    How secret values reach the containers. No strategy ever puts a plaintext
    value into git, terraform state, or a rendered bundle file:
      env        - host environment variables; the fetch script reads the
                   environment it was run in and writes 0600 per-service files.
      file       - one operator-owned KEY=VALUE file (e.g. delivered by
                   Ansible/SCP). Terraform audits its mode and key coverage,
                   then splits it per service.
      ssm        - AWS SSM SecureString, fetched at boot through the instance
                   profile: nothing is stored on the host between boots.
      vault      - HashiCorp Vault via Vault Agent (config rendered here) or the
                   vault CLI, with the same agent-file handoff.
      k8s_secret - workloads use envFrom against a Secret the operator created
                   out of band; nothing to do on a host.
  EOT
  type        = string
  default     = "env"

  validation {
    condition     = contains(["env", "file", "ssm", "vault", "k8s_secret"], var.strategy)
    error_message = "strategy must be one of env, file, ssm, vault, k8s_secret."
  }
}

variable "service_secret_names" {
  description = "Secret env var names per service key, usually wired straight from modules/services secret_env_names_by_service. Names are configuration; values are not Terraform's problem."
  type        = map(list(string))

  validation {
    condition = alltrue(flatten([
      for svc, names in var.service_secret_names :
      [for n in names : can(regex("^[A-Z][A-Z0-9]{1,60}(_[A-Z0-9]+)*$", n))]
    ]))
    error_message = "Every secret name must be UPPER_ALNUM (^[A-Z][A-Z0-9_]+$) to survive systemd and compose env parsing."
  }

  validation {
    condition = alltrue([
      for svc in keys(var.service_secret_names) :
      can(regex("^[a-z0-9][a-z0-9-]{0,40}$", svc))
    ])
    error_message = "service_secret_names keys become file and Secret names, so they must be lowercase DNS labels."
  }
}

variable "install_dir" {
  description = "Host directory that holds the materialized per-service secret files (mode 750)."
  type        = string
  default     = "/etc/streampay"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9._/-]+$", var.install_dir))
    error_message = "install_dir must be an absolute POSIX path."
  }
}

variable "secrets_file_mode" {
  description = "Octal mode of the materialized secret files."
  type        = string
  default     = "600"

  validation {
    condition     = contains(["600", "400", "640"], var.secrets_file_mode)
    error_message = "secrets_file_mode must be 600, 400 or 640; anything looser exposes a funded key."
  }
}

variable "operator_file" {
  description = "strategy=file only: the operator-managed union file the split reads from."
  type        = string
  default     = ""

  validation {
    condition     = var.operator_file == "" || can(regex("^/", var.operator_file))
    error_message = "operator_file must be an absolute path (strategy=file)."
  }
}

variable "ssm_path_prefix" {
  description = "strategy=ssm: SecureStrings are read from <prefix>/<SECRET_NAME>. Scope the instance role to exactly these ARNs."
  type        = string
  default     = ""

  validation {
    condition     = var.ssm_path_prefix == "" || can(regex("^/[a-zA-Z0-9_/._-]+$", var.ssm_path_prefix))
    error_message = "ssm_path_prefix must be an absolute SSM hierarchy like /streampay/testnet."
  }
}

variable "ssm_region" {
  description = "strategy=ssm: region to pass to the CLI. Empty means the instance profile's own region."
  type        = string
  default     = ""
}

variable "vault_mount" {
  description = "strategy=vault: KV v2 path holding the secret, e.g. kv/streampay/testnet."
  type        = string
  default     = ""

  validation {
    condition     = var.vault_mount == "" || can(regex("^[a-zA-Z0-9._/-]+$", var.vault_mount))
    error_message = "vault_mount must look like kv/streampay/testnet, with no leading or trailing slash."
  }
}

variable "vault_agent_file" {
  description = "strategy=vault: file the Vault Agent template writes; the split reads from it when present."
  type        = string
  default     = ""
}

variable "k8s_secret_prefix" {
  description = "strategy=k8s_secret: each service gets its own Secret named <prefix>-<service>."
  type        = string
  default     = "streampay-secrets"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,240}$", var.k8s_secret_prefix))
    error_message = "k8s_secret_prefix must be a lowercase DNS subdomain prefix."
  }
}

variable "k8s_secret_optional" {
  description = "When false, pods will not start until the Secret exists: fail fast on a missing funded extender key rather than run half-configured."
  type        = bool
  default     = false
}

variable "skip_missing" {
  description = "Tolerate a secret the source does not have (a webhook URL you have not wired yet). Funded keys should not be skipped: with false the script exits non-zero."
  type        = bool
  default     = true
}

variable "strict_names" {
  description = "Names that must be present or the fetch fails, regardless of skip_missing. The aws-ec2 stack puts the extender key here when the extender is enabled."
  type        = list(string)
  default     = []
}
