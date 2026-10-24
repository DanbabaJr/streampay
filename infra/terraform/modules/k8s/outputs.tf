output "namespace" {
  description = "Namespace every rendered object lives in."
  value       = var.namespace
}

output "manifests_yaml" {
  description = "The whole stack as one ordered YAML stream. Write it to disk and apply it; the content is a pure function of the module inputs, so a second render is byte-identical."
  value       = local.manifests_yaml
}

output "manifest_checksum" {
  description = "sha256 of manifests_yaml. The stack feeds this to its apply trigger so a re-apply only happens when a document really changed."
  value       = local.manifest_checksum
}

output "apply_readme" {
  description = "Pre-apply checklist (Secrets, issuer, storage) and the commands to converge, rendered beside the manifests so the file cannot be applied without its instructions."
  value       = local.apply_readme
}

output "document_kinds" {
  description = "kind/name of every rendered document, in apply order."
  value = [
    for doc in local.documents : "${doc.kind}/${try(doc.metadata.name, doc.metadata.namespace)}"
  ]
}

output "configmap_names" {
  description = "ConfigMaps the stack renders; useful for a `kubectl diff` before a real apply."
  value       = [for cm in local.configmaps : cm.name]
}

output "pvc_names" {
  description = "PersistentVolumeClaims the stack asks for, and their sizes."
  value = {
    for pvc in local.pvcs : pvc.name => {
      size         = pvc.size
      access_modes = pvc.access
    }
  }
}

output "secret_names_by_service" {
  description = "Kubernetes Secret name each workload reads through envFrom. Names only: values never pass through Terraform."
  value       = var.secrets.k8s_secret_names_by_service
}

output "image_references" {
  description = "Every container image the stack pulls, including the CronJob's. CI greps this list to assert our own images are built from this repo and pinned."
  value = distinct(concat(
    [for svc in var.services : svc.image],
    var.extender.enabled ? [var.extender.image] : []
  ))
}

output "ingress" {
  description = "The rendered Ingress document, or null when there is no public listener. Its tls block and annotations carry the certificate policy."
  value       = local.ingress
}

output "extender_cronjob" {
  description = "The extender CronJob document, or null when the extender is disabled."
  value       = local.extender_cronjob
}
