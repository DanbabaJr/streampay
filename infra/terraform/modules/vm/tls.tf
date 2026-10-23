# TLS listener rendering (Caddy) for the single-VM path.

locals {
  caddy_name = "${var.project_name}-caddy"

  # Without a name the listener still terminates TLS: Caddy's internal CA issues
  # for whatever Host the client sends, and an IP-only host has nothing better
  # than that. acme is the only mode that genuinely requires a domain, and the
  # vm module's preconditions enforce it there.
  site_address = var.tls_mode == "off" ? ":${var.host_http_port}" : (
    var.tls_domain != "" ? var.tls_domain : ":${var.host_https_port}"
  )

  # The certificate the secret mechanism delivers lands on these in-container
  # paths; the host paths (tls_cert_file / tls_key_file) are mounted onto them.
  tls_container_cert = "/etc/streampay/tls/cert.pem"
  tls_container_key  = "/etc/streampay/tls/key.pem"

  tls_directive = {
    acme     = var.tls_email != "" ? "tls {\n\temail ${var.tls_email}\n}" : "tls",
    internal = "tls internal",
    file     = "tls ${local.tls_container_cert} ${local.tls_container_key}",
    off      = "# tls_mode=off: TLS is terminated in front of this host",
  }[var.tls_mode]

  grafana_upstream = "${try([for svc in var.services : svc.name if svc.key == "grafana"][0], "${var.project_name}-grafana")}:3000"
  indexer_upstream = "${try([for svc in var.services : svc.name if svc.key == "indexer"][0], "${var.project_name}-indexer")}:${try([for svc in var.services : svc.ports[0].container if svc.key == "indexer"][0], 8787)}"

  # HSTS only means anything over an encrypted listener; a plain-HTTP site that
  # sends it can permanently break the host for browsers that ever saw it.
  security_headers = var.tls_mode == "off" ? "" : <<-BLOCK
    	header {
    		Strict-Transport-Security "max-age=31536000; includeSubDomains"
    		X-Content-Type-Options "nosniff"
    		X-Frame-Options "DENY"
    		Referrer-Policy "no-referrer"
    		-Server
    		-X-Powered-By
    	}

    BLOCK

  # Read endpoints only: /health and /metrics stay internal so an anonymous
  # visitor cannot fingerprint the host, and the outbox admin endpoints are used
  # by the reconciler over the docker network instead.
  indexer_routes_block = <<-HDR
    	handle /api/webhooks/* {
    		reverse_proxy ${local.indexer_upstream}
    	}
    	handle /api/outbox/* {
    		reverse_proxy ${local.indexer_upstream}
    	}
    	handle /streams* {
    		reverse_proxy ${local.indexer_upstream}
    	}
    	handle /address/* {
    		reverse_proxy ${local.indexer_upstream}
    	}

    HDR
  indexer_routes       = var.expose_indexer_api ? local.indexer_routes_block : ""

  caddyfile = <<-CFGL
    {
    	# The Caddy admin API serves /metrics without authentication, so it stays
    	# on the container's own loopback rather than the bridge network.
    	admin 127.0.0.1:2019
    }

    ${local.site_address} {
    	encode zstd gzip

    ${local.security_headers}${local.tls_directive}

    ${local.indexer_routes}	handle {
    		# Grafana is the only UI on this host and it does its own authn.
    		# Prometheus is deliberately not proxied: it has no authentication, so
    		# it stays reachable only on the host loopback (prometheus_host_port).
    		reverse_proxy ${local.grafana_upstream}
    	}

    	respond /healthz "ok" 200
    }
    CFGL

  # Bundled into the README so the operator knows what they are about to trust.
  tls_explainer_by_mode = {
    acme     = "Caddy asks Let's Encrypt for a certificate for the site name. Real browser trust, but it needs a DNS record already pointing here and port 80 reachable from the internet - a renewal failure takes the site down."
    internal = "Caddy is its own CA, issuing for whatever Host the client sends. The channel is encrypted end to end, but the certificate is not trusted by browsers: expect a warning, or distribute the root with 'caddy trust' on machines you control. Nothing leaves the host - no DNS, no port-80 reachability, no renewal dependency on a third party."
    file     = "Caddy serves the certificate mounted at /etc/streampay/tls/cert.pem inside the container. Use it when a CA you already trust issued the certificate (ACM, Smallstep, a private CA). The key must arrive through the secret mechanism with mode 0600, and renewal is yours."
    off      = "Plain HTTP, and no public listener is created at all. Only acceptable behind a load balancer or ingress that terminates TLS: the Grafana session cookie and every alert credential cross the network in the clear otherwise."
  }

  tls_explainer = "tls_mode=${var.tls_mode} means: ${local.tls_explainer_by_mode[var.tls_mode]}"
}
