# Deploying the StreamPay stack

This document covers the infrastructure-as-code in
[`infra/terraform`](../infra/terraform/README.md): how to go from a bare machine
to a running indexer + reconciler + TTL sentinel with metrics, alerts, dashboards
and TLS, and how the same modules behave when you re-apply them.

The promise, tested in CI on every pull request:

* **one command per platform** renders the whole stack;
* **no plaintext secret** ever appears in git, in Terraform state, or in a
  rendered bundle file -- only secret *names* do;
* **re-applying converges**: `terraform plan` immediately after a successful
  `terraform apply` reports *no changes*.

## The two shapes, and why there are two

| | Single VM | Kubernetes |
| --- | --- | --- |
| For | one operator, one host, a hobbyist or a small org | a team that already runs a cluster |
| Stack | [stacks/minimal-single-vm](../infra/terraform/stacks/minimal-single-vm) | [stacks/kubernetes](../infra/terraform/stacks/kubernetes) |
| Renders | a bundle: `docker-compose.yml`, systemd units, `Caddyfile`, configs, `install.sh` | one `manifests.yaml`: Namespace, ServiceAccount, ConfigMaps, PVCs, Services, Deployments, NetworkPolicies, Ingress, CronJob |
| TLS | Caddy container (`tls_mode` = `acme`, `internal`, `file`, `off`) | your Ingress controller (`ingress_tls_mode` = `cert-manager`, `existing-secret`, `off`) |
| Secrets | per-service 0600 env files on the host (`env`, `file`, `ssm`, `vault`) | per-service `Secret` objects referenced by `envFrom` (`k8s_secret`) |
| Extender | a systemd timer | a CronJob with `concurrencyPolicy: Forbid` |
| Applied by | `install.sh` on the host | `kubectl apply -f`, or Terraform with `apply_with_kubectl = true` |

[stacks/aws-ec2](../infra/terraform/stacks/aws-ec2) is a third entry point: the
same VM bundle, but Terraform provisions the host (VPC wiring, instance profile,
encrypted data volume, S3 bundle bucket) and cloud-init runs that identical
`install.sh`. It exists so the org path does not fork the *software* story.

The modules split along the axis that keeps the hobbyist path small:

| Module | Owns | Knows about |
| --- | --- | --- |
| [modules/services](../infra/terraform/modules/services) | the catalogue: images, ports, env, health paths, alert rules, dashboards, secret *names* | nothing platform-specific |
| [modules/secrets](../infra/terraform/modules/secrets) | how values reach containers, and the fetch script for that mechanism | strategy, not crypto |
| [modules/vm](../infra/terraform/modules/vm) | compose + systemd + Caddy + `install.sh` bundle | Docker |
| [modules/k8s](../infra/terraform/modules/k8s) | manifests for the same workloads | Kubernetes |

`services` and `secrets` carry no provider, so `terraform validate` and the CI
render checks run with zero credentials. A hobbyist sets three variables
(`contract_id`, `network`, `tls_mode`); everything else has a working default.

## Prerequisites

* Terraform `>= 1.6.0, < 2.0.0`.
* Single VM: Linux with `docker` + the `docker compose` v2 plugin and `systemd`.
  Nothing else -- `install.sh` builds or pulls the images.
* Kubernetes: a cluster with a default StorageClass (or `storage_class_name`),
  an Ingress class, and `kubectl` logged in.
* AWS: credentials for the plan only. The *instance* needs no static credentials;
  it gets an instance profile.
* The Soroban contract id you are observing. It has no default on purpose: a
  wrong default indexes a chain nobody asked for and looks like a working stack.

## Path A -- one VM (the hobbyist path)

```sh
cd infra/terraform/stacks/minimal-single-vm
terraform init
terraform apply -var contract_id=CYOURCONTRACTID... -var apply_locally=true
```

`apply` writes the bundle to `build/` (override with `bundle_dir`) and, with
`apply_locally = true`, runs `install.sh` on the machine doing the apply. From
your own workstation instead, leave `apply_locally` false and ship the bundle:

```sh
scp -r build/ host:/tmp/streampay-bundle
ssh host 'sh /tmp/streampay-bundle/install.sh'
```

`install.sh` is idempotent by construction: every step is a copy, a `chmod`, a
re-fetch from the secret source, or a declarative `docker compose up` /
`systemctl` converge. Re-running it after a config change converges instead of
duplicating. It refuses to run as anything but root unless the data directories
are already writable by uid 1000 (the StreamPay images drop privileges), and it
writes the per-service secret files itself at mode 0600.

Reach the dashboards through a tunnel rather than a public port:

```sh
ssh -N -L 3000:127.0.0.1:3000 host   # Grafana
ssh -N -L 9090:127.0.0.1:9090 host   # Prometheus
```

Grafana is the only UI behind Caddy and does its own authentication. Prometheus
and Alertmanager are deliberately *not* proxied: Prometheus has no auth, so it
binds `admin_bind_address` (loopback by default) or nothing at all.

