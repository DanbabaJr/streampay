# The rendered bundle: what Terraform writes, and the single script that turns a
# bare machine into an observing stack.

locals {
  node_uid = "1000"

  # Service state that goes on host bind mounts (our node images, uid 1000)
  # versus named volumes (upstream images, ownership from the image).
  bind_keys = distinct(concat(
    [for svc in var.services : svc.key if svc.data_volume != null && !contains(local.named_volume_services, svc.key)],
    [for svc in var.services : svc.key if svc.log_volume]
  ))

  # The Dockerfiles are written against the repository root as build context
  # (COPY indexer/package.json ...), so the context is the checkout, not the
  # service directory.
  image_build_lines = var.build_local ? join("\n", [
    for b in var.image_builds :
    "build_image \"${b.image}\" \"${var.repo_root}\" \"${var.repo_root}/${b.dockerfile}\""
  ]) : "# build_local=false: images are pulled, never built"

  install_env = join("\n", [
    "# Rendered by terraform (modules/vm). Consumed by install.sh; safe to commit.",
    "PROJECT=\"${var.project_name}\"",
    "INSTALL_DIR=\"${var.install_dir}\"",
    "CONFIG_DIR=\"${var.config_dir}\"",
    "DATA_ROOT=\"${var.host_data_root}\"",
    "LOG_ROOT=\"${var.host_log_root}\"",
    "REPO_ROOT=\"${var.repo_root}\"",
    "NETWORK=\"${var.chain.network}\"",
    "CONTRACT_ID=\"${var.chain.contract_id}\"",
    "RPC_URL=\"${var.chain.rpc_url}\"",
    "SECRETS_STRATEGY=\"${var.secrets.strategy}\"",
    "STACK_UNIT=\"${local.stack_unit}\"",
    "TLS_MODE=\"${var.tls_mode}\"",
    "TLS_SITE=\"${local.site_address}\"",
    "GRAFANA_HOST_PORT=\"${var.grafana_host_port}\"",
    "BUILD_LOCAL=\"${var.build_local ? 1 : 0}\"",
    "SKIP_IMAGE_BUILD=\"${var.skip_image_build ? 1 : 0}\"",
    "NODE_UID=\"${local.node_uid}\"",
    "BIND_KEYS=\"${join(" ", sort(local.bind_keys))}\"",
    "UNIT_NAMES=\"${join(" ", local.unit_names)}\"",
    "EXTENDER_ENABLED=\"${var.extender.enabled ? 1 : 0}\"",
    "EXTENDER_UNIT=\"${var.extender.name}\"",
    "",
  ])

  # One script does the whole install, so the identical path runs from
  # cloud-init, from `terraform apply` on the box, and from a human who scp'd
  # this directory.
  install_script = <<-SH
    #!/bin/sh
    # install.sh -- turn this bundle into a running StreamPay stack.
    #
    # Idempotent by construction: every step is a copy, a chmod, a re-fetch from
    # the secret source, or a declarative compose/systemd converge. Re-running
    # after a config change converges rather than duplicating.
    set -eu

    BUNDLE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
    . "$BUNDLE_DIR/install.env"

    say() { printf '==> %s\n' "$*"; }
    die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

    # copy_into MODE SRC DEST -- `install` refuses to copy a file onto itself,
    # which is exactly what happens when the bundle is rendered in place at
    # INSTALL_DIR. Same path, nothing to do.
    copy_into() {
      mode="$1"; src="$2"; dest="$3"
      case "$src" in
        "$dest") return 0 ;;
      esac
      install -m "$mode" "$src" "$dest"
    }

    command -v docker >/dev/null 2>&1 || die "docker is required; docs/DEPLOYMENT.md has the cloud-init package list"
    docker compose version >/dev/null 2>&1 || die "the docker compose v2 plugin is required"

    say "directories"
    mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_ROOT" "$LOG_ROOT"
    mkdir -p "$CONFIG_DIR/prometheus/rules"
    mkdir -p "$CONFIG_DIR/grafana/provisioning/datasources"
    mkdir -p "$CONFIG_DIR/grafana/provisioning/dashboards"
    mkdir -p "$CONFIG_DIR/grafana/dashboards"
    # 750: the service accounts may read config, other local users may not.
    chmod 750 "$CONFIG_DIR"

    say "configuration"
    # Rendered config is copied out of the Terraform-owned bundle into the
    # host-owned config dir. Terraform never writes under $CONFIG_DIR, so a file
    # an operator edits by hand is not silently reverted by the next apply.
    copy_into 0644 "$BUNDLE_DIR/configs/prometheus/prometheus.yml"                       "$CONFIG_DIR/prometheus/prometheus.yml"
    for rule in "$BUNDLE_DIR"/configs/prometheus/rules/*.yml; do
      # An unmatched glob stays literal, so check before installing it.
      [ -e "$rule" ] || continue
      copy_into 0644 "$rule" "$CONFIG_DIR/prometheus/rules/$(basename "$rule")"
    done
    copy_into 0644 "$BUNDLE_DIR/configs/alertmanager/alertmanager.yml.tpl"               "$CONFIG_DIR/alertmanager.yml.tpl"
    copy_into 0755 "$BUNDLE_DIR/configs/alertmanager/rewrite.sh"                         "$CONFIG_DIR/alertmanager-rewrite.sh"
    copy_into 0644 "$BUNDLE_DIR/configs/grafana/provisioning/datasources/datasource.yml" "$CONFIG_DIR/grafana/provisioning/datasources/datasource.yml"
    copy_into 0644 "$BUNDLE_DIR/configs/grafana/provisioning/dashboards/provider.yml"    "$CONFIG_DIR/grafana/provisioning/dashboards/provider.yml"
    copy_into 0644 "$BUNDLE_DIR/configs/grafana/dashboards/streampay-overview.json"      "$CONFIG_DIR/grafana/dashboards/streampay-overview.json"
    copy_into 0644 "$BUNDLE_DIR/configs/ttl-sentinel/ttl-sentinel.config.json"           "$CONFIG_DIR/ttl-sentinel.config.json"
    [ -f "$BUNDLE_DIR/Caddyfile" ] && copy_into 0644 "$BUNDLE_DIR/Caddyfile" "$CONFIG_DIR/Caddyfile" || true
    [ -f "$BUNDLE_DIR/vault-agent.hcl" ] && copy_into 0644 "$BUNDLE_DIR/vault-agent.hcl" "$CONFIG_DIR/vault-agent.hcl" || true

    say "secrets ($SECRETS_STRATEGY)"
    # Produces the per-service 0600 env files. Prints names and counts only, and
    # for strategy=file it audits the operator-owned file instead of writing one.
    sh "$BUNDLE_DIR/fetch-secrets.sh"

    say "bind-mount ownership"
    # The StreamPay node images drop to uid 1000; a fresh root-owned bind mount
    # would leave the indexer unable to open its SQLite file.
    for key in $BIND_KEYS; do
      mkdir -p "$DATA_ROOT/$key" "$LOG_ROOT/$key"
      if [ "$(id -u)" = 0 ]; then
        chown -R "$NODE_UID:$NODE_UID" "$DATA_ROOT/$key" "$LOG_ROOT/$key"
      else
        say "not root: $DATA_ROOT/$key and $LOG_ROOT/$key must be writable by uid $NODE_UID"
      fi
      chmod 750 "$DATA_ROOT/$key" "$LOG_ROOT/$key"
    done

    say "compose project"
    copy_into 0644 "$BUNDLE_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    copy_into 0644 "$BUNDLE_DIR/install.env"        "$INSTALL_DIR/install.env"
    copy_into 0644 "$BUNDLE_DIR/README.md"          "$INSTALL_DIR/README.md"

    build_image() {
      # $1 tag, $2 context, $3 dockerfile. Skipped when the tag already exists
      # locally, so a re-run converges instead of rebuilding and churning.
      tag="$1"; ctx="$2"; df="$3"
      if docker image inspect "$tag" >/dev/null 2>&1; then
        say "image $tag exists; keeping it (docker rmi $tag to force a rebuild)"
        return 0
      fi
      [ -d "$ctx" ] || die "build context $ctx is missing (point repo_root at the checkout, or set build_local=false)"
      say "building $tag"
      DOCKER_BUILDKIT=1 docker build -t "$tag" -f "$df" "$ctx"
    }

    if [ "$BUILD_LOCAL" = 1 ] && [ "$SKIP_IMAGE_BUILD" = 0 ]; then
    ${local.image_build_lines}
    fi

    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
      say "systemd units"
      for unit in "$BUNDLE_DIR"/systemd/*.service "$BUNDLE_DIR"/systemd/*.timer; do
        [ -e "$unit" ] || continue
        install -m 0644 "$unit" /etc/systemd/system/
      done
      systemctl daemon-reload
      # enable --now alone would leave an already-active oneshot unit untouched:
      # RemainAfterExit makes it "active", so a changed compose file would never
      # be converged. restart runs ExecStart again, which is the converge step.
      systemctl enable "$STACK_UNIT.service"
      systemctl restart "$STACK_UNIT.service"
      if [ "$EXTENDER_ENABLED" = 1 ]; then
        systemctl enable --now "$EXTENDER_UNIT.timer"
        systemctl restart "$EXTENDER_UNIT.timer"
      else
        # Turning the extender off must actually stop a timer that ran before.
        if [ -n "$EXTENDER_UNIT" ]; then
          systemctl disable --now "$EXTENDER_UNIT.timer" 2>/dev/null || true
        fi
      fi
    else
      say "no systemd here: converging the compose project directly"
      docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d --no-build
    fi

    say "state"
    docker compose -f "$INSTALL_DIR/docker-compose.yml" ps || true
    say "listener: tls_mode=$TLS_MODE site=$TLS_SITE, Grafana on loopback port $GRAFANA_HOST_PORT"
    SH

  # Everything an operator needs travels with the bundle, because once it lands
  # on a VM the repo checkout usually is not there.
  bundle_readme = trimspace(join("\n", compact(concat(
    [
      "# StreamPay observing stack (rendered bundle)",
      "",
      "Rendered by terraform from `infra/terraform/modules/vm`. Every file here is",
      "generated: change the stack variables, not this output.",
      "",
      "## One command",
      "",
      "```sh",
      "sudo sh install.sh",
      "```",
      "",
      "Re-running is safe: config is reinstalled, secret files are re-fetched, and",
      "`docker compose up -d` recreates only what changed.",
      "",
      "## What runs",
      "",
      "| service | image | listener | probe |",
      "| --- | --- | --- | --- |",
    ],
    [
      for svc in var.services :
      "| `${svc.name}` | `${svc.image}` | ${length(svc.ports) > 0 ? "port ${svc.ports[0].container}" : "none (poll loop)"} | ${svc.health_path != null ? "`${svc.health_path}`" : "no HTTP server"} |"
    ],
    [
      "",
      "| unit | control |",
      "| --- | --- |",
      "| `${local.stack_unit}.service` | whole stack: `systemctl {status,restart} ${local.stack_unit}` |",
    ],
    [
      for name in local.unit_names :
      "| `${name}.service` | one service: `systemctl restart ${name}` (the name docs/INCIDENT_RUNBOOK.md already uses) |"
    ],
    var.extender.enabled ? [
      "| `${var.extender.name}.timer` | funded TTL extension, `${var.extender_schedule}` |"
      ] : [
      "_TTL extender disabled (`runtime.sentinel_extender_enabled=false`): the sentinel only alerts._"
    ],
    [
      "",
      "## Secrets",
      "",
      "Strategy: **`${var.secrets.strategy}`**. Values are not in this directory,",
      "not in `terraform.tfstate`, and not in git.",
      "",
    ],
    [
      for name in sort(keys(var.secrets.threat_notes)) :
      "- **${name}** - ${var.secrets.threat_notes[name]}"
    ],
    [
      "",
      "Names the stack asks for: `${join("`, `", sort(var.secrets.secret_names))}`",
      "",
      "Delivered per service (0600 under `${var.config_dir}`), so the funded",
      "extender key never reaches the Grafana container:",
      "",
    ],
    [
      for k in sort(keys(var.secrets.secret_paths_by_service)) :
      "- `${var.secrets.secret_paths_by_service[k]}`"
    ],
    [
      "",
      "## TLS",
      "",
      "`tls_mode=${var.tls_mode}`, site `${local.site_address}`.",
      "",
      local.tls_explainer,
      "",
      "## Verify",
      "",
      "```sh",
      "docker compose -f ${var.install_dir}/docker-compose.yml ps",
      "docker compose -f ${var.install_dir}/docker-compose.yml logs --tail=50 ${lookup({ for s in var.services : s.key => s.name }, "indexer", "")}",
      "curl -sk https://127.0.0.1/ | head -20",
      "```",
      "",
      "## Re-apply and drift",
      "",
      "The bundle is content-hashed into the bootstrap trigger: Terraform re-runs",
      "`install.sh` only when a rendered file changes, and an apply after a",
      "converged one plans zero changes.",
    ],
    var.additional_notes != "" ? [
      "",
      var.additional_notes,
    ] : []
  ))))
}
