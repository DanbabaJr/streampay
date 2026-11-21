# systemd supervision for the compose stack.
#
# The incident runbooks already speak `systemctl status streampay-indexer`
# (docs/INCIDENT_RUNBOOK.md), so each compose service gets a thin oneshot unit
# over `docker compose ... <service>` instead of a second, competing process
# supervisor. `streampay-stack.service` owns the whole project; the per-service
# units exist for the targeted restart/isolate that a runbook asks for.

locals {
  stack_unit  = "${var.project_name}-stack"
  unit_names  = concat([for svc in var.services : svc.name], var.tls_mode == "off" ? [] : [local.caddy_name])
  compose_cli = "/usr/bin/docker compose -f ${var.install_dir}/docker-compose.yml"

  stack_service = <<-UNIT
    [Unit]
    Description=StreamPay observing stack (docker compose project ${var.project_name})
    Documentation=file:${var.install_dir}/README.md
    Requires=docker.service
    After=docker.service network-online.target
    Wants=network-online.target

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    # Bring the project up (or leave it as-is) and never pull: images are built
    # or pinned by install.sh, so a start cannot silently change what runs.
    ExecStart=${local.compose_cli} up -d --no-build
    ExecStop=${local.compose_cli} stop
    ExecStopPost=${local.compose_cli} down --remove-orphans
    TimeoutStartSec=300

    [Install]
    WantedBy=multi-user.target
    UNIT

  service_units = {
    for name in local.unit_names : "systemd/${name}.service" => <<-UNIT
      [Unit]
      Description=StreamPay ${name} (compose member)
      Documentation=file:${var.install_dir}/README.md
      Requires=${local.stack_unit}.service
      After=${local.stack_unit}.service docker.service
      PartOf=${local.stack_unit}.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      # PartOf= makes stop/restart of the stack reach every member, while this
      # unit still gives the runbook its per-service `systemctl restart`.
      ExecStart=${local.compose_cli} up -d --no-build --wait --wait-timeout 120 ${name}
      ExecStop=${local.compose_cli} stop ${name}

      [Install]
      WantedBy=multi-user.target
      UNIT
  }

  # `cli.js extend` has no --watch loop, so the funded extender is a timer, not
  # a long-running container: a short-lived process that reads the secret file,
  # submits, and exits keeps the key in memory for seconds per hour instead of
  # continuously.
  #
  # Compose names its default network "<project>_default"; the one-word form
  # would be resolved against the *default* compose project of the unit's cwd,
  # which is not this stack.
  extender_network = "${var.project_name}_default"
  extender_argv    = join(" ", concat(var.extender.command, var.extender.args))
  extender_env_flags = join(" ", [
    for k in sort(keys(var.extender.env)) : "--env ${k}=${var.extender.env[k]}"
  ])
  extender_sentinel_mount = try([for svc in var.services : svc.data_volume.mount if svc.key == "sentinel"][0], "/var/lib/streampay")

  extender_units = var.extender.enabled ? {
    "systemd/${var.extender.name}.service" = <<-UNIT
      [Unit]
      Description=StreamPay TTL extender (one-shot)
      Documentation=file:${var.install_dir}/README.md
      Requires=docker.service
      After=docker.service network-online.target
      Wants=network-online.target

      [Service]
      Type=oneshot
      WorkingDirectory=${var.install_dir}
      # The funded key is read from the 0600 file by the container process and
      # never enters this unit's environment: no EnvironmentFile here, and the
      # unit is stopped between ticks.
      ExecStart=/usr/bin/docker run --rm \\
        --network ${local.extender_network} \\
        --cap-drop ALL --security-opt no-new-privileges:true \\
        --env-file ${var.config_dir}/streampay-secrets-sentinel.env \\
        ${local.extender_env_flags} \\
        -v ${var.config_dir}/ttl-sentinel.config.json:/etc/streampay/ttl-sentinel.config.json:ro \\
        -v ${var.host_data_root}/sentinel:${local.extender_sentinel_mount} \\
        ${var.extender.image} ${local.extender_argv}
      # One submit per tick; a hung RPC call must not stack up transactions.
      TimeoutStartSec=600
      Restart=no
    UNIT
    "systemd/${var.extender.name}.timer"   = <<-TIMER
      [Unit]
      Description=Run the StreamPay TTL extender on a schedule

      [Timer]
      OnCalendar=${var.extender_schedule}
      Persistent=true
      RandomizedDelaySec=120
      AccuracySec=60

      [Install]
      WantedBy=timers.target
      TIMER
  } : {}

  systemd_files = merge(
    {
      "systemd/${local.stack_unit}.service" = local.stack_service
    },
    local.service_units,
    local.extender_units
  )

  systemd_bundle = {
    for path, content in local.systemd_files : path => {
      content = content
      mode    = "0644"
    }
  }
}
