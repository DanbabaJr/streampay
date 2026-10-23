# Kubernetes stack: the org-facing path.
#
# Same three modules as the single-VM path, with modules/vm replaced by
# modules/k8s. Nothing here contacts a cluster: the deliverable is manifests.yaml
# plus its README, and Terraform's only side effect on the machine is writing
# those two files. That is what makes "plan after apply is empty" trivially true
# for this stack, and what lets CI render it on every pull request with no
# kubeconfig. Apply it with `kubectl apply -f`, Argo CD, or
# -var apply_with_kubectl=true if you want Terraform to do it.

locals {
  manifest_dir  = coalesce(var.manifest_dir, "${path.root}/build")
  manifest_path = "${local.manifest_dir}/manifests.yaml"

  # Cluster DNS names as modules/services renders them, so the outputs tell you
  # to port-forward the Service that actually exists.
  grafana_service_name = [for s in module.services.all_services : s.name if s.key == "grafana"][0]
  indexer_service_name = [for s in module.services.all_services : s.name if s.key == "indexer"][0]
  prometheus_name      = [for s in module.services.all_services : s.name if s.key == "prometheus"][0]

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

# Names, never values. On this path the Secret objects themselves are created
# out of band by kubectl (or external-secrets); the module only produces the
# names, the envFrom wiring and the one-time bootstrap commands.
module "secrets" {
  source = "../../modules/secrets"

  strategy             = "k8s_secret"
  service_secret_names = module.services.secret_env_names_by_service
  k8s_secret_prefix    = var.k8s_secret_prefix
  k8s_secret_optional  = var.k8s_secret_optional
  strict_names         = local.strict_secret_names
}

module "k8s" {
  source = "../../modules/k8s"

  namespace = var.namespace
  services  = module.services.all_services
  extender  = module.services.extender
  chain     = module.services.chain

  config_files = {
    "prometheus.yml"            = module.services.prometheus_yaml
    "prometheus-rules.yml"      = module.services.prometheus_rules_yaml
    "alertmanager-template.yml" = module.services.alertmanager_template_yaml
    "alertmanager-rewrite.sh"   = module.services.alertmanager_rewrite_script
    "grafana-datasource.yml"    = module.services.grafana_datasource_yaml
    "grafana-provider.yml"      = module.services.grafana_dashboard_provider_yaml
    "grafana-dashboard.json"    = module.services.grafana_dashboard_json
  }

  sentinel_config_json = module.services.sentinel_config_json
  secrets              = module.secrets

  storage_class_name = var.storage_class_name
  storage_requests   = var.storage_requests
  resources          = var.resources

  image_pull_secrets = var.image_pull_secrets
  image_pull_policy  = var.image_pull_policy

  ingress_class_name                 = var.ingress_class_name
  ingress_host                       = var.ingress_host
  ingress_tls_mode                   = var.ingress_tls_mode
  ingress_tls_secret                 = var.ingress_tls_secret
  cert_manager_cluster_issuer        = var.cert_manager_cluster_issuer
  ingress_tls_is_namespaced_issuer   = var.ingress_tls_is_namespaced_issuer
  ingress_annotations                = var.ingress_annotations
  ingress_controller_namespace_label = var.ingress_controller_namespace_label
  expose_indexer_api                 = var.expose_indexer_api

  extender_schedule        = var.extender_schedule
  read_only_rootfs         = var.read_only_rootfs
  run_as_user              = var.run_as_user
  node_selector            = var.node_selector
  skip_namespaced_manifest = var.skip_namespaced_manifest
  additional_notes         = var.additional_notes
}

# The deliverable: a single ordered stream, applied with one command and
# re-applied as often as you like.
resource "local_file" "manifests" {
  filename             = local.manifest_path
  content              = module.k8s.manifests_yaml
  file_permission      = "0644"
  directory_permission = "0755"
}

resource "local_file" "readme" {
  filename             = "${local.manifest_dir}/README.md"
  content              = module.k8s.apply_readme
  file_permission      = "0644"
  directory_permission = "0755"
}

# Opt-in apply. The trigger is the checksum of the rendered documents, so a
# re-apply runs kubectl only when a manifest actually changed, and kubectl
# itself is idempotent: Terraform never reads cluster state back, which is why
# the plan after this apply stays empty.
resource "null_resource" "apply" {
  count = var.apply_with_kubectl ? 1 : 0

  triggers = {
    manifest_checksum = module.k8s.manifest_checksum
    namespace         = var.namespace
  }

  provisioner "local-exec" {
    # Quoted because path.root is your checkout, and checkouts live under paths
    # with spaces. The /bin/sh interpreter is why this is the opt-in branch: a
    # Windows laptop is a rendering machine, not the thing that talks to prod.
    command     = "${join(" ", var.kubectl_command)} \"${local.manifest_path}\""
    interpreter = ["/bin/sh", "-c"]
  }

  depends_on = [local_file.manifests, local_file.readme]
}
