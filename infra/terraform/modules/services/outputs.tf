output "chain" {
  description = "Normalized network endpoints and contract id the stack observes."
  value       = local.chain
}

output "runtime" {
  description = "Merged runtime tuning after defaults."
  value       = var.runtime
}

output "workload_services" {
  description = "The indexer / reconciler / sentinel workload definitions the platform modules place."
  value       = local.workload_services
}

output "monitoring_services" {
  description = "Prometheus / Alertmanager / Grafana definitions."
  value       = local.monitoring_services
}

output "all_services" {
  description = "Every long-running container in the stack."
  value       = local.all_services
}

output "extender" {
  description = "One-shot TTL extender definition; only scheduled when enabled."
  value       = local.extender
}

output "indexer_env" {
  description = "Plain (non-secret) environment for the indexer."
  value       = local.indexer_env
}

output "sentinel_config_json" {
  description = "TTL-sentinel JSON config file content (no secrets in it)."
  value       = local.sentinel_config_json
}

output "prometheus_yaml" {
  description = "Prometheus configuration file content."
  value       = local.prometheus_yaml
}

output "prometheus_rules_yaml" {
  description = "StreamPay alert rules, copied from infra/observability."
  value       = local.prometheus_rules_yaml
}

output "alertmanager_template_yaml" {
  description = "Alertmanager routing with receiver URLs left as @@name@@ tokens."
  value       = local.alertmanager_template_yaml
}

output "alertmanager_rewrite_script" {
  description = "POSIX sh that substitutes receiver webhook URLs from the environment at start."
  value       = local.alertmanager_rewrite_script
}

output "grafana_datasource_yaml" {
  description = "Grafana Prometheus datasource provisioning file."
  value       = local.grafana_datasource_yaml
}

output "grafana_dashboard_provider_yaml" {
  description = "Grafana dashboard provider provisioning file."
  value       = local.grafana_dashboard_provider_yaml
}

output "grafana_dashboard_json" {
  description = "StreamPay overview dashboard, copied from infra/observability."
  value       = local.grafana_dashboard_json
}

output "grafana_env" {
  description = "Grafana plain environment (admin credentials are injected by reference)."
  value       = local.grafana_env
}

output "secret_env_names_by_service" {
  description = "Per service, the env var names whose values the platform must inject. Values are never rendered by Terraform."
  value       = var.container_env_passthrough
}

output "data_paths" {
  description = "Container-side paths that must sit on persistent storage."
  value = {
    indexer_dir       = local.indexer_data_dir
    indexer_db        = var.runtime.indexer_database_path
    sentinel_dir      = local.sentinel_data_dir
    sentinel_state    = var.runtime.sentinel_state_path
    sentinel_config   = "/etc/streampay/ttl-sentinel.config.json"
    prometheus_tsdb   = "/prometheus"
    alertmanager_silo = "/alertmanager"
    grafana_data      = "/var/lib/grafana"
  }
}

output "container_ports" {
  description = "Container-side listen ports, keyed by service name."
  value = {
    for svc in local.all_services :
    svc.name => length(svc.ports) > 0 ? svc.ports[0].container : null
  }
}
