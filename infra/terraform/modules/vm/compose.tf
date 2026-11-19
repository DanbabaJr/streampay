# docker-compose rendering for the single-VM path.

locals {
  # Prometheus, Alertmanager and Grafana run as the uid baked into their official
  # images, so their data goes in *named* volumes: Docker copies the image's
  # directory ownership into a fresh volume, which a bare bind mount would not.
  # Our own node images all run as uid 1000 (see infra/docker/Dockerfile.*), so
  # their state goes to bind mounts that install.sh chowns explicitly.
  named_volume_services = ["prometheus", "alertmanager", "grafana"]

  bind_mount_dirs = {
    for svc in var.services :
    svc.name => "${var.host_data_root}/${svc.key}"
    if svc.data_volume != null && !contains(local.named_volume_services, svc.key)
  }

  named_volumes_used = {
    for svc in var.services :
    svc.data_volume.name => {}
    if svc.data_volume != null && contains(local.named_volume_services, svc.key)
  }

  config_mounts = {
    indexer = []
    sentinel = [
      "${var.config_dir}/ttl-sentinel.config.json:/etc/streampay/ttl-sentinel.config.json:ro",
    ]
    alertmanager = [
      "${var.config_dir}/alertmanager.yml.tpl:/etc/alertmanager/template/alertmanager.yml:ro",
      "${var.config_dir}/alertmanager-rewrite.sh:/etc/streampay/alertmanager-rewrite.sh:ro",
    ]
    prometheus = [
      "${var.config_dir}/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro",
      "${var.config_dir}/prometheus/rules:/etc/prometheus/rules:ro",
    ]
    grafana = [
      "${var.config_dir}/grafana/provisioning/datasources/datasource.yml:/etc/grafana/provisioning/datasources/datasource.yml:ro",
      "${var.config_dir}/grafana/provisioning/dashboards/provider.yml:/etc/grafana/provisioning/dashboards/provider.yml:ro",
      "${var.config_dir}/grafana/dashboards/streampay-overview.json:/etc/grafana/provisioning/dashboards/streampay-overview.json:ro",
    ]
  }

  volume_mounts = {
    for svc in var.services :
    svc.name => concat(
      svc.data_volume == null ? [] : (
        contains(local.named_volume_services, svc.key)
        ? ["${svc.data_volume.name}:${svc.data_volume.mount}"]
        : ["${lookup(local.bind_mount_dirs, svc.name, "")}:${svc.data_volume.mount}"]
      ),
      svc.log_volume ? ["${var.host_log_root}/${svc.key}:/var/log/streampay"] : [],
      try(local.config_mounts[svc.key], [])
    )
  }

  healthchecks = {
    for svc in var.services :
    svc.name => {
      test         = ["CMD-SHELL", "wget -qO- \"http://127.0.0.1:${svc.ports[0].container}${svc.health_path}\" >/dev/null 2>&1 || exit 1"]
      interval     = "15s"
      timeout      = "5s"
      retries      = 5
      start_period = "30s"
    }
    if svc.health_path != null && length(svc.ports) > 0
  }

  # Which loopback port, if any, each service publishes on the host. The TLS
  # listener is the only thing meant to be reachable from outside the machine.
  published_ports = {
    for svc in var.services :
    svc.name => concat(
      svc.key == "grafana" && var.grafana_host_port > 0 ? ["${var.admin_bind_address}:${var.grafana_host_port}:${svc.ports[0].container}"] : [],
      svc.key == "prometheus" && var.prometheus_host_port > 0 ? ["${var.admin_bind_address}:${var.prometheus_host_port}:${svc.ports[0].container}"] : [],
      svc.key == "indexer" && var.indexer_host_port > 0 ? ["${var.admin_bind_address}:${var.indexer_host_port}:${svc.ports[0].container}"] : []
    )
    # `&&` does not short-circuit in HCL, so the guard has to tolerate a service
    # with no ports reaching the index.
    if try(svc.ports[0].expose, false)
  }

  log_config = {
    driver = "json-file"
    options = {
      "max-size" = var.log_max_size
      "max-file" = tostring(var.log_max_file)
    }
  }

  limits_for = {
    for svc in var.services :
    svc.name => merge(
      try(var.container_limits[svc.key].memory, null) != null ? {
        memory = var.container_limits[svc.key].memory
      } : {},
      try(var.container_limits[svc.key].cpus, null) != null ? {
        cpus = tostring(var.container_limits[svc.key].cpus)
      } : {},
      try(var.container_limits[svc.key].pids_limit, null) != null ? {
        pids_limit = var.container_limits[svc.key].pids_limit
      } : {}
    )
  }

  compose_services = merge(
    {
      for svc in var.services : svc.name => merge(
        {
          image   = svc.image
          restart = "unless-stopped"
          init    = true
          # These containers only call public RPC endpoints; they need no
          # capabilities at all, and setuid inside a poller is pure attack
          # surface.
          cap_drop     = ["ALL"]
          security_opt = ["no-new-privileges:true"]
          logging      = local.log_config
        },
        # Sorted so the rendered file is byte-identical across machines; an empty
        # list is omitted rather than rendered, because `environment: []` makes a
        # reader wonder whether something was lost.
        length(svc.env) > 0 ? {
          environment = sort([for k, v in svc.env : "${k}=${v}"])
        } : {},
        length(lookup(local.volume_mounts, svc.name, [])) > 0 ? {
          volumes = lookup(local.volume_mounts, svc.name, [])
        } : {},
        length(svc.command) > 0 ? { entrypoint = svc.command } : {},
        length(svc.args) > 0 ? { command = svc.args } : {},
        length(lookup(local.published_ports, svc.name, [])) > 0 ? {
          ports = lookup(local.published_ports, svc.name, [])
        } : {},
        lookup(local.healthchecks, svc.name, null) != null ? {
          healthcheck = lookup(local.healthchecks, svc.name, null)
        } : {},
        length(svc.depends_on) > 0 ? { depends_on = svc.depends_on } : {},
        length(lookup(local.limits_for, svc.name, {})) > 0 ? lookup(local.limits_for, svc.name, {}) : {},
        # HCL cannot unify a multi-attribute object with `{}`, so each hardening
        # key is its own conditional.
        var.read_only_rootfs ? { read_only = true } : {},
        var.read_only_rootfs ? { tmpfs = ["/tmp"] } : {},
        # The 0600 per-service secret file, delivered by the secrets strategy.
        try(var.secrets.secret_paths_by_service[svc.key], null) != null ? {
          env_file = [var.secrets.secret_paths_by_service[svc.key]]
        } : {}
      )
    },
    var.tls_mode == "off" ? {} : {
      (local.caddy_name) = {
        image   = var.caddy_image
        restart = "unless-stopped"
        init    = true
        # CAP_NET_BIND_SERVICE is the one exception in the whole stack: 80/443
        # are privileged and Caddy binds them directly instead of relying on the
        # host's ip_unprivileged_port_start sysctl.
        cap_add      = ["NET_BIND_SERVICE"]
        cap_drop     = ["ALL"]
        security_opt = ["no-new-privileges:true"]
        ports = [
          "${var.host_http_port}:${var.host_http_port}",
          "${var.host_https_port}:${var.host_https_port}",
        ]
        depends_on = [for svc in var.services : svc.name if svc.key == "grafana"]
        volumes = concat(
          ["${var.config_dir}/Caddyfile:/etc/caddy/Caddyfile:ro"],
          ["caddy_data:/data", "caddy_config:/config"],
          var.tls_mode == "file" ? [
            "${var.tls_cert_file}:/etc/streampay/tls/cert.pem:ro",
            "${var.tls_key_file}:/etc/streampay/tls/key.pem:ro",
          ] : []
        )
        logging = local.log_config
      }
    }
  )

  compose_document = {
    name     = var.project_name
    services = local.compose_services
    volumes = merge(
      local.named_volumes_used,
      var.tls_mode == "off" ? {} : {
        caddy_data   = {}
        caddy_config = {}
      }
    )
    networks = {
      # Every service stays on one bridge network; nothing else on the machine
      # can reach it, and the only host-visible sockets are the loopback ports
      # above and the TLS listener.
      default = {
        driver = "bridge"
      }
    }
  }

  compose_yaml = yamlencode(local.compose_document)
}
