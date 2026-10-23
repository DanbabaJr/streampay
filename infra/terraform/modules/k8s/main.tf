# Kubernetes manifests for the StreamPay stack.
#
# This module renders manifest *documents*; it does not talk to a cluster. That is
# deliberate: `terraform validate` and CI work with no kubeconfig and no
# credentials, and the operator keeps the choice between `kubectl apply -f`,
# Argo CD, or whatever their platform team mandates. Because nothing is read back
# from a live cluster, plan/apply drift is purely a function of the rendered
# documents -- see docs/DEPLOYMENT.md.

locals {
  name_prefix = "streampay"

  common_labels = {
    "app.kubernetes.io/name"       = local.name_prefix
    "app.kubernetes.io/part-of"    = local.name_prefix
    "app.kubernetes.io/managed-by" = "terraform"
    "app.kubernetes.io/instance"   = var.namespace
  }

  labels_for = {
    for svc in var.services : svc.key => merge(local.common_labels, {
      "app.kubernetes.io/component" = svc.key
      "streampay.io/scrape"         = var.prometheus_scrape_pod_label
    })
  }

  # Every mounted config file is content-hashed into the pod template, so
  # changing a Prometheus rule or an alert receiver restarts the pod that reads
  # it. Without this the config map updates and the process keeps the old copy
  # until something else restarts it, which is the classic "I edited the rules
  # and nothing happened" report.
  config_checksums = {
    for k, v in var.config_files : k => substr(sha256(v), 0, 16)
  }

  pod_annotations = merge(
    {
      "streampay.io/config-checksum" = substr(sha256(join("|", [
        for k in sort(keys(var.config_files)) : "${k}:${local.config_checksums[k]}"
      ])), 0, 16),
      "streampay.io/sentinel-config-checksum" = substr(sha256(var.sentinel_config_json), 0, 16)
    },
    var.pod_annotations
  )

  # ---------------------------------------------------------------------------
  # ConfigMaps: one per mount directory, because a volume mounts a directory and
  # the two Grafana files have to land in the same one.
  # ---------------------------------------------------------------------------
  configmaps = concat(
    [
      {
        name = "streampay-prometheus-config"
        data = {
          "prometheus.yml" = var.config_files["prometheus.yml"]
        }
        mode = "0644"
      },
      {
        name = "streampay-prometheus-rules"
        data = {
          "streampay-alerts.yml" = var.config_files["prometheus-rules.yml"]
        }
        mode = "0644"
      },
      {
        # Mount point is /etc/alertmanager/template, so the key has to be the
        # file name the rewrite script reads.
        name = "streampay-alertmanager-template"
        data = {
          "alertmanager.yml" = var.config_files["alertmanager-template.yml"]
        }
        mode = "0644"
      },
      {
        name = "streampay-alertmanager-rewrite"
        data = {
          "alertmanager-rewrite.sh" = var.config_files["alertmanager-rewrite.sh"]
        }
        mode = "0755"
      },
      {
        name = "streampay-grafana-datasources"
        data = {
          "datasource.yml" = var.config_files["grafana-datasource.yml"]
        }
        mode = "0644"
      },
      {
        # The dashboard JSON sits next to its provider file in the official
        # image layout, so both share one ConfigMap and one volume.
        name = "streampay-grafana-dashboards"
        data = {
          "provider.yml"            = var.config_files["grafana-provider.yml"]
          "streampay-overview.json" = var.config_files["grafana-dashboard.json"]
        }
        mode = "0644"
      },
      {
        name = "streampay-sentinel-config"
        data = {
          "ttl-sentinel.config.json" = var.sentinel_config_json
        }
        mode = "0644"
      }
    ],
    []
  )

  configmap_names = { for cm in local.configmaps : cm.name => cm }

  # File modes as the decimal integers Kubernetes expects for them.
  octal_modes = {
    "0400" = 256
    "0444" = 292
    "0600" = 384
    "0640" = 416
    "0644" = 420
    "0700" = 448
    "0755" = 493
  }

  # The projection for one ConfigMap-backed mount: every key lands as a file of
  # the same name, under the mode that ConfigMap declares. Keys are sorted so the
  # rendered document is byte-stable.
  configmap_projections = {
    for cm in local.configmaps : cm.name => {
      name        = cm.name
      defaultMode = lookup(local.octal_modes, cm.mode, 420)
      items       = [for k in sort(keys(cm.data)) : { key = k, path = k }]
      optional    = false
    }
  }

  # Per-service volumes: mount point, read-only flag, and the complete Kubernetes
  # volume object. Writing the source out per entry instead of computing
  # `configmap == null ? {emptyDir=...} : {configMap=...}` is deliberate: an HCL
  # conditional whose branches have different attribute names is a type error,
  # and the manifest a reviewer reads should be the manifest that ships.
  config_volumes_by_key = {
    indexer    = []
    reconciler = []
    sentinel = [
      {
        name     = "sentinel-config"
        mount    = "/etc/streampay"
        readonly = true
        volume = {
          name      = "sentinel-config"
          configMap = local.configmap_projections["streampay-sentinel-config"]
        }
      }
    ]
    alertmanager = [
      {
        # /etc/alertmanager itself must be writable: the entrypoint renders the
        # real config into it at start-up. An emptyDir gives it a writable
        # directory while the root filesystem stays read-only.
        name     = "alertmanager-config"
        mount    = "/etc/alertmanager"
        readonly = false
        volume = {
          name     = "alertmanager-config"
          emptyDir = {}
        }
      },
      {
        name     = "alertmanager-template"
        mount    = "/etc/alertmanager/template"
        readonly = true
        volume = {
          name      = "alertmanager-template"
          configMap = local.configmap_projections["streampay-alertmanager-template"]
        }
      },
      {
        # 0755 on that ConfigMap: the entrypoint exec's this script.
        name     = "alertmanager-rewrite"
        mount    = "/etc/streampay"
        readonly = true
        volume = {
          name      = "alertmanager-rewrite"
          configMap = local.configmap_projections["streampay-alertmanager-rewrite"]
        }
      }
    ]
    prometheus = [
      {
        name     = "prometheus-config"
        mount    = "/etc/prometheus"
        readonly = true
        volume = {
          name      = "prometheus-config"
          configMap = local.configmap_projections["streampay-prometheus-config"]
        }
      },
      {
        name     = "prometheus-rules"
        mount    = "/etc/prometheus/rules"
        readonly = true
        volume = {
          name      = "prometheus-rules"
          configMap = local.configmap_projections["streampay-prometheus-rules"]
        }
      }
    ]
    grafana = [
      {
        name     = "grafana-datasources"
        mount    = "/etc/grafana/provisioning/datasources"
        readonly = true
        volume = {
          name      = "grafana-datasources"
          configMap = local.configmap_projections["streampay-grafana-datasources"]
        }
      },
      {
        # The dashboard JSON sits next to its provider file in the official image
        # layout, so both share one ConfigMap and one volume.
        name     = "grafana-dashboards"
        mount    = "/etc/grafana/provisioning/dashboards"
        readonly = true
        volume = {
          name      = "grafana-dashboards"
          configMap = local.configmap_projections["streampay-grafana-dashboards"]
        }
      }
    ]
  }

  pvcs = [
    for svc in var.services : {
      name       = "${svc.key}-data"
      key        = svc.key
      mount      = svc.data_volume.mount
      access     = var.access_modes
      size       = lookup(var.storage_requests, svc.key, "5Gi")
      class_name = var.storage_class_name
    }
    if svc.data_volume != null
  ]

  service_account = {
    apiVersion = "v1"
    kind       = "ServiceAccount"
    metadata = {
      name        = "${local.name_prefix}-stack"
      namespace   = var.namespace
      labels      = local.common_labels
      annotations = {}
    }
    # Nothing in this stack talks to the Kubernetes API. Automounted tokens are
    # a standing credential inside every container, so they are turned off.
    automountServiceAccountToken = false
  }
}

