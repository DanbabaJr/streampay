#!/usr/bin/env node
/**
 * check_render.mjs — CI gate for the Terraform infra in this repo.
 *
 * Why this exists: the single-VM stack is the path a hobbyist runs, and it has to
 * be provably right on a machine that has no docker daemon, no cluster and no AWS
 * credentials. So this script reads the *rendered artifacts* and asserts the
 * properties that would otherwise only surface on the host at 3am:
 *
 *   --bundle <dir>    the rendered VM bundle (compose file, systemd units,
 *                     Caddyfile, config, manifest.json, install.sh)
 *   --manifests <f>   the rendered Kubernetes manifest stream
 *
 * It checks structure (does the document parse, do the references resolve),
 * hardening (cap_drop, no-new-privileges, loopback-only published ports, IMDS-style
 * least privilege), internal consistency (a scrape target names a service that
 * exists; a manifest entry hashes the file that is on disk), and the one policy
 * the issue makes non-negotiable: no plaintext secret value anywhere in the
 * rendered output.
 *
 * Usage:
 *   node infra/terraform/scripts/check_render.mjs \
 *     --bundle infra/terraform/stacks/minimal-single-vm/build \
 *     --manifests infra/terraform/stacks/kubernetes/build/manifests.yaml
 *
 * Exit 0 = every assertion held. Exit 1 = at least one failure, listed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const failures = [];
const notes = [];
const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const note = (text) => notes.push(text);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const readText = (file) => readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(readText(file));
const listFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// CI greps these messages on Linux and a developer runs them on Windows, so
// failure text always uses POSIX separators.
const show = (p) => p.split(sep).join('/');

// A YAML stream is a list of documents; k8s manifests are `---` separated and the
// compose file is a single document. parseAllDocuments keeps the per-document
// errors instead of throwing on the first one.
const parseYamlStream = (text, label) => {
  const docs = YAML.parseAllDocuments(text, { prettyErrors: true });
  for (const doc of docs) {
    for (const err of doc.errors) fail(`${label} yaml`, err.message);
  }
  return docs.map((d) => d.toJS()).filter((d) => d !== null && d !== undefined);
};

// ---------------------------------------------------------------------------
// Secret-leak scan (applies to every rendered text file, both platforms)
// ---------------------------------------------------------------------------

// Things that legitimately look like a secret in rendered config: an environment
// variable *name*, a compose/systemd substitution, an Alertmanager rewrite token,
// or a hash in the inventory. Anything else that matches is a leak.
const SAFE_VALUE = /^(?:\$\{?\w*[:]?\}?.*|@@[^@]+@@|\$[A-Z0-9_]+|)$/;
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|KEY)$/;
// Config that is *about* secrets but holds no secret: the delivery strategy, the
// file paths, the name inventory. A scan that flags these teaches people to ignore
// the scan.
const NOT_A_SECRET = /^(?:SECRETS?_(?:STRATEGY|SOURCE|PROVIDER|BACKEND|PATHS?|DIR|NAMES|KEY_NAMES|SECRET_NAMES)|SECRET_(?:PATHS?|NAMES|KEY_NAMES)|KMS_KEY_ARN)$/i;

function scanForPlaintextSecrets(file, text) {
  const rel = file.split(sep).join('/');
  if (rel.endsWith('manifest.json')) return; // sha256 inventory
  if (rel.endsWith('README.md')) return; // prose, and it quotes variable names

  // A Stellar secret seed (S + 55 base32 chars) and any PEM private key body are
  // leaks by definition, wherever they appear.
  const seed = text.match(/(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/);
  if (seed) fail('no-plaintext-secrets', `${rel} contains what looks like a secret key (${seed[0].slice(0, 4)}...)`);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    fail('no-plaintext-secrets', `${rel} contains a PEM private key`);
  }

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-?\s*([A-Za-z0-9_.:/-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY)[A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/i);
    if (!m) continue;
    if (NOT_A_SECRET.test(m[1])) continue;
    const raw = m[2].trim().replace(/^["']|["']$/g, '');
    if (raw === '' || SAFE_VALUE.test(raw)) continue;
    fail('no-plaintext-secrets', `${rel} assigns a literal value to ${m[1]}`);
  }
}

// ---------------------------------------------------------------------------
// In a Terraform template only "${" needs escaping (as "$${"), so a rendered
// script containing "$$(cmd)" or "$$VAR" is an over-escaped heredoc: the shell
// reads "$$" as the process id and the command silently becomes wrong. "sh -n"
// cannot see it, because it parses fine.
function checkTemplateEscapes(dir, files) {
  for (const file of files.filter((f) => f.endsWith('.sh'))) {
    const m = readText(file).match(/^.*\$\$(?:\(|[A-Za-z_]).*$/m);
    if (m) fail('template-escape', `${show(relative(dir, file))}: ${m[0].trim()} -- write a lone $ before ( or a name`);
  }
}

// Shell script sanity: `sh -n` is a real parser, and install.sh is the thing a
// hobbyist runs first.
// ---------------------------------------------------------------------------
function checkShellScripts(dir, files) {
  let sh = null;
  for (const candidate of ['sh', 'bash']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      sh = candidate;
      break;
    } catch {
      /* keep looking */
    }
  }
  if (sh === null) {
    note('no sh/bash on PATH: skipped script syntax checks (CI runs them)');
    return;
  }
  for (const file of files.filter((f) => f.endsWith('.sh'))) {
    // The shell on this platform is a POSIX shell even when Node's paths are
    // Windows-style, so hand it the forward-slash form of the same file.
    const forSh = file.split(sep).join('/');
    try {
      execFileSync(sh, ['-n', forSh], { stdio: 'ignore' });
    } catch (err) {
      fail('shell-syntax', `${show(relative(dir, file))} does not parse (${err.message.split('\n')[0]})`);
    }
    const text = readText(file);
    if (/#!\/bin\/(?:env )?sh/.test(text) && !text.includes('set -eu')) {
      fail('shell-hardening', `${show(relative(dir, file))} has no set -eu`);
    }
  }
}

