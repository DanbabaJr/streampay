# The three modules, wired exactly as in stacks/minimal-single-vm. The only
# differences are apply_locally=false (the machine that runs Terraform is not the
# machine that runs the stack) and the bundle transport.

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

module "secrets" {
  source = "../../modules/secrets"

  strategy             = var.secrets_strategy
  service_secret_names = module.services.secret_env_names_by_service
  # The bundle asserts the paths of the files it writes, so both modules have to
  # be pointed at the same host directory.
  install_dir     = var.config_dir
  operator_file   = var.operator_secret_file
  ssm_path_prefix = local.ssm_path_prefix
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

  bundle_dir  = local.bundle_dir
  install_dir = var.install_dir
  config_dir  = var.config_dir
  # The data root is where the EBS volume gets mounted, so the bind mounts under
  # it land on the durable volume rather than the root disk.
  host_data_root = var.data_root
  host_log_root  = "/var/log/streampay"
  repo_root      = var.build_local ? "/opt/streampay/src" : var.install_dir

  build_local      = var.build_local
  skip_image_build = false
  caddy_image      = var.images.caddy

  project_name       = "streampay"
  admin_bind_address = "127.0.0.1"
  # Deliberately not published on 0.0.0.0: this host has an Elastic IP. Grafana is
  # reached through the TLS listener or an ssh -L, and Prometheus stays off the
  # host unless you ask for it.
  grafana_host_port    = var.grafana_host_port
  prometheus_host_port = var.prometheus_host_port
  indexer_host_port    = var.indexer_host_port
  expose_indexer_api   = var.expose_indexer_api

  tls_mode      = var.tls_mode
  tls_domain    = var.tls_domain
  tls_email     = var.tls_email
  tls_cert_file = var.tls_cert_file
  tls_key_file  = var.tls_key_file

  read_only_rootfs  = var.read_only_rootfs
  log_max_size      = var.log_max_size
  extender_schedule = var.extender_schedule

  # Terraform does not ssh in and run anything: cloud-init does, with the same
  # script, from the same bundle. That keeps `terraform apply` idempotent without
  # a remote-exec credential sitting in state.
  apply_locally     = false
  bootstrap_command = null

  additional_notes = var.additional_notes

  image_builds = var.build_local ? [
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
  ] : []

  # Editing a Dockerfile must re-run the install, and the only place the
  # Dockerfiles are guaranteed to be is the checkout Terraform runs from.
  image_build_digests = var.build_local ? {
    indexer    = filesha256("${local.checkout_root}/infra/docker/Dockerfile.indexer")
    reconciler = filesha256("${local.checkout_root}/infra/docker/Dockerfile.reconciler")
    sentinel   = filesha256("${local.checkout_root}/infra/docker/Dockerfile.ttl-sentinel")
  } : {}
}
