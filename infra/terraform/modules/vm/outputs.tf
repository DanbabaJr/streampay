output "bundle_dir" {
  description = "Directory holding the rendered bundle. Everything Terraform wrote for this host."
  value       = var.bundle_dir
}

output "bundle_files" {
  description = "Every rendered file in the bundle with its mode: path => mode. This is the inventory CI diffs against the manifest."
  value = {
    for path, f in local.bundle_files : path => f.mode
  }
}

output "manifest_json" {
  description = "Path, mode and sha256 of every bundle file. install.sh can verify what it is about to run."
  value       = local.bundle_files["manifest.json"].content
}

output "bundle_sha256" {
  description = "Hash of the whole bundle plus the image source digests. The bootstrap trigger; if it does not change, nothing re-runs."
  value       = local.bundle_sha256
}

output "compose_yaml" {
  description = "The rendered docker compose document. Hardened: cap_drop ALL, no-new-privileges, loopback-only published ports, log rotation."
  value       = local.compose_yaml
}

output "caddyfile" {
  description = "The rendered TLS listener config (absent when tls_mode=off)."
  value       = var.tls_mode == "off" ? null : local.caddyfile
}

output "tls_site_address" {
  description = "What the listener answers to: a DNS name, an IP-ish :port, or a bare :port when TLS is off."
  value       = local.site_address
}

output "systemd_units" {
  description = "Unit file names install.sh writes, including the extender timer when it is enabled."
  value = sort([
    for path in keys(local.systemd_bundle) : trimprefix(path, "systemd/")
  ])
}

output "install_script" {
  description = "The single script that turns a bare machine into an observing stack. Read it before you run it; that is the point of rendering it to disk."
  value       = local.install_script
}

output "secret_paths_by_service" {
  description = "Where each per-service 0600 env file lands on the host. Paths only -- the values are the secret provider's problem."
  value       = var.secrets.secret_paths_by_service
}

output "secrets_strategy" {
  description = "The delivery mechanism in effect, with the threat note that justifies it."
  value = {
    strategy     = var.secrets.strategy
    threat_notes = var.secrets.threat_notes
  }
}

output "bootstrap_applied" {
  description = "Id of the bootstrap run, or null when apply_locally=false and the bundle is only rendered. A non-null value means install.sh ran on this machine."
  value       = var.apply_locally ? try(null_resource.bootstrap[0].id, null) : null
}

output "next_command" {
  description = "What to run next, from the operator's own shell."
  value = var.apply_locally ? join(" ", [
    "systemctl status", "${var.project_name}-stack.service",
    "&&", "${local.compose_prefix} ps"
    ]) : join(" ", [
    "scp -r ${var.bundle_dir} host:${var.install_dir}",
    "&& ssh host sh ${var.install_dir}/install.sh"
  ])
}
