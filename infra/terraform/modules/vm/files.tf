# Bundle assembly and the idempotent apply.

locals {
  config_file_map = {
    "configs/prometheus/prometheus.yml" = {
      content = var.config_files["prometheus.yml"]
      mode    = "0644"
    }
    "configs/prometheus/rules/streampay-alerts.yml" = {
      content = var.config_files["prometheus-rules.yml"]
      mode    = "0644"
    }
    "configs/alertmanager/alertmanager.yml.tpl" = {
      content = var.config_files["alertmanager-template.yml"]
      mode    = "0644"
    }
    "configs/alertmanager/rewrite.sh" = {
      content = var.config_files["alertmanager-rewrite.sh"]
      mode    = "0755"
    }
    "configs/grafana/provisioning/datasources/datasource.yml" = {
      content = var.config_files["grafana-datasource.yml"]
      mode    = "0644"
    }
    "configs/grafana/provisioning/dashboards/provider.yml" = {
      content = var.config_files["grafana-provider.yml"]
      mode    = "0644"
    }
    "configs/grafana/dashboards/streampay-overview.json" = {
      content = var.config_files["grafana-dashboard.json"]
      mode    = "0644"
    }
    "configs/ttl-sentinel/ttl-sentinel.config.json" = {
      content = var.sentinel_config_json
      mode    = "0644"
    }
  }

  bundle_files_core = merge(
    {
      "docker-compose.yml" = {
        content = local.compose_yaml
        mode    = "0644"
      }
      "install.env" = {
        content = local.install_env
        mode    = "0644"
      }
      "install.sh" = {
        content = local.install_script
        mode    = "0755"
      }
      "fetch-secrets.sh" = {
        content = var.secrets.fetch_script
        mode    = "0755"
      }
      "README.md" = {
        content = local.bundle_readme
        mode    = "0644"
      }
    },
    local.config_file_map,
    var.tls_mode == "off" ? {} : {
      "Caddyfile" = {
        content = local.caddyfile
        mode    = "0644"
      }
    },
    var.secrets.vault_agent_config != null ? {
      "vault-agent.hcl" = {
        content = var.secrets.vault_agent_config
        mode    = "0644"
      }
    } : {},
    local.systemd_bundle
  )

  manifest_entries = [
    for path in sort(keys(local.bundle_files_core)) : {
      path   = path
      mode   = local.bundle_files_core[path].mode
      sha256 = sha256(local.bundle_files_core[path].content)
    }
  ]

  # Sorted by path so the manifest is byte-identical on every machine and diffs
  # in git the same way the rest of the bundle does.
  manifest_json = join("", [jsonencode(local.manifest_entries), "\n"])

  bundle_files = merge(
    local.bundle_files_core,
    {
      "manifest.json" = {
        content = local.manifest_json
        mode    = "0644"
      }
    }
  )

  # The apply trigger is the content of everything the bootstrap consumes, plus
  # the digests of the image sources. Nothing else re-runs install.sh, which is
  # what makes `terraform apply` twice in a row plan empty on the second pass.
  bundle_sha256 = sha256(join("|", concat(
    [
      for p in sort(keys(local.bundle_files)) :
      "${p}:${local.bundle_files[p].mode}:${sha256(local.bundle_files[p].content)}"
    ],
    [
      for k in sort(keys(var.image_build_digests)) :
      "image:${k}:${var.image_build_digests[k]}"
    ]
  )))

  compose_file   = "${var.install_dir}/docker-compose.yml"
  compose_prefix = "docker compose -f ${local.compose_file}"
}

resource "terraform_data" "preflight" {
  input = {
    strategy = var.secrets.strategy
    tls_mode = var.tls_mode
  }

  lifecycle {
    precondition {
      condition     = var.secrets.strategy != "k8s_secret"
      error_message = "secrets strategy k8s_secret belongs to stacks/kubernetes; the VM path needs a host-side delivery mechanism."
    }

    # install.sh and the compose mounts read the secret files from config_dir.
    # If the secrets module was pointed at a different directory the containers
    # would start with an empty environment and fail in confusing ways.
    precondition {
      condition = alltrue([
        for path in values(var.secrets.secret_paths_by_service) :
        substr(path, 0, length(var.config_dir)) == var.config_dir
      ])
      error_message = "Every secret path must live under config_dir (${var.config_dir}); pass the same install_dir to modules/secrets."
    }

    precondition {
      condition     = var.tls_mode != "acme" || (var.tls_domain != "" && var.tls_cert_file == "")
      error_message = "tls_mode=acme needs tls_domain (Let's Encrypt issues for names, not addresses) and must not set tls_cert_file."
    }

    precondition {
      condition     = var.tls_mode != "file" || (var.tls_cert_file != "" && var.tls_key_file != "")
      error_message = "tls_mode=file needs tls_cert_file and tls_key_file, both delivered by the secret mechanism."
    }

    # 0 means "do not publish this port on the host", so zeros may repeat.
    precondition {
      condition = length(distinct([
        for p in [var.grafana_host_port, var.prometheus_host_port, var.indexer_host_port] : p if p != 0
        ])) == length([
        for p in [var.grafana_host_port, var.prometheus_host_port, var.indexer_host_port] : p if p != 0
      ])
      error_message = "grafana_host_port, prometheus_host_port and indexer_host_port must differ; only 0 (unpublished) may repeat."
    }
  }
}

resource "local_file" "bundle" {
  for_each = local.bundle_files

  filename = "${var.bundle_dir}/${each.key}"
  content  = each.value.content

  # The `local` provider ignores this on Windows; set it false there if the
  # provider ever starts reporting permission drift on a dev workstation.
  file_permission = var.set_file_permissions ? each.value.mode : null
}

resource "null_resource" "bootstrap" {
  count = var.apply_locally ? 1 : 0

  # Content-addressed: a second apply with an unchanged bundle plans nothing,
  # which is the drift gate docs/DEPLOYMENT.md describes.
  triggers = {
    bundle_sha256 = local.bundle_sha256
  }

  depends_on = [local_file.bundle, terraform_data.preflight]

  provisioner "local-exec" {
    command = join(" ", coalescelist(var.bootstrap_command, ["/bin/sh", "${var.bundle_dir}/install.sh"]))
    quiet   = false
  }
}