## Path B -- Kubernetes (the org path)

```sh
cd infra/terraform/stacks/kubernetes
terraform init
terraform apply \
  -var contract_id=CYOURCONTRACTID... \
  -var namespace=streampay \
  -var ingress_host=pay.example.org \
  -var extender_enabled=true
```

This renders `build/manifests.yaml` (override with `manifest_dir`). Nothing is
sent to the cluster unless you set `apply_with_kubectl = true` and `kubectl` is
on `PATH`; the default is to review and apply by hand:

```sh
kubectl apply -f build/manifests.yaml
kubectl -n streampay rollout status deployment/streampay-indexer --timeout=180s
```

Two invariants the manifests are checked against in CI:

* Every scrape target in the Prometheus ConfigMap names a `Service` that exists
  in the same namespace, and the Service object names are exactly the hostnames
  the `services` module emits (`streampay-indexer`, ...). A mismatch is a
  permanently DOWN target that looks like a chain problem.
* Data PVCs are `ReadWriteOnce` and the Deployments use `strategy: Recreate`.
  The indexer runs SQLite in WAL mode; a rolling update would schedule a second
  pod that cannot attach the volume and the rollout would block forever.

Secrets must exist before the pods start, or they start with an empty
environment. Terraform renders the `kubectl create secret` commands -- with
`${NAME:?}` guards so a missing value fails loudly rather than creating an empty
Secret -- never the values. The rendered README in the manifest directory has the
exact list.

## Path C -- AWS EC2

```sh
cd infra/terraform/stacks/aws-ec2
terraform init
terraform apply -var contract_id=CYOURCONTRACTID... -var secrets_strategy=ssm
```

The host's only credential is its instance profile, scoped to `s3:GetObject` on
the bundle prefix and `ssm:GetParameter` on the exact per-name ARNs -- not a
wildcard over the parameter path. With a customer-managed key, `kms:Decrypt` is
bounded by `kms:ViaService` and `kms:CallerAccount`. IMDSv2 is required with a
hop limit of 1, port 22 is not opened (use Session Manager,
`enable_session_manager`), and the ledger data lives on a separate encrypted gp3
volume attached with `stop_instance_before_detaching`, so replacing the instance
does not lose the index.

`user_data_replace_on_change` is what makes re-apply work: a changed bundle hash
replaces the instance rather than silently leaving the old one running.

## Choosing a secrets provider, with the tradeoff

No strategy puts a plaintext value in git, state, or a rendered file. They differ
in where the value *does* appear, and that is the threat model you are accepting:

| `secrets_strategy` | How | What you are now worried about |
| --- | --- | --- |
| `env` | `install.sh` reads its own environment and writes the 0600 per-service files | Nothing is stored server-side and rotation is one restart, but anyone who can read the host environment (root, `/proc/1/environ`, a debug sidecar) holds the funded extender key. Right for a VM you own; wrong for a shared cluster. |
| `file` | one operator-owned `KEY=VALUE` file (`operator_secret_file`), delivered by Ansible/SCP; Terraform audits its mode and key coverage on every apply | No cloud dependency, and the file is 0600 -- but plaintext sits on disk, and whatever delivers it has to carry the value somewhere. Terraform cannot see it change, so the fetch script audits mode and coverage instead. |
| `ssm` | parameters fetched at boot through the instance profile | Values never reach git, state or an image, and reads are CloudTrail-auditable with least-privilege per-path IAM. New blast radius: any process that can call `ssm:GetParameter` with this instance profile can exfiltrate, so scope the role to the exact ARNs -- and accept that an AWS outage blocks restarts. |
| `vault` | Vault Agent template config rendered here (or the `vault` CLI), handing off to the same 0600 files | Same no-plaintext property plus short-lived agent certs, lease rotation and one story across clouds. The tradeoff is availability: Vault must be reachable and unsealed for the stack to restart, and AppRole/Kubernetes auth is its own subsystem to secure. |
| `k8s_secret` | per-service `Secret` objects, referenced only by `envFrom` | Native and simple, but etcd keeps Secrets base64-encoded, not encrypted unless you enabled the encryption config: treat namespace `get-secret` as holding a funded key. Lock RBAC down, or graduate to sealed-secrets / external-secrets without touching this module's outputs. |

Three rules hold across all of them:

* **`strict_secret_names`** lists the names whose absence must fail the run (the
  funded extender key is the one that must never be missing-but-silent).
* **The webhook URLs are credentials.** A Slack/PagerDuty URL *is* a bearer
  token, so `alertmanager.yml` ships with `@@receiver@@` tokens and the container
  rewrites them into a 0600 file at start. The template stays committable.
* **The extender is a separate workload.** The funded key lives in the sentinel
  secret and nowhere else, and the timer/CronJob that reads it is not the process
  Grafana can see.

