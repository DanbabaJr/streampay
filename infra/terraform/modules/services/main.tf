# StreamPay service configuration.
#
# Renders the full plain-config surface for the four workload services and the
# monitoring stack, for both deployment paths. Names are shared between the
# compose (single-VM) and Kubernetes renderings on purpose: `streampay-indexer`
# is both the compose service name and the k8s Service name, so the Prometheus
# scrape config below is valid in either topology without templating.

locals {
  network_defaults = {
    testnet = {
      rpc_url            = "https://soroban-testnet.stellar.org"
      horizon_url        = "https://horizon-testnet.stellar.org"
      network_passphrase = "Test SDF Network ; September 2015"
    }
    futurenet = {
      rpc_url            = "https://rpc-futurenet.stellar.org"
      horizon_url        = "https://horizon-futurenet.stellar.org"
      network_passphrase = "Test SDF Future Network ; October 2022"
    }
    mainnet = {
      rpc_url            = "https://soroban-rpc.stellar.org"
      horizon_url        = "https://horizon.stellar.org"
      network_passphrase = "Public Global Stellar Network ; September 2015"
    }
  }

  net = local.network_defaults[var.chain.network]

  chain = {
    network            = var.chain.network
    contract_id        = var.chain.contract_id
    rpc_url            = var.chain.rpc_url != "" ? var.chain.rpc_url : local.net.rpc_url
    horizon_url        = var.chain.horizon_url != "" ? var.chain.horizon_url : local.net.horizon_url
    network_passphrase = var.chain.network_passphrase != "" ? var.chain.network_passphrase : local.net.network_passphrase
  }

  # SQLite runs in WAL mode (indexer/src/store.ts), so the database file needs a
  # local filesystem: a bind mount on the VM, an RWO PVC in k8s. Never NFS/EFS.
  #
  # POSIX parent directory, computed with a regex rather than dirname(): dirname
  # uses the *host's* path separator, so rendering from Windows would emit
  # `\var\lib\streampay` into a container mount that only understands `/`.
  indexer_data_dir  = regex("(^/.*)/[^/]+$", var.runtime.indexer_database_path)[0]
  sentinel_data_dir = regex("(^/.*)/[^/]+$", var.runtime.sentinel_state_path)[0]

  indexer_env = merge(
    {
      RPC_URL          = local.chain.rpc_url
      CONTRACT_ID      = local.chain.contract_id
      POLL_INTERVAL_MS = tostring(var.runtime.indexer_poll_interval_ms)
      PORT             = tostring(var.runtime.indexer_port)
      DATABASE_PATH    = var.runtime.indexer_database_path
      RPC_MAX_RPS      = tostring(var.runtime.indexer_rpc_max_rps)
    },
    var.runtime.indexer_start_ledger != null ? { START_LEDGER = tostring(var.runtime.indexer_start_ledger) } : {},
    {
      for idx, url in var.runtime.indexer_rpc_fallbacks :
      "RPC_URL_FALLBACK_${idx + 1}" => url
    }
  )

  # The canonical reconciler (reconciler/src/index.js) is a poll loop: it has no
  # HTTP listener, so it gets no PORT and no probe on /health.
  reconciler_env = {
    HORIZON_URL           = local.chain.horizon_url
    SOROBAN_RPC_URL       = local.chain.rpc_url
    CONTRACT_ID           = local.chain.contract_id
    CONSISTENCY_WINDOW_MS = tostring(var.runtime.reconciler_consistency_window_ms)
    POLL_INTERVAL_MS      = tostring(var.runtime.reconciler_poll_interval_ms)
    LOG_LEVEL             = var.runtime.reconciler_log_level
    ENVIRONMENT           = local.chain.network
    RECONCILER_ID         = var.runtime.reconciler_id
    STREAM_IDS            = join(",", var.runtime.reconciler_stream_ids)
  }

  # Sentinel reads everything except these four names from its JSON config file
  # (infra/ttl-sentinel/src/config.ts:207-210). The webhook URL and the extender
  # secret key arrive through the env, never through the file.
  sentinel_env = {
    STREAMPAY_CONTRACT_ID   = local.chain.contract_id
    TTL_SENTINEL_RPC_URL    = local.chain.rpc_url
    TTL_SENTINEL_STATE_PATH = var.runtime.sentinel_state_path
  }

  # Thresholds mirror the cliff model in infra/ttl-sentinel/src/cliff.ts; a warn
  # level above a class cliff makes the scan refuse to run, so keep them below.
  sentinel_schedules = {
    stream   = { warnLedgers = 150000, critLedgers = 60000 }
    index    = { warnLedgers = 150000, critLedgers = 60000 }
    counter  = { warnLedgers = 3000, critLedgers = 1200 }
    instance = { warnLedgers = 3000, critLedgers = 1200 }
    code     = { warnLedgers = 3000, critLedgers = 1200 }
  }

  sentinel_config = {
    contractId              = local.chain.contract_id
    rpcUrl                  = local.chain.rpc_url
    networkPassphrase       = local.chain.network_passphrase
    scanIntervalSec         = var.runtime.sentinel_scan_interval_sec
    statePath               = var.runtime.sentinel_state_path
    alertsJsonlPath         = var.runtime.sentinel_alerts_jsonl_path
    webhookUrl              = ""
    monitorContractEntries  = true
    maxStreams              = var.runtime.sentinel_max_streams
    counterFallbackProbeRun = 200
    sorobanStateSizeBytes   = "0"
    reAlertEveryLedgers     = 8640
    schedules               = local.sentinel_schedules
    extender = {
      enabled          = var.runtime.sentinel_extender_enabled
      secretKeyEnv     = var.runtime.sentinel_extender_secret_env
      thresholdLedgers = var.runtime.sentinel_extender_threshold
      extendTo         = var.runtime.sentinel_extender_to
      maxEntriesPerTx  = var.runtime.sentinel_extender_max_entries_tx
      dryRun           = var.runtime.sentinel_extender_dry_run
      monthlyBudgetXlm = var.runtime.sentinel_extender_monthly_budget
    }
  }

  sentinel_config_json = jsonencode(local.sentinel_config)

  grafana_env = {
    GF_USERS_ALLOW_SIGN_UP                    = "false"
    GF_ANALYTICS_REPORTING_ENABLED            = "false"
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH = "/etc/grafana/provisioning/dashboards/streampay-overview.json"
  }

  # Uniform service records: every entry carries the same attributes so both
  # platform modules consume one typed list. `command` overrides the image
  # entrypoint (compose `entrypoint`, k8s `command`) and `args` are the
  # arguments handed to it -- see infra/docker/Dockerfile.* for the defaults.
  # Our three images set ENTRYPOINT ["node"], so their `args` start at the
  # script path and the interpreter is never repeated in two places.
  workload_services = concat(
    [
      {
        name         = "${var.namespace_prefix}-indexer"
        key          = "indexer"
        image        = var.images.indexer
        command      = []
        args         = ["dist/index.js"]
        env          = local.indexer_env
        secret_env   = lookup(var.container_env_passthrough, "indexer", [])
        ports        = [{ name = "http", container = var.runtime.indexer_port, expose = true }]
        health_path  = "/health"
        metrics_path = "/metrics"
        data_volume  = { mount = local.indexer_data_dir, name = "indexer-data" }
        log_volume   = true
        depends_on   = []
      }
    ],
    var.runtime.reconciler_enabled ? [
      {
        name         = "${var.namespace_prefix}-reconciler"
        key          = "reconciler"
        image        = var.images.reconciler
        command      = []
        args         = ["dist/index.js"]
        env          = local.reconciler_env
        secret_env   = lookup(var.container_env_passthrough, "reconciler", [])
        ports        = []
        health_path  = null
        metrics_path = null
        data_volume  = null
        log_volume   = true
        depends_on   = []
      }
    ] : [],
    var.runtime.sentinel_enabled ? [
      {
        name         = "${var.namespace_prefix}-sentinel"
        key          = "sentinel"
        image        = var.images.sentinel
        command      = []
        args         = ["dist/src/cli.js", "scan", "--config", "/etc/streampay/ttl-sentinel.config.json", "--watch"]
        env          = local.sentinel_env
        secret_env   = lookup(var.container_env_passthrough, "sentinel", [])
        ports        = []
        health_path  = null
        metrics_path = null
        # Alert state and the monthly spend meter live beside statePath, so the
        # whole directory must persist or the XLM budget silently resets.
        data_volume = { mount = local.sentinel_data_dir, name = "sentinel-data" }
        log_volume  = true
        depends_on  = []
      }
    ] : []
  )

  monitoring_services = [
    {
      name    = "${var.namespace_prefix}-prometheus"
      key     = "prometheus"
      image   = var.images.prometheus
      command = []
      args = [
        "--config.file=/etc/prometheus/prometheus.yml",
        "--storage.tsdb.path=/prometheus",
        "--storage.tsdb.retention.time=${var.runtime.prometheus_retention}",
      ]
      env          = {}
      secret_env   = []
      ports        = [{ name = "web", container = 9090, expose = false }]
      health_path  = "/-/healthy"
      metrics_path = "/metrics"
      data_volume  = { mount = "/prometheus", name = "prometheus-data" }
      log_volume   = false
      depends_on   = []
    },
    {
      # Receiver webhook URLs are credentials, so the container substitutes
      # them into its own config at start (see alertmanager_rewrite_script)
      # before exec'ing alertmanager. The busybox image has no envsubst, hence
      # the explicit shell entrypoint.
      name    = "${var.namespace_prefix}-alertmanager"
      key     = "alertmanager"
      image   = var.images.alertmanager
      command = ["/bin/sh", "-ec"]
      args = [
        "/etc/streampay/alertmanager-rewrite.sh && exec /bin/alertmanager --config.file=/etc/alertmanager/alertmanager.yml --storage.path=/alertmanager",
      ]
      env          = {}
      secret_env   = lookup(var.container_env_passthrough, "alertmanager", [])
      ports        = [{ name = "web", container = 9093, expose = false }]
      health_path  = "/-/healthy"
      metrics_path = "/metrics"
      data_volume  = { mount = "/alertmanager", name = "alertmanager-data" }
      log_volume   = false
      depends_on   = []
    },
    {
      name         = "${var.namespace_prefix}-grafana"
      key          = "grafana"
      image        = var.images.grafana
      command      = []
      args         = []
      env          = local.grafana_env
      secret_env   = lookup(var.container_env_passthrough, "grafana", [])
      ports        = [{ name = "http", container = 3000, expose = true }]
      health_path  = "/api/health"
      metrics_path = "/metrics"
      data_volume  = { mount = "/var/lib/grafana", name = "grafana-data" }
      log_volume   = false
      depends_on   = ["${var.namespace_prefix}-prometheus"]
    }
  ]

  all_services = concat(local.workload_services, local.monitoring_services)

  # One-shot TTL extender: `cli.js extend` has no --watch loop (cli.ts:266 only
  # loops for scan), so it belongs on a timer / CronJob, and only when enabled.
  extender = {
    enabled = var.runtime.sentinel_extender_enabled
    name    = "${var.namespace_prefix}-sentinel-extend"
    image   = var.images.sentinel
    command = []
    # --execute is appended only when dry-run is off, so a mistyped flag can
    # never silently start spending a funded key.
    args = concat(
      ["dist/src/cli.js", "extend", "--config", "/etc/streampay/ttl-sentinel.config.json"],
      var.runtime.sentinel_extender_dry_run ? [] : ["--execute"]
    )
    env        = local.sentinel_env
    secret_env = lookup(var.container_env_passthrough, "sentinel", [])
  }
}