// ---------------------------------------------------------------------------
// VM bundle
// ---------------------------------------------------------------------------
function checkBundle(dir) {
  if (!existsSync(dir)) {
    fail('bundle', `${dir} does not exist; run terraform apply for stacks/minimal-single-vm first`);
    return;
  }
  const files = listFiles(dir);
  const relPaths = files.map((f) => relative(dir, f).split(sep).join('/'));
  files.forEach((f) => scanForPlaintextSecrets(f, readText(f)));
  checkShellScripts(dir, files);
  checkTemplateEscapes(dir, files);

  // 1. The inventory: every file on disk is listed, and every listed hash matches.
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    fail('bundle-manifest', 'manifest.json is missing');
  } else {
    const entries = readJson(manifestFile);
    const listed = new Set(entries.map((e) => e.path));
    for (const entry of entries) {
      const p = join(dir, entry.path);
      if (!existsSync(p)) {
        fail('bundle-manifest', `${entry.path} is in the manifest but not on disk`);
        continue;
      }
      const actual = sha256(readFileSync(p));
      if (actual !== entry.sha256) fail('bundle-manifest', `${entry.path} sha256 mismatch`);
    }
    for (const rel of relPaths) {
      if (rel !== 'manifest.json' && !listed.has(rel)) {
        fail('bundle-manifest', `${rel} exists but is not in the manifest`);
      }
    }
    // Lowercase keeps a re-render on a case-insensitive filesystem from silently
    // duplicating an entry. Caddyfile and README.md are the two conventional
    // proper nouns a tool or a human expects to find spelled that way.
    const oddCase = entries.filter((e) => e.path !== e.path.toLowerCase() && !['Caddyfile', 'README.md'].includes(e.path));
    if (oddCase.length > 0) fail('bundle-manifest', `mixed-case bundle paths: ${oddCase.map((e) => e.path).join(', ')}`);
    if (entries.some((e) => e.path.includes('\\'))) fail('bundle-manifest', 'manifest paths must use POSIX separators');
    const sorted = [...entries].map((e) => e.path).join('\n');
    if (sorted !== entries.map((e) => e.path).sort().join('\n')) fail('bundle-manifest', 'manifest is not sorted; the diff a reviewer reads would churn');
  }

  // 2. install.env: what install.sh and this script both reason about.
  const envFile = join(dir, 'install.env');
  if (!existsSync(envFile)) {
    fail('bundle-env', 'install.env is missing');
    return;
  }
  const env = {};
  for (const line of readText(envFile).split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)="(.*)"$/);
    if (m) env[m[1]] = m[2];
  }
  for (const required of ['PROJECT', 'INSTALL_DIR', 'CONFIG_DIR', 'DATA_ROOT', 'SECRETS_STRATEGY', 'STACK_UNIT', 'TLS_MODE', 'UNIT_NAMES', 'BIND_KEYS', 'EXTENDER_ENABLED']) {
    if (!(required in env)) fail('bundle-env', `install.env is missing ${required}`);
  }

  // 3. Compose: structure plus the hardening the module promises.
  const composeFile = join(dir, 'docker-compose.yml');
  if (!existsSync(composeFile)) {
    fail('bundle-compose', 'docker-compose.yml is missing');
    return;
  }
  const [compose] = parseYamlStream(readText(composeFile), 'compose');
  const services = compose?.services ?? {};
  const names = Object.keys(services);
  if (names.length === 0) fail('bundle-compose', 'no services rendered');

  // The TLS terminator is the only container allowed to face the internet, and it
  // should only exist when TLS is on.
  const terminators = names.filter((n) => n.endsWith('-caddy'));
  if (env.TLS_MODE === 'off' && terminators.length > 0) fail('bundle-compose', 'TLS_MODE=off but a caddy service still terminates TLS');
  if (env.TLS_MODE !== 'off' && terminators.length !== 1) fail('bundle-compose', `TLS_MODE=${env.TLS_MODE} needs exactly one caddy service`);
  const tls_terminator = terminators[0] ?? null;

  for (const [name, svc] of Object.entries(services)) {
    if (svc.cap_drop === undefined) fail('bundle-compose', `${name} has no cap_drop`);
    else if (!svc.cap_drop.includes('ALL')) fail('bundle-compose', `${name} did not drop ALL capabilities`);
    if (!(svc.security_opt ?? []).includes('no-new-privileges:true')) fail('bundle-compose', `${name} allows new privileges`);
    if (!['unless-stopped', 'always'].includes(svc.restart)) fail('bundle-compose', `${name} restart policy is ${svc.restart}`);
    if (svc.init !== true) fail('bundle-compose', `${name} has no init, so a stopped container never reaps`);
    const logging = svc.logging ?? {};
    if (logging.driver !== 'json-file' || !logging.options?.['max-size']) fail('bundle-compose', `${name} logs are unbounded`);
    for (const port of svc.ports ?? []) {
      // Published ports are rendered as "127.0.0.1:HOST:CONTAINER"; a bare
      // "HOST:CONTAINER" means docker binds 0.0.0.0, which puts Grafana's
      // unauthenticated /api on a public interface. The TLS terminator is the
      // one documented exception: it exists to answer the internet on 80/443.
      if (name === tls_terminator) continue;
      if (!/^127\.0\.0\.1:/.test(String(port))) fail('bundle-compose', `${name} publishes ${port} on every interface`);
    }
    for (const envFileRef of svc.env_file ?? []) {
      const p = typeof envFileRef === 'string' ? envFileRef : envFileRef.path;
      if (!p.startsWith(`${env.CONFIG_DIR}/`) || !/-secrets-/.test(p)) {
        fail('bundle-compose', `${name} reads ${p}, outside the 0600 secret directory`);
      }
    }
    for (const [k, v] of Object.entries(svc.environment ?? {})) {
      if (SECRET_NAME.test(k) && !SAFE_VALUE.test(String(v ?? ''))) {
        fail('bundle-compose', `${name} sets ${k} to a literal value`);
      }
    }
    // A service with a health check must actually have a listener.
    if (svc.healthcheck && (svc.ports ?? []).length === 0 && !svc.network_mode) {
      // Internal-only services still health check via 127.0.0.1 inside the
      // container, which is what prometheus/alertmanager do here.
      if (!String(svc.healthcheck.test).includes('127.0.0.1')) fail('bundle-compose', `${name} healthcheck has no loopback target`);
    }
  }

  // UNIT_NAMES is what install.sh enables and what compose must therefore contain,
  // in both directions: a unit with no service never starts, and a service with no
  // unit is never enabled and never restarted on boot.
  const declared = (env.UNIT_NAMES ?? '').split(/\s+/).filter(Boolean).map((u) => u.replace(/\.service$/, ''));
  for (const unit of declared) {
    if (!names.includes(unit)) fail('bundle-compose', `${unit} is in UNIT_NAMES but has no compose service`);
  }
  for (const name of names) {
    if (!declared.includes(name)) fail('bundle-compose', `compose service ${name} is in no unit, so nothing starts it`);
  }

  // 4. systemd units.
  const unitDir = join(dir, 'systemd');
  const units = existsSync(unitDir) ? readdirSync(unitDir) : [];
  if (units.length === 0) fail('bundle-systemd', 'no units rendered');
  for (const unit of units) {
    const text = readText(join(unitDir, unit));
    if (!text.includes('[Unit]')) fail('bundle-systemd', `${unit} has no [Unit] section`);
    if (unit.endsWith('.service') && !text.includes('[Service]')) fail('bundle-systemd', `${unit} has no [Service] section`);
    if (unit.endsWith('.timer') && !/\[Timer\][\s\S]*OnCalendar=/.test(text)) fail('bundle-systemd', `${unit} has no OnCalendar`);
    if (unit.endsWith('.timer') && !text.includes('[Install]')) fail('bundle-systemd', `${unit} is not wanted by anything`);
    if (unit === `${env.STACK_UNIT}.service` && !text.includes('RemainAfterExit=yes')) fail('bundle-systemd', 'the stack unit must stay active after converge');
  }
  const extenderEnabled = env.EXTENDER_ENABLED === '1';
  const hasTimer = units.some((u) => u.endsWith('.timer'));
  if (extenderEnabled !== hasTimer) fail('bundle-systemd', `EXTENDER_ENABLED=${env.EXTENDER_ENABLED} but timer rendered=${hasTimer}`);

  // 5. Caddy: TLS is real, the admin endpoint is loopback, and nothing writes a key
  // into the file.
  const caddyFile = join(dir, 'Caddyfile');
  if (env.TLS_MODE !== 'off') {
    if (!existsSync(caddyFile)) fail('bundle-tls', `tls_mode=${env.TLS_MODE} but no Caddyfile`);
    else {
      const text = readText(caddyFile);
      if (/\badmin\s+(0\.0\.0\.0|[a-z]+:2019)\b/.test(text)) fail('bundle-tls', 'the Caddy admin endpoint is not on loopback; its /metrics is unauthenticated');
      const tlsModes = { acme: /\btls\s+[\w.@-]+\s+\{/, internal: /tls\s+internal/, file: /tls\s+\/etc\/streampay\/[^\s]+\s+\/etc\/streampay\/[^\s]+/, off: null };
      const expected = tlsModes[env.TLS_MODE];
      if (expected && !expected.test(text)) fail('bundle-tls', `tls_mode=${env.TLS_MODE} but the Caddyfile has no matching tls directive`);
      if (!/reverse_proxy/.test(text)) fail('bundle-tls', 'the listener proxies nothing');
    }
  } else if (existsSync(caddyFile)) {
    fail('bundle-tls', 'tls_mode=off still rendered a Caddyfile');
  }

  // 6. Prometheus: every streampay job target must be a compose service, and the
  // rule file it loads must be a file this bundle ships.
  const promFile = join(dir, 'configs/prometheus/prometheus.yml');
  if (existsSync(promFile)) {
    const prom = YAML.parse(readText(promFile));
    const jobs = prom?.scrape_configs ?? [];
    if (jobs.length === 0) fail('bundle-monitoring', 'prometheus.yml has no scrape jobs');
    for (const job of jobs) {
      for (const sc of job.static_configs ?? []) {
        for (const target of sc.targets ?? []) {
          const host = String(target).split(':')[0];
          if (!names.includes(host) && host !== 'localhost' && !host.includes('.')) {
            fail('bundle-monitoring', `job ${job.job_name} scrapes ${target}, which is not a compose service`);
          }
        }
      }
    }
    const rulesDir = join(dir, 'configs/prometheus/rules');
    const ruleFiles = existsSync(rulesDir) ? readdirSync(rulesDir) : [];
    for (const rf of prom?.rule_files ?? []) {
      const spec = String(rf);
      if (!spec.startsWith('/etc/prometheus/rules/')) {
        fail('bundle-monitoring', `rule_files points outside the mounted rules directory: ${spec}`);
        continue;
      }
      const rel = spec.slice('/etc/prometheus/rules/'.length);
      // A glob that matches nothing means Prometheus starts and records no rules,
      // so the alerts the operator thinks they have are not there.
      const matches = rel.includes('*')
        ? ruleFiles.filter((f) => /\.(ya?ml)$/.test(f))
        : ruleFiles.filter((f) => f === rel);
      if (matches.length === 0) fail('bundle-monitoring', `rule_files ${spec} matches no file in the bundle`);
    }
  } else {
    fail('bundle-monitoring', 'configs/prometheus/prometheus.yml is missing');
  }

  // 7. The secrets fetcher is the only thing in the bundle that touches values, so
  // it is checked for the properties the policy depends on: 077 umask, no value
  // ever printed, and one 0600 file per service.
  const fetchScript = join(dir, 'fetch-secrets.sh');
  if (!existsSync(fetchScript)) {
    fail('bundle-secrets', 'fetch-secrets.sh is missing');
  } else {
    const fetch = readText(fetchScript);
    if (!fetch.includes('set -eu')) fail('bundle-secrets', 'fetch-secrets.sh has no set -eu');
    if (!/umask 077/.test(fetch)) fail('bundle-secrets', 'fetch-secrets.sh does not umask 077, so a secret file could land world-readable');
    if (!/chmod 600|install -m 600/.test(fetch)) fail('bundle-secrets', 'fetch-secrets.sh never sets mode 600');
    // Echoing a value is a leak; writing one into the 0600 file (>>) or reporting
    // a failure on stderr is the whole job.
    const leaked = fetch.split(/\r?\n/).find((line) =>
      /^\s*(?:echo|printf)\b/.test(line) &&
      /\$(?:val|value|secret|secret_value)\b/.test(line) &&
      !(line.includes('>>') || line.includes('>&2')));
    if (leaked !== undefined) fail('bundle-secrets', `fetch-secrets.sh prints a secret value: ${leaked.trim()}`);
    for (const [name, svc] of Object.entries(services)) {
      const ref = (svc.env_file ?? [])[0];
      if (ref === undefined) continue;
      const path = typeof ref === 'string' ? ref : ref.path;
      if (!fetch.includes(path)) fail('bundle-secrets', `${name} reads ${path}, which the fetcher never writes`);
    }
  }

  // 8. Alertmanager: the template's tokens and the rewrite script must agree, since
  // a token that is never substituted ships a webhook URL as "@@foo@@".
  const tpl = join(dir, 'configs/alertmanager/alertmanager.yml.tpl');
  const rewrite = join(dir, 'configs/alertmanager/rewrite.sh');
  if (existsSync(tpl) && existsSync(rewrite)) {
    const tplText = readText(tpl);
    const tokens = [...new Set([...tplText.matchAll(/@@([A-Za-z0-9_-]+)@@/g)].map((m) => m[1]))];
    const rewriteText = readText(rewrite);
    const mapped = [...rewriteText.matchAll(/tok\[\d+\]="@@([A-Za-z0-9_-]+)@@";\s*env\[\d+\]="([A-Z0-9_]+)"/g)];
    for (const token of tokens) {
      if (!mapped.some((m) => m[1] === token)) fail('bundle-alerting', `template token @@${token}@@ is never substituted`);
    }
    for (const m of mapped) {
      if (!tokens.includes(m[1])) fail('bundle-alerting', `rewrite substitutes @@${m[1]}@@ but no receiver uses it`);
      // The URL a webhook receiver posts to is itself a credential, so it arrives
      // through the secret file and never as a literal in the template.
      if (!existsSync(fetchScript) || !readText(fetchScript).includes(m[2])) {
        fail('bundle-alerting', `${m[2]} is read by the rewrite script but delivered by no secrets strategy`);
      }
    }
    if (tokens.length === 0 && /webhook_configs/.test(tplText)) {
      fail('bundle-alerting', 'webhook receivers exist with no token, so alerts go nowhere');
    }
    // A route that names a missing receiver is a startup failure, not a warning.
    const am = YAML.parse(tplText);
    const receivers = new Set((am?.receivers ?? []).map((r) => r.name));
    const referenced = [am?.route?.receiver, ...(am?.route?.routes ?? []).map((r) => r.receiver)].filter(Boolean);
    for (const ref of referenced) {
      if (!receivers.has(ref)) fail('bundle-alerting', `route points at receiver ${ref}, which does not exist`);
    }
    if (receivers.size === 0) fail('bundle-alerting', 'alertmanager config ships no receivers');
  }

  // 9. Grafana provisioning and the dashboard must parse, and the datasource must
  // point at the service that exists.
  const ds = join(dir, 'configs/grafana/provisioning/datasources/datasource.yml');
  if (existsSync(ds)) {
    const parsed = YAML.parse(readText(ds));
    const url = parsed?.datasources?.[0]?.url ?? '';
    if (!names.includes(String(url).replace(/^https?:\/\//, '').split(':')[0])) fail('bundle-monitoring', `grafana datasource points at ${url}, which is not a compose service`);
  }
  const dash = join(dir, 'configs/grafana/dashboards/streampay-overview.json');
  if (existsSync(dash)) {
    const parsed = readJson(dash);
    if (!Array.isArray(parsed.panels) || parsed.panels.length === 0) fail('bundle-monitoring', 'the dashboard ships no panels');
    const json = JSON.stringify(parsed);
    if (!json.includes('streampay_')) fail('bundle-monitoring', 'the dashboard queries no streampay_* metric, so it will plot nothing');
  }

  // 10. Sentinel config: valid JSON, extender section consistent with the flags.
  const sentinel = join(dir, 'configs/ttl-sentinel/ttl-sentinel.config.json');
  if (existsSync(sentinel)) {
    const cfg = readJson(sentinel);
    if (!cfg.contractId && !cfg.contract_id) fail('bundle-config', 'sentinel config has no contract id');
    if (extenderEnabled) {
      const ext = cfg.extender ?? {};
      if (!ext.secretKeyEnv) fail('bundle-config', 'the extender is enabled but its secretKeyEnv is unset');
      if (/^S[A-Z2-7]{55}$/.test(String(ext.secret ?? ''))) fail('no-plaintext-secrets', 'sentinel config carries a funded key');
    }
  }

  console.log(`bundle: ${names.length} compose services, ${units.length} systemd units, ${relPaths.length} files`);
}

// ---------------------------------------------------------------------------
// Kubernetes manifests
// ---------------------------------------------------------------------------
function checkManifests(file) {
  if (!existsSync(file)) {
    fail('k8s', `${file} does not exist; run terraform apply for stacks/kubernetes first`);
    return;
  }
  const text = readText(file);
  scanForPlaintextSecrets(file, text);
  const docs = parseYamlStream(text, 'k8s manifests');
  if (docs.length === 0) fail('k8s', 'no documents rendered');

  // Null-valued keys: yamlencode writes them for unset attributes, and the API
  // server either ignores or rejects them depending on the field, so the module
  // must not emit any.
  const walk = (node, path) => {
    if (node === null) fail('k8s', `${path} is null; kubectl would apply an unset field`);
    else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (typeof node === 'object') Object.entries(node).forEach(([k, v]) => walk(v, `${path}.${k}`));
  };
  docs.forEach((d, i) => walk(d, `doc#${i}(${d.kind ?? '?'})`));

  const byKind = {};
  for (const d of docs) (byKind[d.kind] ??= []).push(d);
  const names = (list, pick) => (list ?? []).map((d) => pick(d));

  const services = names(byKind.Service, (s) => s.metadata.name);
  const configMaps = names(byKind.ConfigMap, (c) => c.metadata.name);
  const pvcs = names(byKind.PersistentVolumeClaim, (p) => p.metadata.name);
  const namespace = byKind.Namespace?.[0]?.metadata.name;

  // Scripts reach the cluster inside ConfigMaps, where no `sh -n` ever sees them,
  // so the Terraform over-escape artifact has to be caught as text.
  for (const cm of byKind.ConfigMap ?? []) {
    for (const [key, value] of Object.entries(cm.data ?? {})) {
      if (typeof value !== 'string' || !key.endsWith('.sh')) continue;
      const m = value.match(/^.*\$\$(?:\(|[A-Za-z_]).*$/m);
      if (m) fail('template-escape', `${cm.metadata.name}/${key}: ${m[0].trim()} -- write a lone $ before ( or a name`);
    }
  }

  // 1. Every in-cluster hostname the monitoring config scrapes must be a Service,
  // otherwise Prometheus is permanently DOWN and it looks like the chain is broken.
  const promCM = (byKind.ConfigMap ?? []).find((c) => c.metadata.name === 'streampay-prometheus-config');
  if (!promCM) fail('k8s', 'the prometheus config ConfigMap is missing');
  else {
    const prom = YAML.parse(promCM.data['prometheus.yml']);
    for (const job of prom.scrape_configs ?? []) {
      for (const sc of job.static_configs ?? []) {
        for (const target of sc.targets ?? []) {
          const host = String(target).split(':')[0];
          if (!services.includes(host)) fail('k8s', `scrape target ${target} names no Service in this namespace`);
        }
      }
    }
  }

  // 2. Workloads: references resolve, and the security posture holds.
  const podSpecs = [
    ...(byKind.Deployment ?? []).map((d) => ({ owner: d.metadata.name, spec: d.spec.template.spec, labels: d.spec.template.metadata?.labels ?? {} })),
    ...(byKind.CronJob ?? []).map((c) => ({ owner: c.metadata.name, spec: c.spec.jobTemplate.spec.template.spec, labels: c.spec.jobTemplate.spec.template.metadata?.labels ?? {} })),
  ];
  if (podSpecs.length === 0) fail('k8s', 'no workloads rendered');

  for (const { owner, spec } of podSpecs) {
    if (spec.automountServiceAccountToken !== false) fail('k8s', `${owner}: the pod would mount a service account token every container could read`);
    if (spec.serviceAccountName === undefined) fail('k8s', `${owner}: no serviceAccountName, so it uses the namespace default`);
    for (const vol of spec.volumes ?? []) {
      const sources = Object.keys(vol).filter((k) => k !== 'name');
      if (sources.length !== 1) fail('k8s', `${owner}: volume ${vol.name} declares ${sources.length} sources`);
      const src = sources[0];
      if (src === 'configMap') {
        if (!configMaps.includes(vol.configMap.name)) fail('k8s', `${owner}: configMap ${vol.configMap.name} is not in this stream`);
        const cm = (byKind.ConfigMap ?? []).find((c) => c.metadata.name === vol.configMap.name);
        for (const item of vol.configMap.items ?? []) {
          if (!(item.key in (cm?.data ?? {}))) fail('k8s', `${owner}: configMap ${cm?.metadata.name} has no key ${item.key}`);
        }
      }
      if (src === 'persistentVolumeClaim' && !pvcs.includes(vol.persistentVolumeClaim.claimName)) {
        fail('k8s', `${owner}: PVC ${vol.persistentVolumeClaim.claimName} is not in this stream`);
      }
    }
    for (const c of spec.containers ?? []) {
      for (const m of c.volumeMounts ?? []) {
        if (!(spec.volumes ?? []).some((v) => v.name === m.name)) fail('k8s', `${owner}/${c.name}: mounts ${m.name}, which is not a volume`);
        if (m.mountPath === undefined) fail('k8s', `${owner}/${c.name}: volumeMount without a path`);
      }
      const sc = c.securityContext ?? {};
      if (!(sc.capabilities?.drop ?? []).includes('ALL')) fail('k8s', `${owner}/${c.name}: does not drop ALL capabilities`);
      if (sc.allowPrivilegeEscalation !== false) fail('k8s', `${owner}/${c.name}: allows privilege escalation`);
      if (sc.runAsNonRoot !== true) fail('k8s', `${owner}/${c.name}: may run as root`);
      const rs = c.resources ?? {};
      if (!rs.requests?.cpu || !rs.requests?.memory) fail('k8s', `${owner}/${c.name}: no resource requests, so the scheduler can overcommit it into an OOM kill`);
      if (!c.image || /:latest$/.test(c.image)) fail('k8s', `${owner}/${c.name}: image ${c.image} is not pinned`);
      const inline = (c.env ?? []).filter((e) => SECRET_NAME.test(e.name ?? '') && e.value !== undefined && !SAFE_VALUE.test(String(e.value)));
      for (const e of inline) fail('k8s', `${owner}/${c.name}: env ${e.name} carries a literal value`);
    }
  }

  // 3. Secrets are referenced, never carried: the stream must contain no Secret
  // object with data, and every workload must use envFrom for its names.
  if ((byKind.Secret ?? []).length > 0) fail('k8s', 'the stream carries a Secret object; credentials are created out of band by design');
  const envFromNames = new Set(podSpecs.flatMap(({ spec }) => (spec.containers ?? []).flatMap((c) => (c.envFrom ?? []).map((e) => e.secretRef?.name).filter(Boolean))));
  for (const name of envFromNames) {
    if (!/^streampay-secrets-/.test(name)) fail('k8s', `envFrom references ${name}, outside the per-service prefix`);
  }

  // 4. CronJob: one submit at a time, and it must be the extender.
  for (const cj of byKind.CronJob ?? []) {
    if (cj.spec.concurrencyPolicy !== 'Forbid') fail('k8s', `${cj.metadata.name}: concurrencyPolicy must be Forbid (two funds double-pay one stream)`);
    if (!/^[0-9*\/,\s-]+$/.test(cj.spec.schedule)) fail('k8s', `${cj.metadata.name}: schedule ${cj.spec.schedule} is not five-field cron`);
    if (cj.spec.jobTemplate.spec.template.spec.restartPolicy !== 'Never') fail('k8s', `${cj.metadata.name}: a one-shot job must not restart in place`);
  }

  // 5. NetworkPolicy: default deny exists, and only the ingress controller reaches
  // the public workloads.
  const policies = byKind.NetworkPolicy ?? [];
  if (policies.length === 0) fail('k8s', 'no NetworkPolicy: the namespace accepts ingress from anywhere in the cluster');
  else if (!policies.some((p) => Object.keys(p.spec.podSelector?.matchLabels ?? {}).length === 0 && (p.spec.ingress ?? []).length === 0)) {
    fail('k8s', 'no default-deny ingress policy for the namespace');
  }
  for (const p of policies) {
    if ((p.spec.policyTypes ?? []).includes('Egress')) note('an egress policy exists; the module deliberately renders none -- see docs/DEPLOYMENT.md');
  }

  // 6. Ingress: backends exist, and TLS is on unless it was asked off.
  for (const ing of byKind.Ingress ?? []) {
    for (const rule of ing.spec.rules ?? []) {
      for (const path of rule.http?.paths ?? []) {
        if (!services.includes(path.backend.service.name)) fail('k8s', `ingress backend ${path.backend.service.name} is not a Service`);
      }
    }
    if ((ing.spec.tls ?? []).length === 0) fail('k8s', 'the public listener has no tls block');
    if (namespace) for (const doc of docs) if (doc.metadata?.namespace && doc.metadata.namespace !== namespace && doc.kind !== 'Namespace') fail('k8s', `${doc.kind}/${doc.metadata.name} is outside the rendered namespace`);
  }

  // 7. PVCs are accessModes RWO (SQLite WAL) and the workloads use Recreate.
  for (const pvc of byKind.PersistentVolumeClaim ?? []) {
    if ((pvc.spec.accessModes ?? []).includes('ReadWriteMany')) fail('k8s', `${pvc.metadata.name}: ReadWriteMany would let SQLite WAL corrupt on a shared filesystem`);
  }
  for (const dep of byKind.Deployment ?? []) {
    if (dep.spec.strategy?.type !== 'Recreate') fail('k8s', `${dep.metadata.name}: RollingUpdate on an RWO volume deadlocks the rollout`);
  }

  console.log(`manifests: ${docs.length} documents (${Object.entries(byKind).map(([k, v]) => `${k}:${v.length}`).join(' ')}), ${services.length} services, ${podSpecs.length} pod templates`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const bundleDir = flag('--bundle');
const manifestsFile = flag('--manifests');
if (!bundleDir && !manifestsFile) {
  console.error('usage: check_render.mjs [--bundle <dir>] [--manifests <manifests.yaml>]');
  process.exit(2);
}
if (bundleDir) checkBundle(bundleDir);
if (manifestsFile) checkManifests(manifestsFile);

for (const n of notes) console.log(`  note: ${n}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of [...new Set(failures)]) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('render checks passed');
