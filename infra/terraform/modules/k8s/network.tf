# Cluster-internal Services, the public Ingress, and NetworkPolicy.

locals {
  # The Service is named after the *service definition*, not its short key,
  # because modules/services already writes those same names into every in-cluster
  # URL it renders (Prometheus scrape targets, the Alertmanager sink, the Grafana
  # datasource). A cluster Service called "indexer" would leave Prometheus
  # scraping a host that does not resolve.
  cluster_services = [
    for svc in var.services : {
      apiVersion = "v1"
      kind       = "Service"
      metadata = {
        name        = svc.name
        namespace   = var.namespace
        labels      = lookup(local.labels_for, svc.key, local.common_labels)
        annotations = {}
      }
      spec = {
        type = "ClusterIP"
        selector = {
          "app.kubernetes.io/name"      = local.name_prefix
          "app.kubernetes.io/instance"  = var.namespace
          "app.kubernetes.io/component" = svc.key
        }
        ports = [for p in svc.ports : {
          name       = p.name
          port       = p.container
          targetPort = p.container
          protocol   = "TCP"
        }]
      }
    }
    if length(svc.ports) > 0
  ]

  indexer_port = try([for svc in var.services : svc.ports[0].container if svc.key == "indexer"][0], 8787)
  grafana_port = try([for svc in var.services : svc.ports[0].container if svc.key == "grafana"][0], 3000)

  name_for_key = {
    for svc in var.services : svc.key => svc.name
  }

  indexer_service_name = lookup(local.name_for_key, "indexer", "${local.name_prefix}-indexer")
  grafana_service_name = lookup(local.name_for_key, "grafana", "${local.name_prefix}-grafana")

  ingress_paths = concat(
    [
      {
        path     = "/"
        pathType = "Prefix"
        backend = {
          service = {
            name = local.grafana_service_name
            port = { number = local.grafana_port }
          }
        }
      }
    ],
    var.expose_indexer_api ? [
      {
        path     = "/api/webhooks"
        pathType = "Prefix"
        backend = {
          service = {
            name = local.indexer_service_name
            port = { number = local.indexer_port }
          }
        }
      },
      {
        path     = "/streams"
        pathType = "Prefix"
        backend = {
          service = {
            name = local.indexer_service_name
            port = { number = local.indexer_port }
          }
        }
      },
      {
        path     = "/address"
        pathType = "Prefix"
        backend = {
          service = {
            name = local.indexer_service_name
            port = { number = local.indexer_port }
          }
        }
      }
    ] : []
  )

  ingress_annotations = merge(
    var.ingress_annotations,
    var.ingress_tls_mode == "cert-manager" ? {
      (var.ingress_tls_is_namespaced_issuer ? "cert-manager.io/issuer" : "cert-manager.io/cluster-issuer") = var.cert_manager_cluster_issuer
    } : {},
    # A plain-HTTP ingress with HSTS on would be broken for the browser anyway;
    # only add the redirect where TLS actually terminates.
    var.ingress_tls_mode == "off" ? {} : {
      "nginx.ingress.kubernetes.io/ssl-redirect"       = "true"
      "nginx.ingress.kubernetes.io/force-ssl-redirect" = "true"
    }
  )

  ingress = var.ingress_tls_mode == "off" && var.ingress_host == "" ? null : {
    apiVersion = "networking.k8s.io/v1"
    kind       = "Ingress"
    metadata = {
      name        = "${local.name_prefix}-public"
      namespace   = var.namespace
      labels      = local.common_labels
      annotations = local.ingress_annotations
    }
    spec = merge(
      {
        rules = [{
          http = { paths = local.ingress_paths }
        }]
      },
      var.ingress_class_name != "" ? { ingressClassName = var.ingress_class_name } : {},
      var.ingress_host != "" ? {
        rules = [{
          host = var.ingress_host
          http = { paths = local.ingress_paths }
        }]
      } : {},
      var.ingress_tls_mode == "off" ? {} : {
        tls = [{
          hosts      = var.ingress_host != "" ? [var.ingress_host] : []
          secretName = var.ingress_tls_secret
        }]
      }
    )
  }

  # --------------------------------------------------------------------------
  # NetworkPolicy
  #
  # Two documents: deny everything coming in to the namespace, then allow the
  # traffic the stack actually needs. Egress is deliberately *not* restricted --
  # every service here talks to a public Stellar RPC endpoint whose address you
  # do not control, and an egress policy that omits it turns the stack into a
  # mysterious timeout hunt. Add egress rules when your cluster has a policy
  # for outbound; docs/DEPLOYMENT.md says so.
  # --------------------------------------------------------------------------
  default_deny = {
    apiVersion = "networking.k8s.io/v1"
    kind       = "NetworkPolicy"
    metadata = {
      name      = "${local.name_prefix}-deny-ingress"
      namespace = var.namespace
      labels    = local.common_labels
    }
    spec = {
      # Matches every pod in the namespace; no ingress rules means no ingress.
      podSelector = {}
      policyTypes = ["Ingress"]
    }
  }

  allow_within_namespace = [
    for svc in var.services : {
      apiVersion = "networking.k8s.io/v1"
      kind       = "NetworkPolicy"
      metadata = {
        name      = "${local.name_prefix}-allow-${svc.key}"
        namespace = var.namespace
        labels    = local.common_labels
      }
      spec = {
        podSelector = {
          matchLabels = {
            "app.kubernetes.io/name"      = local.name_prefix
            "app.kubernetes.io/instance"  = var.namespace
            "app.kubernetes.io/component" = svc.key
          }
        }
        policyTypes = ["Ingress"]
        ingress = [
          # Peer pods (Prometheus scraping, Alertmanager receiving, the reconciler
          # posting to the indexer outbox) reach the service's own ports.
          {
            from = [{
              podSelector = {
                matchLabels = {
                  "streampay.io/scrape" = var.prometheus_scrape_pod_label
                }
              }
            }]
            ports = [for p in svc.ports : { protocol = "TCP", port = p.container }]
          }
        ]
      }
    }
    if length(svc.ports) > 0
  ]

  allow_from_ingress = length(var.ingress_controller_namespace_label) == 0 || local.ingress == null ? [] : [
    for key in ["grafana", "indexer"] : {
      apiVersion = "networking.k8s.io/v1"
      kind       = "NetworkPolicy"
      metadata = {
        name      = "${local.name_prefix}-public-${key}"
        namespace = var.namespace
        labels    = local.common_labels
      }
      spec = {
        podSelector = {
          matchLabels = {
            "app.kubernetes.io/name"      = local.name_prefix
            "app.kubernetes.io/instance"  = var.namespace
            "app.kubernetes.io/component" = key
          }
        }
        policyTypes = ["Ingress"]
        ingress = [{
          from = [{
            namespaceSelector = {
              matchLabels = var.ingress_controller_namespace_label
            }
            podSelector = {}
          }]
          ports = [{
            protocol = "TCP"
            port     = key == "grafana" ? local.grafana_port : local.indexer_port
          }]
        }]
      }
    }
    if key != "indexer" || var.expose_indexer_api
  ]
}