resource "terraform_data" "preflight" {
  input = {
    namespace = var.namespace
    tls_mode  = var.ingress_tls_mode
    strategy  = var.secrets.strategy
  }

  lifecycle {
    precondition {
      condition     = var.secrets.strategy == "k8s_secret"
      error_message = "modules/k8s expects secrets strategy k8s_secret: the pod reads its credentials through envFrom, not from a host file."
    }

    precondition {
      condition     = var.ingress_tls_mode != "cert-manager" || var.cert_manager_cluster_issuer != ""
      error_message = "ingress_tls_mode=cert-manager needs cert_manager_cluster_issuer: without the issuer annotation cert-manager ignores the Ingress and no certificate is ever issued."
    }

    precondition {
      condition     = var.ingress_tls_mode != "existing-secret" || var.ingress_tls_secret != ""
      error_message = "ingress_tls_mode=existing-secret needs ingress_tls_secret naming the tls Secret you already created."
    }

    # A Prometheus rule file is only useful if the scrape config points at it.
    precondition {
      condition     = length(var.config_files) >= 7
      error_message = "config_files is missing rendered documents; pass every output of modules/services that starts with prometheus_, alertmanager_, grafana_ plus the sentinel config."
    }

    precondition {
      condition     = alltrue([for mode in var.access_modes : mode != "ReadWriteMany"])
      error_message = "ReadWriteMany is refused on purpose: the indexer stores its ledger in SQLite (WAL), which corrupts on a shared filesystem."
    }
  }
}
