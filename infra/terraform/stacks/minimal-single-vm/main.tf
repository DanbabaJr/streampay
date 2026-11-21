# Minimal single-VM stack: one machine, one `terraform apply`, no credentials.
#
# Renders the whole bundle (compose file, Caddyfile, systemd units, rendered
# Prometheus/Alertmanager/Grafana/sentinel config, the secret fetch script and
# install.sh) into bundle_dir and, with apply_locally=true, runs install.sh on
# the machine Terraform runs on. Nothing in here talks to a cloud API, which is
# why CI can apply it on every pull request.

locals {
  # Variable defaults cannot reference path.*, so the repo-relative defaults are
  # resolved here instead.
  bundle_dir      = coalesce(var.bundle_dir, "${path.root}/build")
  local_repo_root = coalesce(var.local_repo_root, abspath("${path.root}/../../../.."))

  # A funded key must never be silently absent: when the extender spends, its
  # secret becomes a hard requirement of the fetch.
  strict_secret_names = concat(
    var.strict_secret_names,
    var.extender_enabled && !var.extender_dry_run ? ["TTL_SENTINEL_EXTENDER_SECRET"] : []
  )
}

module "services" {
  source = "../../modules/services"

  chain = {
    network     = var.network
    contract_id = var.contract_id
    rpc_url     = var.rpc_url
    horizon_url = var.horizon_url
  }

  runtime = {
    indexer_poll_interval_ms         = var.indexer_poll_interval_ms
    indexer_start_ledger             = var.indexer_start_ledger
    indexer_rpc_fallbacks            = var.rpc_fallback_urls
    reconciler_enabled               = var.reconciler_enabled
    sentinel_enabled                 = var.sentinel_enabled
    sentinel_extender_enabled        = var.extender_enabled
    sentinel_extender_dry_run        = var.extender_dry_run
    sentinel_extender_threshold      = var.extender_threshold_ledgers
    sentinel_extender_to             = var.extender_to_ledgers
    sentinel_extender_monthly_budget = var.extender_monthly_budget_xlm
    prometheus_retention             = var.prometheus_retention
    alert_repeat_interval            = var.alert_repeat_interval
  }

  images          = var.images
  alert_receivers = var.alert_receivers
  metrics_targets = var.metrics_targets
}

# Names, never values: this module is handed the list of env vars each service
# needs and produces a fetch script + per-service 0600 file paths for whichever
# provider was chosen.
module "secrets" {
  source = "../../modules/secrets"

  strategy             = var.secrets_strategy
  service_secret_names = module.services.secret_env_names_by_service
  # modules/vm asserts that every secret path lives under config_dir, so the two
  # modules must be pointed at the same directory.
  install_dir     = var.config_dir
  operator_file   = var.operator_secret_file
  ssm_path_prefix = var.ssm_path_prefix
  ssm_region      = var.ssm_region
  vault_mount     = var.vault_mount
  strict_names    = local.strict_secret_names
}

module "vm" {
  source = "../../modules/vm"

  services             = module.services.all_services
  extender             = module.services.extender
  chain                = module.services.chain
  sentinel_config_json = module.services.sentinel_config_json

  config_files = {
    "prometheus.yml"            = module.services.prometheus_yaml
    "prometheus-rules.yml"      = module.services.prometheus_rules_yaml
    "alertmanager-template.yml" = module.services.alertmanager_template_yaml
    "alertmanager-rewrite.sh"   = module.services.alertmanager_rewrite_script
    "grafana-datasource.yml"    = module.services.grafana_datasource_yaml
    "grafana-provider.yml"      = module.services.grafana_dashboard_provider_yaml
    "grafana-dashboard.json"    = module.services.grafana_dashboard_json
  }

  secrets = module.secrets

  bundle_dir       = local.bundle_dir
  install_dir      = var.install_dir
  config_dir       = var.config_dir
  repo_root        = var.repo_root
  build_local      = var.build_local
  skip_image_build = var.skip_image_build
  caddy_image      = var.images.caddy

  project_name         = "streampay"
  admin_bind_address   = var.admin_bind_address
  grafana_host_port    = var.grafana_host_port
  prometheus_host_port = var.prometheus_host_port
  indexer_host_port    = var.indexer_host_port
  expose_indexer_api   = var.expose_indexer_api

  tls_mode      = var.tls_mode
  tls_domain    = var.tls_domain
  tls_email     = var.tls_email
  tls_cert_file = var.tls_cert_file
  tls_key_file  = var.tls_key_file

  read_only_rootfs     = var.read_only_rootfs
  log_max_size         = var.log_max_size
  extender_schedule    = var.extender_schedule
  apply_locally        = var.apply_locally
  bootstrap_command    = var.bootstrap_command
  additional_notes     = var.additional_notes
  set_file_permissions = var.set_file_permissions

  # Build contexts are relative to the checkout on the target host; the digests
  # are read from the checkout Terraform runs in. Different machines, same repo.
  image_builds = [
    {
      key        = "indexer"
      image      = var.images.indexer
      context    = "indexer"
      dockerfile = "infra/docker/Dockerfile.indexer"
    },
    {
      key        = "reconciler"
      image      = var.images.reconciler
      context    = "reconciler"
      dockerfile = "infra/docker/Dockerfile.reconciler"
    },
    {
      key        = "sentinel"
      image      = var.images.sentinel
      context    = "infra/ttl-sentinel"
      dockerfile = "infra/docker/Dockerfile.ttl-sentinel"
    }
  ]

  image_build_digests = var.build_local ? {
    indexer    = filesha256("${local.local_repo_root}/infra/docker/Dockerfile.indexer")
    reconciler = filesha256("${local.local_repo_root}/infra/docker/Dockerfile.reconciler")
    sentinel   = filesha256("${local.local_repo_root}/infra/docker/Dockerfile.ttl-sentinel")
  } : {}
}
