# Document assembly: everything above becomes one ordered, deterministic YAML
# stream the operator can hand to kubectl, Argo CD or Flux.

locals {
  namespace_doc = var.skip_namespaced_manifest ? null : {
    apiVersion = "v1"
    kind       = "Namespace"
    metadata = {
      name   = var.namespace
      labels = merge(local.common_labels, { "streampay.io/managed" = "terraform" })
    }
  }

  configmap_docs = [
    for cm in local.configmaps : {
      apiVersion = "v1"
      kind       = "ConfigMap"
      metadata = {
        name        = cm.name
        namespace   = var.namespace
        labels      = local.common_labels
        annotations = {}
      }
      data = cm.data
    }
  ]

  pvc_docs = [
    for pvc in local.pvcs : {
      apiVersion = "v1"
      kind       = "PersistentVolumeClaim"
      metadata = {
        name        = pvc.name
        namespace   = var.namespace
        labels      = merge(local.common_labels, { "app.kubernetes.io/component" = pvc.key })
        annotations = {}
      }
      spec = merge(
        {
          accessModes = pvc.access
          resources = {
            requests = { storage = pvc.size }
          }
        },
        pvc.class_name != "" ? { storageClassName = pvc.class_name } : {}
      )
    }
  ]

  # Ordered so a single `kubectl apply -f` converges: the namespace must exist
  # before anything references it, the ConfigMaps and PVCs before the pods that
  # mount them, the Services before the Ingress that points at them.
  documents = concat(
    local.namespace_doc != null ? [local.namespace_doc] : [],
    [local.service_account],
    local.configmap_docs,
    local.pvc_docs,
    local.cluster_services,
    local.deployments,
    [local.default_deny],
    local.allow_within_namespace,
    local.allow_from_ingress,
    local.ingress != null ? [local.ingress] : [],
    local.extender_cronjob != null ? [local.extender_cronjob] : []
  )

  manifests_yaml = join("\n", concat(
    ["# Rendered by infra/terraform/modules/k8s. Do not edit: change the module or"],
    ["# its variables and re-apply. kubectl apply -f this file is idempotent."],
    [for doc in local.documents : "---\n${yamlencode(doc)}"]
  ))

  # The stack uses this as the apply trigger: the manifests only re-apply when a
  # rendered document actually changed, which is what keeps a second apply empty.
  manifest_checksum = sha256(local.manifests_yaml)

  apply_readme = join("\n", [
    "# StreamPay on Kubernetes",
    "",
    "`manifests.yaml` in this directory is the whole stack: Namespace,",
    "ServiceAccount, ConfigMaps, PVCs, Services, Deployments, NetworkPolicies,",
    "the public Ingress and the extender CronJob.",
    "",
    "## Before you apply",
    "",
    "1. The Secrets must exist, or the pods start with an empty environment.",
    "   They are created out of band -- Terraform renders their *names* only:",
    "",
    "   ```sh",
    # The secrets module cannot know the namespace, so it emits a placeholder
    # here rather than a command that would work in exactly one stack.
    replace(var.secrets.k8s_secret_bootstrap_commands, "-n NAMESPACE", "-n ${var.namespace}"),
    "   ```",
    "",
    "   Names referenced by envFrom: `${join("`, `", sort(keys(var.secrets.k8s_secret_names_by_service)))}`.",
    "2. With `ingress_tls_mode=cert-manager` the cert-manager CRDs and the",
    "   ClusterIssuer `${var.cert_manager_cluster_issuer}` must already exist.",
    "3. The data PVCs request `${join(", ", sort([for p in local.pvcs : "${p.name}=${p.size}"]))}`",
    "   from ${var.storage_class_name == "" ? "the cluster default StorageClass" : "StorageClass `${var.storage_class_name}`"};",
    "   the indexer needs a block (ReadWriteOnce) volume, not NFS.",
    "",
    "## Apply",
    "",
    "```sh",
    "kubectl apply -f manifests.yaml",
    "kubectl -n ${var.namespace} rollout status deployment/indexer --timeout=180s",
    "kubectl -n ${var.namespace} get pods,svc,pvc,netpol,ingress,cronjob",
    "```",
    "",
    "## Re-apply and drift",
    "",
    "Everything in the file is derived from module inputs, so applying twice is",
    "byte-identical. `terraform plan` after an apply is empty as long as nothing",
    "outside Terraform edits these objects; if your platform team injects",
    "sidecar annotations, add them to `pod_annotations` instead of fighting drift.",
    "",
    "## Notes",
    "",
    "- NetworkPolicy denies all ingress to the namespace except peer pods of the",
    "  stack and, when `ingress_controller_namespace_label` is set, the ingress",
    "  controller. Egress is unrestricted on purpose (see the module comment).",
    "- Prometheus is exposed as a ClusterIP only. It has no authentication, so it",
    "  is reachable from inside the namespace, never through the Ingress.",
    "- The extender runs as a CronJob with `concurrencyPolicy: Forbid`; two funds",
    "  in flight would double-pay for the same stream.",
    var.additional_notes
  ])
}