See [docs/THREAT_MODEL.md](THREAT_MODEL.md) for the chain-side view of the same
keys, and [docs/OPERATIONS.md](OPERATIONS.md) for rotation procedures.

## Idempotent re-apply, and how to prove it

Everything rendered is a pure function of module inputs: bundles are keyed by a
content hash (`bundle_sha256`) that is the *only* trigger for the bootstrap run,
so re-applying with no variable change does nothing at all -- Terraform reports
"No changes" and `install.sh` never re-runs.

Prove it with the script that CI also uses:

```sh
infra/terraform/scripts/apply_and_check_drift.sh --stack minimal-single-vm -- \
  -var contract_id=CYOURCONTRACTID... -var apply_locally=true \
  -var 'bootstrap_command=["sh","-c","echo rendered"]'
```

It applies, times it, then runs `terraform plan -detailed-exitcode` and exits 1
unless the plan is empty. Measured on a clean copy of this repository with an
empty state and the bootstrap command stubbed (CI has no Docker daemon), provider
download included:

| Stack | cold `init` | cold `apply` | `plan` after apply |
| --- | --- | --- | --- |
| `minimal-single-vm` | 13.8 s | 8.7 s | exit 0, "No changes" |
| `kubernetes` | 14.8 s | 6.5 s | exit 0, "No changes" |

A second apply of the same configuration converges in about 3 s, which is the
number that actually matters for re-apply: nothing is rewritten, so the bundle
hash is unchanged and `install.sh` does not run again.

The wall-clock from bare machine to observing stack is dominated by the image
build/pull inside `install.sh`, which is not measurable without a Docker daemon
and is not included above; say so out loud in the PR rather than quoting a number
you cannot reproduce.

Drift appears only when something outside Terraform edits what it owns. On the VM
that is a hand-edit under `/etc/streampay`; the bundle hash changes when the
rendered files change, so the next apply overwrites it -- copy your edit into the
module input instead. On Kubernetes, if your platform team injects annotations or
a sidecar, add them to `pod_annotations`/`ingress_annotations` rather than
fighting drift.

## What CI checks

`.github/workflows/infra.yml` gates every pull request that touches `infra/`:

1. `terraform fmt -check -recursive` and `terraform validate` for all three
   stacks, with no credentials.
2. The minimal path *renders for real*: `apply` with `apply_locally = true` and a
   stubbed bootstrap command, then `plan -detailed-exitcode` must be `0`.
3. `docker compose config` parses the rendered compose file.
4. [check_render.mjs](../infra/terraform/scripts/check_render.mjs) asserts the
   properties that would otherwise only surface at 3am: compose hardening
   (`cap_drop: ALL`, `no-new-privileges`, init, bounded logs, loopback-only
   published ports except the TLS terminator), manifest inventory hashes that
   match the files on disk, scrape targets that resolve to services that exist,
   Alertmanager tokens that the rewrite script substitutes, receiver names that
   exist, systemd unit/timer wiring that agrees with `install.env`, plus the
   structural Kubernetes checks (RWO + Recreate, no Secret objects, no
   automounted SA tokens, NetworkPolicy default-deny).
5. `sh -n` on every rendered script, `caddy validate` on the rendered Caddyfile,
   and `systemd-analyze verify` where the runner has systemd.
6. The no-plaintext scan: a Stellar secret seed (`S` + 55 base32), a PEM private
   key, or a literal value assigned to a `*SECRET*`/`*TOKEN*`/`*PASSWORD*` name
   anywhere in the rendered output fails the build.
7. Terraform state can never be committed (`*.tfstate*`, `.terraform/`, and
   `.tfvars` are ignored and double-checked by the job).

Run the same checks locally:

```sh
cd infra/terraform/stacks/minimal-single-vm && terraform apply -auto-approve \
  -var contract_id=C... -var apply_locally=true \
  -var 'bootstrap_command=["sh","-c","echo rendered"]'
node infra/terraform/scripts/check_render.mjs \
  --bundle infra/terraform/stacks/minimal-single-vm/build \
  --manifests infra/terraform/stacks/kubernetes/build/manifests.yaml
```

## Teardown

`terraform destroy` removes what Terraform created. On the VM path that means the
bundle, the rendered config and -- only if you pass `-var set_file_permissions`
consistently -- nothing under `data_root`: **the SQLite index and the alert
silences are operator data and are deliberately not destroyed by default.** Stop
the stack with `systemctl stop streampay-stack.service`, then remove the compose
project, volumes and config directories by hand so a mistake costs a resync
rather than the ledger history. On Kubernetes, deleting the namespace drops the
workloads but the PVCs survive a `kubectl delete -f manifests.yaml` unless you
delete them explicitly.

Upgrades, rollbacks and the frozen-contract path are covered in
[docs/UPGRADES.md](UPGRADES.md); day-2 operations in
[docs/OPERATIONS.md](OPERATIONS.md) and [docs/RUNBOOK.md](RUNBOOK.md).
