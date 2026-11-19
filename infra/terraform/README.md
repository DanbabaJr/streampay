# `infra/terraform`

Infrastructure as code for the StreamPay observing stack: indexer, reconciler,
TTL sentinel, Prometheus, Alertmanager, Grafana and the TLS listener in front of
Grafana.

The long form -- module split rationale, the secrets provider choice with its
threat tradeoff, TLS modes, the drift/idempotency story and the measured timings
-- is [../../docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md). This file is the map.

## Layout

```
modules/
  services/   the catalogue: images, ports, env, health paths, alert rules,
              dashboards, secret NAMES. No provider, no platform knowledge.
  secrets/    how values reach containers: env | file | ssm | vault | k8s_secret,
              plus the generated fetch-secrets.sh. Names only, never values.
  vm/         renders the single-host bundle: docker-compose.yml, systemd units,
              Caddyfile, configs, install.sh, manifest.json.
  k8s/        renders the cluster story as one manifest stream.
stacks/
  minimal-single-vm/  the hobbyist path. local + null providers only, so it
                      renders and validates with no credentials anywhere.
  kubernetes/         the org path. Renders manifests.yaml; talks to a cluster
                      only if you set apply_with_kubectl.
  aws-ec2/            the same VM bundle on a provisioned host: instance
                      profile, encrypted data volume, S3 bundle bucket,
                      cloud-init that runs that identical install.sh.
scripts/
  check_render.mjs          the CI structural gate. Reads the rendered artifacts
                            and asserts hardening, reference resolution and the
                            no-plaintext policy.
  apply_and_check_drift.sh  apply, time it, then fail unless plan is empty.
```

`modules/services` reads the Grafana dashboard and Prometheus rules from
`infra/observability`, so the Terraform tree is not self-contained: run it from a
full repository checkout, which is what CI does.

## Fastest path

```sh
cd stacks/minimal-single-vm
terraform init
terraform apply -var contract_id=CYOURCONTRACTID... -var apply_locally=true
```

That writes the bundle to `build/` and runs `install.sh` here. On a different
machine, leave `apply_locally = false`, `scp -r build/ host:/tmp/`, and run
`sh /tmp/build/install.sh` there. Re-running either form converges; it does not
duplicate.

## Checking your change before you push

```sh
terraform fmt -check -recursive
cd stacks/minimal-single-vm && terraform validate

# render for real, with the bootstrap stubbed (no docker needed)
terraform apply -auto-approve -input=false \
  -var contract_id=C... -var apply_locally=true \
  -var 'bootstrap_command=["sh","-c","echo rendered"]'

# and the gate CI runs
node ../../scripts/check_render.mjs \
  --bundle build --manifests ../kubernetes/build/manifests.yaml
```

`check_render.mjs` needs one dependency: `npm ci` in `scripts/` (it parses the
compose file and the manifest stream as YAML rather than grepping them).

Read the failures rather than the pass line: the checks exist because each one
describes a way the stack fails at 3am on a host you are not looking at -- a
scrape target that names no service, a route that points at a receiver that does
not exist, a `$$` that Terraform left in a shell script so the shell reads it as
a process id.

## Ground rules

* No plaintext secret in a rendered file, in state, or in git. Secret *names*
  travel through Terraform; values come from the strategy you chose.
* Every published port is loopback-bound except the TLS terminator's 80/443.
* `terraform plan` after a successful apply must be empty. If it is not, the
  module disagrees with what it wrote; fix the module, not the state.
* State files, `.terraform/` and `*.tfvars` are ignored. Never commit them.
