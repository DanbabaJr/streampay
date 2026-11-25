#!/bin/sh
set -eu

source_script="${1:?usage: plan_gate_isolation_test.sh /path/to/plan_gate.sh}"
test_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
pin_file=$(ls "$test_root"/digests/terraform-*.sha256 | head -n 1)
version=$(basename "$pin_file" | sed -e 's/^terraform-//' -e 's/\.sha256$//')
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

mkdir -p "$tmp/bin" "$tmp/digests" "$tmp/infra/terraform/scripts" \
  "$tmp/infra/terraform/stacks/minimal-single-vm/fixtures" \
  "$tmp/infra/terraform/stacks/kubernetes/fixtures" \
  "$tmp/infra/terraform/stacks/aws-ec2" "$tmp/infra/docker" "$tmp/infra/observability"
cp "$source_script" "$tmp/infra/terraform/scripts/plan_gate.sh"
cp "$pin_file" "$tmp/digests/"
for stack in minimal-single-vm kubernetes aws-ec2; do
  printf '# fixture\n' > "$tmp/infra/terraform/stacks/$stack/main.tf"
done
printf '{}\n' > "$tmp/infra/terraform/stacks/minimal-single-vm/fixtures/ci-plan.tfvars.json"
printf '{}\n' > "$tmp/infra/terraform/stacks/minimal-single-vm/fixtures/ci-plan-invalid.tfvars.json"
printf '{}\n' > "$tmp/infra/terraform/stacks/kubernetes/fixtures/ci-plan.tfvars.json"
printf 'FROM scratch\n' > "$tmp/infra/docker/Dockerfile.indexer"
printf 'fixture\n' > "$tmp/infra/observability/fixture.yml"
printf 'inherited-state-sentinel\n' > "$tmp/infra/terraform/stacks/minimal-single-vm/terraform.tfstate"
printf 'inherited-state-sentinel\n' > "$tmp/infra/terraform/stacks/kubernetes/terraform.tfstate.backup"
mkdir -p "$tmp/infra/terraform/stacks/minimal-single-vm/.terraform"
printf 'inherited-provider-sentinel\n' > "$tmp/infra/terraform/stacks/minimal-single-vm/.terraform/inherited"

cat > "$tmp/bin/terraform" <<'STUB'
#!/bin/sh
set -eu
case "${1:-}" in
  version)
    printf 'Terraform v%s\n' "$TEST_TF_VERSION"
    ;;
  fmt|validate)
    exit 0
    ;;
  init)
    if [ -e .terraform/inherited ]; then
      echo "inherited provider cache reached terraform init" >&2
      exit 91
    fi
    mkdir -p .terraform
    ;;
  plan)
    if [ -e terraform.tfstate ] || [ -e terraform.tfstate.backup ]; then
      echo "inherited Terraform state reached terraform plan" >&2
      exit 92
    fi
    case "$*" in
      *ci-plan-invalid.tfvars.json*)
        printf 'Error: Invalid value for variable\ninstall_dir must be an absolute path\n'
        printf 'grafana_host_port must be between 1 and 65535\n'
        printf 'extender_to_ledgers must be greater than extender_threshold_ledgers\n'
        exit 1
        ;;
    esac
    printf 'Plan: 1 to add, 0 to change, 0 to destroy.\n'
    ;;
  *)
    echo "unexpected terraform invocation: $*" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$tmp/bin/terraform"

PATH="$tmp/bin:$PATH" TEST_TF_VERSION="$version" \
  sh "$tmp/infra/terraform/scripts/plan_gate.sh" > "$tmp/gate.log" 2>&1 || {
    cat "$tmp/gate.log" >&2
    exit 1
  }

grep -q '^inherited-state-sentinel$' "$tmp/infra/terraform/stacks/minimal-single-vm/terraform.tfstate"
grep -q '^inherited-state-sentinel$' "$tmp/infra/terraform/stacks/kubernetes/terraform.tfstate.backup"
grep -q '^inherited-provider-sentinel$' "$tmp/infra/terraform/stacks/minimal-single-vm/.terraform/inherited"
printf 'plan gate isolation self-test passed: source state and provider cache were neither read nor changed.\n'
