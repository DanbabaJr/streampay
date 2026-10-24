# Monitoring configuration: Prometheus scrape + rules, Alertmanager routing,
# Grafana provisioning. Rendered once here and placed by both platform modules,
# so a threshold edit cannot land on one deployment path and not the other.

locals {
  # Workload scrape jobs are derived from what actually serves /metrics. The
  # canonical reconciler and the sentinel are poll loops with no HTTP listener,
  # so they are filtered out here rather than shipped as permanently DOWN
  # targets; the `infra/reconciler` variant (which does serve metrics) or any
  # node exporter is added through var.metrics_targets.
  workload_scrape_jobs = [
    for svc in local.workload_services : {
      job_name       = "streampay-${svc.key}"
      metrics_path   = svc.metrics_path
      static_configs = [{ targets = ["${svc.name}:${svc.ports[0].container}"] }]
      labels         = { service = svc.key }
    }
    if svc.metrics_path != null
  ]

  monitoring_scrape_jobs = [
    {
      job_name       = "prometheus"
      static_configs = [{ targets = ["${var.namespace_prefix}-prometheus:9090"] }]
    },
    {
      job_name       = "alertmanager"
      static_configs = [{ targets = ["${var.namespace_prefix}-alertmanager:9093"] }]
    }
  ]

  extra_scrape_jobs = [
    for job, target in var.metrics_targets : {
      job_name       = job
      metrics_path   = "/metrics"
      static_configs = [{ targets = [target] }]
    }
  ]

  scrape_jobs = concat(
    local.workload_scrape_jobs,
    local.monitoring_scrape_jobs,
    local.extra_scrape_jobs,
  )

  prometheus_config = {
    global = {
      scrape_interval     = var.runtime.scrape_interval
      evaluation_interval = var.runtime.evaluation_interval
      external_labels = {
        project     = "streampay"
        environment = local.chain.network
      }
    }
    rule_files = ["/etc/prometheus/rules/*.yml"]
    alerting = {
      alertmanagers = [{
        static_configs = [{ targets = ["${var.namespace_prefix}-alertmanager:9093"] }]
      }]
    }
    scrape_configs = local.scrape_jobs
  }

  prometheus_yaml = yamlencode(local.prometheus_config)

  # Alert rules come straight from the repo so thresholds stay the single source
  # of truth shared with docs/RUNBOOK.md and the soak-test justifications
  # recorded in that file (issue #27).
  prometheus_rules_yaml = file("${path.module}/../../../observability/prometheus/rules/alerts.yml")

  grafana_datasource_yaml = yamlencode({
    apiVersion = "1"
    datasources = [{
      name      = "Prometheus"
      type      = "prometheus"
      access    = "proxy"
      url       = "http://${var.namespace_prefix}-prometheus:9090"
      isDefault = true
      editable  = false
      jsonData = {
        timeInterval = var.runtime.scrape_interval
        httpMethod   = "POST"
      }
    }]
  })

  grafana_dashboard_provider_yaml = yamlencode({
    apiVersion = "1"
    providers = [{
      name                  = "StreamPay Dashboards"
      orgId                 = "1"
      folder                = "StreamPay"
      type                  = "file"
      disableDeletion       = false
      updateIntervalSeconds = "10"
      allowUiUpdates        = true
      options = {
        path = "/etc/grafana/dashboards"
      }
    }]
  })

  grafana_dashboard_json = file("${path.module}/../../../observability/grafana/dashboards/streampay-overview.json")

  # A receiver webhook URL is a credential: whoever holds it can post into your
  # pager channel. So the routing file that lands in git/state carries a token
  # per receiver, and the container substitutes the real URL from its own
  # environment at start-up. awk string concatenation (not sed/gsub) is used
  # because the injected URL may contain `&`, `/`, `#` or `%`.
  # Optional object attributes arrive as null, and null interpolates badly into
  # YAML and into shell. Normalise once, here, instead of guarding every use.
  receivers = [
    for r in var.alert_receivers : {
      name           = r.name
      match_severity = r.match_severity == null ? "" : r.match_severity
      secret_env     = r.secret_env == null ? "" : r.secret_env
      static_url     = r.static_url == null ? "" : r.static_url
    }
  ]

  alertmanager_tokens = {
    for r in local.receivers :
    "@@${r.name}@@" => r.secret_env
  }

  alertmanager_substitutions = join("\n", [
    for r in local.receivers :
    "  tok[${index(keys(local.alertmanager_tokens), "@@${r.name}@@") + 1}]=\"@@${r.name}@@\"; env[${index(keys(local.alertmanager_tokens), "@@${r.name}@@") + 1}]=\"${r.secret_env}\""
  ])

  alertmanager_receivers = [
    for r in local.receivers : {
      name = r.name
      webhook_configs = [{
        url           = r.static_url != "" ? r.static_url : "@@${r.name}@@"
        send_resolved = true
      }]
    }
  ]

  alertmanager_routes = [
    for r in local.receivers : {
      receiver        = r.name
      match           = { severity = r.match_severity }
      group_by        = ["alertname", "service", "severity"]
      repeat_interval = r.match_severity == "critical" ? "30m" : var.runtime.alert_repeat_interval
    }
    if r.match_severity != ""
  ]

  alertmanager_config = {
    global = { resolve_timeout = "5m" }
    route = {
      receiver        = length(var.alert_receivers) > 0 ? var.alert_receivers[0].name : "default-webhook"
      group_by        = ["alertname", "service", "severity"]
      group_wait      = "10s"
      group_interval  = "1m"
      repeat_interval = var.runtime.alert_repeat_interval
      routes          = local.alertmanager_routes
    }
    receivers = local.alertmanager_receivers
    inhibit_rules = [{
      source_match = { severity = "critical" }
      target_match = { severity = "warning" }
      equal        = ["service", "component"]
    }]
  }

  alertmanager_template_yaml = yamlencode(local.alertmanager_config)

  # Emitted as a script so the same substitution runs in the compose bootstrap
  # and in a Kubernetes initContainer. `STREAMPAY_ALERT_SINK_FALLBACK` keeps the
  # stack bootable when an operator has not wired a sink yet: alerts still fire
  # and land in the JSON log instead of failing the container at start.
  alertmanager_rewrite_script = <<-SH
    #!/bin/sh
    set -eu

    SRC="$${ALERTMANAGER_TEMPLATE:-/etc/alertmanager/template/alertmanager.yml}"
    DST="$${ALERTMANAGER_CONFIG:-/etc/alertmanager/alertmanager.yml}"

    awk '
    BEGIN {
      n = ${length(local.alertmanager_tokens)}
    ${local.alertmanager_substitutions}
      for (i = 1; i <= n; i++) {
        val = ENVIRON[env[i]]
        if (val == "") val = ENVIRON["STREAMPAY_ALERT_SINK_FALLBACK"]
        if (val == "") val = "http://127.0.0.1:5001/alerts"
        map[tok[i]] = val
      }
    }
    {
      line = $0
      for (t in map) {
        p = index(line, t)
        if (p > 0) {
          line = substr(line, 1, p - 1) map[t] substr(line, p + length(t))
        }
      }
      print line
    }' "$SRC" > "$DST"
    chmod 600 "$DST"
    SH
}
