output "manifest_dir" {
  description = "Directory holding the rendered manifests and their README."
  value       = local.manifest_dir
}

output "manifest_path" {
  description = "The single file to apply. Content is a pure function of the module inputs, so re-rendering never churns."
  value       = local_file.manifests.filename
}

output "manifest_checksum" {
  description = "sha256 of the rendered stream. Compare it across runs, or pin it in a GitOps check, to prove a re-render changed nothing."
  value       = module.k8s.manifest_checksum
}

output "document_kinds" {
  description = "kind/name of every rendered document, in apply order."
  value       = module.k8s.document_kinds
}

output "secret_names_by_service" {
  description = "The Secrets you must create before applying. Names only -- this stack never sees a value."
  value       = module.k8s.secret_names_by_service
}

output "secret_bootstrap_commands" {
  description = "One-time, out-of-band kubectl commands that create those Secrets from a shell that already holds the values. Run them, then forget they existed: they are not part of the plan."
  value = replace(
    module.secrets.k8s_secret_bootstrap_commands,
    "-n NAMESPACE",
    "-n ${var.namespace}"
  )
}

output "secrets_strategy" {
  description = "Always k8s_secret here; the threat tradeoff of that choice (and of external-secrets/sealed-secrets as upgrades) is in docs/DEPLOYMENT.md."
  value       = module.secrets.strategy
}

output "images" {
  description = "Every image the cluster will pull. A :local tag only resolves on kind/minikube with the image loaded into the node."
  value       = module.k8s.image_references
}

output "pvc_names" {
  description = "Data volumes the stack asks for, with sizes and access modes."
  value       = module.k8s.pvc_names
}

output "ingress" {
  description = "The public listener document, or null when there is none. Its tls block carries the certificate policy."
  value       = module.k8s.ingress
}

output "extender_cronjob" {
  description = "The TTL-extender CronJob, or null when the extender is disabled."
  value       = module.k8s.extender_cronjob
}

output "endpoints" {
  description = "How to reach the stack once it is up. Prometheus and Alertmanager are ClusterIP-only by design: neither has authentication, so neither gets an Ingress path."
  value = {
    dashboard              = var.ingress_host != "" ? "${var.ingress_tls_mode == "off" ? "http" : "https"}://${var.ingress_host}/" : "kubectl -n ${var.namespace} port-forward svc/${local.grafana_service_name} 3000:3000"
    prometheus_portforward = "kubectl -n ${var.namespace} port-forward svc/${local.prometheus_name} 9090:9090"
    indexer_api            = var.expose_indexer_api ? "cluster http://${local.indexer_service_name}:8787, public read paths on the ingress" : "cluster http://${local.indexer_service_name}:8787 only"
  }
}

output "apply_commands" {
  description = "The exact sequence from empty namespace to observing stack, including the out-of-band Secret step Terraform deliberately does not do for you."
  value = join("\n", [
    "# 1. namespace + everything else in one file",
    "kubectl apply -f ${local.manifest_path}",
    "# 2. credentials, from a shell that already holds them (see secret_bootstrap_commands)",
    "# 3. watch it come up",
    "kubectl -n ${var.namespace} rollout status deployment/indexer --timeout=180s",
    "kubectl -n ${var.namespace} get pods,svc,ingress,cronjob",
    "# 4. the plan after this apply is empty by construction",
    "terraform plan -detailed-exitcode -var contract_id=${var.contract_id}",
  ])
}

output "applied_with_kubectl" {
  description = "Id of the kubectl run, or null when apply_with_kubectl=false and the file is the deliverable."
  value = var.apply_with_kubectl ? try(
    null_resource.apply[0].id,
    null
  ) : null
}
