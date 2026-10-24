# Deployments: one per long-running container in the stack.

locals {
  # The three StreamPay images run as the unprivileged uid they were built with;
  # the monitoring images ship their own (prometheus/alertmanager: nobody 65534,
  # grafana: 472). Pinning the wrong uid is the usual cause of a PVC that mounts
  # read-write and still reports permission denied.
  run_as_user_by_key = merge({
    indexer      = 1000
    reconciler   = 1000
    sentinel     = 1000
    prometheus   = 65534
    alertmanager = 65534
    grafana      = 472
  }, var.run_as_user)

  container_security_context = {
    allowPrivilegeEscalation = false
    readOnlyRootFilesystem   = var.read_only_rootfs
    capabilities             = { drop = ["ALL"] }
    seccompProfile           = { type = "RuntimeDefault" }
    runAsNonRoot             = true
  }

  volume_mounts_for = {
    for svc in var.services : svc.key => concat(
      svc.data_volume == null ? [] : [{
        name      = "data"
        mountPath = svc.data_volume.mount
      }],
      svc.log_volume ? [{
        name      = "logs"
        mountPath = "/var/log/streampay"
      }] : [],
      [
        for v in try(local.config_volumes_by_key[svc.key], []) : {
          name      = v.name
          mountPath = v.mount
          readOnly  = v.readonly
        }
      ],
      var.read_only_rootfs ? [{ name = "tmp", mountPath = "/tmp" }] : []
    )
  }

  volumes_for = {
    for svc in var.services : svc.key => concat(
      svc.data_volume == null ? [] : [{
        name = "data"
        persistentVolumeClaim = {
          claimName = "${svc.key}-data"
        }
      }],
      svc.log_volume ? [{
        name     = "logs"
        emptyDir = { sizeLimit = "1Gi" }
      }] : [],
      [
        for v in try(local.config_volumes_by_key[svc.key], []) : v.volume
      ],
      var.read_only_rootfs ? [{ name = "tmp", emptyDir = { sizeLimit = "256Mi" } }] : []
    )
  }

  probes_for = {
    for svc in var.services : svc.key => (
      svc.health_path != null && length(svc.ports) > 0 ? {
        readiness = {
          httpGet = {
            path   = svc.health_path
            port   = svc.ports[0].container
            scheme = "HTTP"
          }
          # The indexer opens its SQLite file and replays from a stored cursor on
          # boot; a 10-second failure threshold there just hides the pod.
          initialDelaySeconds = svc.key == "indexer" ? 20 : 10
          periodSeconds       = 15
          timeoutSeconds      = 3
          failureThreshold    = 8
        }
        liveness = {
          httpGet = {
            path   = svc.health_path
            port   = svc.ports[0].container
            scheme = "HTTP"
          }
          initialDelaySeconds = 60
          periodSeconds       = 20
          timeoutSeconds      = 5
          failureThreshold    = 6
        }
      } : { readiness = null, liveness = null }
    )
  }

  resources_for = {
    for svc in var.services : svc.key => merge(
      try(var.resources[svc.key], null) == null ? {} : {
        requests = merge(
          try(var.resources[svc.key].requests_cpu, null) != null ? { cpu = var.resources[svc.key].requests_cpu } : {},
          try(var.resources[svc.key].requests_memory, null) != null ? { memory = var.resources[svc.key].requests_memory } : {}
        )
        limits = merge(
          try(var.resources[svc.key].limits_cpu, null) != null ? { cpu = var.resources[svc.key].limits_cpu } : {},
          try(var.resources[svc.key].limits_memory, null) != null ? { memory = var.resources[svc.key].limits_memory } : {}
        )
      }
    )
  }

  deployments = [
    for svc in var.services : {
      apiVersion = "apps/v1"
      kind       = "Deployment"
      metadata = {
        name        = svc.key
        namespace   = var.namespace
        labels      = lookup(local.labels_for, svc.key, local.common_labels)
        annotations = {}
      }
      spec = {
        replicas             = 1
        revisionHistoryLimit = 3
        # Recreate, not RollingUpdate: every data volume here is ReadWriteOnce,
        # so a rolling update schedules a second pod that cannot attach the PVC
        # and the rollout blocks until someone deletes the old ReplicaSet.
        strategy = { type = "Recreate" }
        selector = {
          matchLabels = {
            "app.kubernetes.io/name"      = local.name_prefix
            "app.kubernetes.io/instance"  = var.namespace
            "app.kubernetes.io/component" = svc.key
          }
        }
        template = {
          metadata = {
            labels = merge(lookup(local.labels_for, svc.key, local.common_labels), {
              "streampay.io/service" = svc.key
            })
            annotations = local.pod_annotations
          }
          spec = merge(
            {
              serviceAccountName = local.service_account.metadata.name
              # Set on the pod as well as the ServiceAccount: the account is the
              # default, but a pod that overrides serviceAccountName would
              # otherwise get a token mounted into every container.
              automountServiceAccountToken = false
              # The stack has no init containers to wait for; a pod that cannot
              # pull its image should fail visibly instead of sitting Pending.
              terminationGracePeriodSeconds = svc.key == "indexer" ? 60 : 30
              securityContext = {
                fsGroupChangePolicy = "OnRootMismatch"
                runAsGroup          = lookup(local.run_as_user_by_key, svc.key, 1000)
                runAsUser           = lookup(local.run_as_user_by_key, svc.key, 1000)
                fsGroup             = lookup(local.run_as_user_by_key, svc.key, 1000)
                seccompProfile      = { type = "RuntimeDefault" }
              }
              containers = [
                merge(
                  {
                    name            = svc.key
                    image           = svc.image
                    imagePullPolicy = var.image_pull_policy
                    env             = [for k in sort(keys(svc.env)) : { name = k, value = svc.env[k] }]
                    envFrom         = try(var.secrets.k8s_env_from_by_service[svc.key], [])
                    ports = [for p in svc.ports : {
                      name          = p.name
                      containerPort = p.container
                      protocol      = "TCP"
                    }]
                    volumeMounts = lookup(local.volume_mounts_for, svc.key, [])
                    securityContext = merge(local.container_security_context, {
                      runAsNonRoot = true
                      runAsUser    = lookup(local.run_as_user_by_key, svc.key, 1000)
                    })
                  },
                  length(svc.command) > 0 ? { command = svc.command } : {},
                  length(svc.args) > 0 ? { args = svc.args } : {},
                  try(lookup(local.probes_for, svc.key, {}).readiness, null) != null ? {
                    readinessProbe = lookup(local.probes_for, svc.key, {}).readiness
                  } : {},
                  try(lookup(local.probes_for, svc.key, {}).liveness, null) != null ? {
                    livenessProbe = lookup(local.probes_for, svc.key, {}).liveness
                  } : {},
                  length(lookup(local.resources_for, svc.key, {})) > 0 ? {
                    resources = lookup(local.resources_for, svc.key, {})
                  } : {}
                )
              ]
              volumes = lookup(local.volumes_for, svc.key, [])
            },
            length(var.node_selector) > 0 ? { nodeSelector = var.node_selector } : {},
            length(var.image_pull_secrets) > 0 ? {
              imagePullSecrets = [for name in var.image_pull_secrets : { name = name }]
            } : {},
            # Reconciler and sentinel are single-instance by design: two of
            # either would double-spend the outbox and double-fund streams. On a
            # single-node cluster (or when the operator pinned everything with
            # node_selector) this is just a preference, so it is a preferred
            # term rather than a required one that would leave pods Pending.
            length(var.node_selector) > 0 ? {} : {
              affinity = {
                podAntiAffinity = {
                  preferredDuringSchedulingIgnoredDuringExecution = [{
                    weight = 100
                    podAffinityTerm = {
                      topologyKey = "kubernetes.io/hostname"
                      labelSelector = {
                        matchLabels = {
                          "app.kubernetes.io/name"     = local.name_prefix
                          "app.kubernetes.io/instance" = var.namespace
                        }
                      }
                    }
                  }]
                }
              }
            }
          )
        }
      }
    }
  ]
}
