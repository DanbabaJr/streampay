output "bundle_dir" {
  description = "Where the bundle landed. Everything the host needs is in here; nothing in it contains a secret value."
  value       = module.vm.bundle_dir
}

output "bundle_files" {
  description = "Rendered bundle inventory: relative path => file mode."
  value       = module.vm.bundle_files
}

output "images" {
  description = "Container images the stack will use. The three StreamPay ones are built from this repo when build_local=true."
  value = {
    indexer      = var.images.indexer
    reconciler   = var.images.reconciler
    sentinel     = var.images.sentinel
    prometheus   = var.images.prometheus
    alertmanager = var.images.alertmanager
    grafana      = var.images.grafana
    caddy        = var.images.caddy
  }
}

output "secrets" {
  description = "The delivery mechanism, the env var names it must supply, and where each service's 0600 file will be written."
  value = {
    strategy         = var.secrets_strategy
    names            = module.secrets.secret_names
    paths_by_service = module.vm.secret_paths_by_service
    fetch_script     = "${module.vm.bundle_dir}/fetch-secrets.sh"
    threat_notes     = module.secrets.threat_notes
  }
}

output "tls" {
  description = "Listener mode and the address it serves."
  value = {
    mode         = var.tls_mode
    site_address = module.vm.tls_site_address
    domain       = var.tls_domain
  }
}

output "endpoints" {
  description = "Host-side sockets that are actually listening, so you know what to curl."
  value = {
    grafana    = var.grafana_host_port > 0 ? "http://${var.admin_bind_address}:${var.grafana_host_port}" : null
    prometheus = var.prometheus_host_port > 0 ? "http://${var.admin_bind_address}:${var.prometheus_host_port}" : null
    indexer    = var.indexer_host_port > 0 ? "http://${var.admin_bind_address}:${var.indexer_host_port}" : null
    public     = var.tls_mode == "off" ? null : "https://${module.vm.tls_site_address}"
  }
}

output "next_command" {
  description = "The single command that finishes the job from this machine."
  value       = module.vm.next_command
}

output "verify" {
  description = "Commands that prove the stack is observing rather than merely running. The Prometheus query is the shortest path to 'is the indexer following the chain'."
  value = join("\n", concat(
    [
      "docker compose -f ${var.install_dir}/docker-compose.yml ps",
      "systemctl list-units --all 'streampay-*'"
    ],
    var.prometheus_host_port > 0 ? [
      "curl -s 'http://${var.admin_bind_address}:${var.prometheus_host_port}/api/v1/query?query=streampay_outbox_lag_seconds' | head -c 300"
      ] : [
      "# prometheus_host_port=0: curl through Grafana, or ssh -L 9090:127.0.0.1:9090 first."
    ]
  ))
}
