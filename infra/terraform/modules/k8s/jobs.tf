# The TTL extender: a CronJob, because `cli.js extend` is a one-shot command with
# no --watch loop. Running it as a Deployment would just sit idle between passes,
# and running it more than once at a time would double-fund the same stream.

locals {
  sentinel_data_mount = try([for svc in var.services : svc.data_volume.mount if svc.key == "sentinel"][0], null)

  extender_cronjob = var.extender.enabled ? {
    apiVersion = "batch/v1"
    kind       = "CronJob"
    metadata = {
      name        = var.extender.name
      namespace   = var.namespace
      labels      = merge(local.common_labels, { "app.kubernetes.io/component" = "sentinel-extender" })
      annotations = {}
    }
    spec = {
      schedule                   = var.extender_schedule
      concurrencyPolicy          = "Forbid"
      startingDeadlineSeconds    = 300
      successfulJobsHistoryLimit = var.history_limits.successful
      failedJobsHistoryLimit     = var.history_limits.failed
      suspend                    = false
      jobTemplate = {
        spec = {
          backoffLimit            = 1
          activeDeadlineSeconds   = 600
          ttlSecondsAfterFinished = 3600
          template = {
            metadata = {
              labels = merge(local.common_labels, {
                "app.kubernetes.io/component" = "sentinel-extender"
                "streampay.io/scrape"         = var.prometheus_scrape_pod_label
              })
              annotations = local.pod_annotations
            }
            spec = merge(
              {
                restartPolicy                = "Never"
                serviceAccountName           = local.service_account.metadata.name
                automountServiceAccountToken = false
                securityContext = {
                  runAsNonRoot        = true
                  runAsUser           = lookup(local.run_as_user_by_key, "sentinel", 1000)
                  runAsGroup          = lookup(local.run_as_user_by_key, "sentinel", 1000)
                  fsGroup             = lookup(local.run_as_user_by_key, "sentinel", 1000)
                  fsGroupChangePolicy = "OnRootMismatch"
                  seccompProfile      = { type = "RuntimeDefault" }
                }
                containers = [merge(
                  {
                    name            = "extender"
                    image           = var.extender.image
                    imagePullPolicy = var.image_pull_policy
                    command         = var.extender.command
                    env             = [for k in sort(keys(var.extender.env)) : { name = k, value = var.extender.env[k] }]
                    # The funded account key lives in the sentinel Secret and
                    # nowhere else, which is also why the extender is a separate
                    # workload: Grafana never sees it.
                    envFrom = try(var.secrets.k8s_env_from_by_service["sentinel"], [])
                    volumeMounts = concat(
                      local.sentinel_data_mount == null ? [] : [{ name = "state", mountPath = local.sentinel_data_mount }],
                      [{
                        name      = "config"
                        mountPath = "/etc/streampay"
                        readOnly  = true
                      }],
                      var.read_only_rootfs ? [{ name = "tmp", mountPath = "/tmp" }] : []
                    )
                    securityContext = merge(local.container_security_context, {
                      runAsNonRoot = true
                      runAsUser    = lookup(local.run_as_user_by_key, "sentinel", 1000)
                    })
                  },
                  length(var.extender.args) > 0 ? { args = var.extender.args } : {},
                  length(lookup(local.resources_for, "sentinel", {})) > 0 ? {
                    resources = lookup(local.resources_for, "sentinel", {})
                  } : {}
                )]
                volumes = concat(
                  local.sentinel_data_mount == null ? [] : [{
                    name                  = "state"
                    persistentVolumeClaim = { claimName = "sentinel-data" }
                  }],
                  [{
                    name = "config"
                    configMap = {
                      name        = "streampay-sentinel-config"
                      defaultMode = local.octal_modes["0644"]
                      items       = [{ key = "ttl-sentinel.config.json", path = "ttl-sentinel.config.json" }]
                    }
                  }],
                  var.read_only_rootfs ? [{ name = "tmp", emptyDir = { sizeLimit = "64Mi" } }] : []
                )
              },
              length(var.node_selector) > 0 ? { nodeSelector = var.node_selector } : {},
              length(var.image_pull_secrets) > 0 ? { imagePullSecrets = [for name in var.image_pull_secrets : { name = name }] } : {}
            )
          }
        }
      }
    }
  } : null
}
