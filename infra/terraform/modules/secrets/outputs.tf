output "strategy" {
  description = "The selected delivery mechanism."
  value       = var.strategy
}

output "secret_paths_by_service" {
  description = "Host path of the 0600 env file each service reads. Only services that need secrets have an entry."
  value       = { for k, p in local.secret_path : k => p if length(var.service_secret_names[k]) > 0 }
}

output "fetch_script" {
  description = "POSIX sh that produces the secret files (or audits the operator file). Contains no secret values."
  value       = local.fetch_script
}

output "vault_agent_config" {
  description = "Vault Agent config, only meaningful for strategy=vault. Paths and key names, no tokens."
  value       = var.strategy == "vault" ? join("\n", local.vault_agent_lines) : null
}

output "secret_names" {
  description = "Every env var name the stack expects, deduplicated."
  value       = local.all_names
}

output "k8s_secret_names_by_service" {
  description = "Per-service Kubernetes Secret names referenced by envFrom."
  value       = local.k8s_secret_by_service
}

output "k8s_env_from_by_service" {
  description = "envFrom blocks per service: references only, the Secret itself is created out of band."
  value = {
    for k in local.service_keys : k => length(var.service_secret_names[k]) > 0 ? [{
      secretRef = {
        name     = local.k8s_secret_by_service[k]
        optional = var.k8s_secret_optional
      }
    }] : []
  }
}

output "k8s_secret_bootstrap_commands" {
  description = "One-time, out-of-band commands that create those Secrets from a shell which already holds the values."
  value       = local.k8s_create_commands
}

output "threat_notes" {
  description = "Why each provider was chosen or rejected; rendered into the bundle README so the policy travels with the infra."
  value       = local.threat_notes
}
