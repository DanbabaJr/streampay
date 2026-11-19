#!/bin/sh
# plan_gate.sh — the credential-free, plan-only Terraform gate.
#
# What one run proves about infra/terraform:
#
#   1. `terraform fmt -check -recursive` passes.
#   2. Every stack initializes with `-backend=false` and passes
#      `terraform validate` — no provider credentials, no state backend.
#   3. The two stacks that render without a cloud API — minimal-single-vm and
#      kubernetes — produce a clean `terraform plan` from the fixture at
#      stacks/<stack>/fixtures/ci-plan.tfvars.json, with `-input=false` so a
#      missing value is an error instead of a prompt.
#   4. Nothing is applied and no remote backend is used. `terraform plan`
#      against the implicit local backend reads no state file and writes none;
#      the gate also refuses a tree that declares a remote backend.
#
# `--self-test` runs step 3 again with stacks/minimal-single-vm/fixtures/
# ci-plan-invalid.tfvars.json and requires the plan to fail on the variable
# validation blocks. A gate that cannot fail is green forever, so the self-test
# asserts both the failure and the two specific validation messages.
#
# stacks/aws-ec2 is validate-only here on purpose: its plan reads
# aws_caller_identity, aws_availability_zones, aws_subnet and aws_ami, which are
# live AWS API calls. The existing `infra` workflow still exercises that stack
# with `terraform validate`; it is the only stack whose apply needs credentials.
#
# Usage:
#   sh infra/terraform/scripts/plan_gate.sh              # gate + version check
#   sh infra/terraform/scripts/plan_gate.sh --self-test  # prove the gate can fail
#
# The Terraform version is pinned in digests/terraform-<version>.sha256 and the
# gate refuses to run under any other version. Nothing here downloads a
# provider or talks to a cloud API.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tf_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)

mode="gate"
case "${1:-}" in
  "") ;;
  --self-test) mode="self-test" ;;
  *)
    printf 'usage: %s [--self-test]\n' "$0" >&2
    exit 2
    ;;
esac

say() { printf '\n==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v terraform >/dev/null 2>&1 || fail "terraform is not on PATH"

# --- Version pin ---------------------------------------------------------------
# digests/ is how this repo pins every external tool (stellar-cli, wabt,
# binaryen). The pin's file name is the version; the digest inside is the
# release archive CI's setup action installs.
pin_file=$(ls "$repo_root"/digests/terraform-*.sha256 2>/dev/null | head -n 1 || true)
[ -n "$pin_file" ] || fail "no digests/terraform-*.sha256 pin found"
pinned_version=$(basename "$pin_file" | sed -e 's/^terraform-//' -e 's/\.sha256$//')
actual_version=$(terraform version | sed -n '1s/^Terraform v//p')

if [ "$actual_version" != "$pinned_version" ]; then
  fail "terraform $actual_version does not match the pinned $pinned_version ($pin_file)"
fi
say "Terraform $actual_version (pin: digests/$(basename "$pin_file"))"
sed 's/^/    /' "$pin_file"

# --- Read-only construction ----------------------------------------------------
# A remote backend would let a plan read (and in some configurations write)
# shared state. This gate is read-only by construction, so a stack that gains
# one has to change this script deliberately rather than silently.
if find "$tf_root" -name '*.tf' -type f -exec grep -nHE '^[[:space:]]*backend[[:space:]]+"' {} + >/tmp/plan_gate_backends.$$ 2>/dev/null; then
  sed 's/^/    /' /tmp/plan_gate_backends.$$
  rm -f /tmp/plan_gate_backends.$$
  fail "a remote Terraform backend is declared; the plan gate must stay local-only"
fi
rm -f /tmp/plan_gate_backends.$$

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT INT TERM

# --- Step 1: formatting --------------------------------------------------------
if [ "$mode" = "gate" ]; then
  say "terraform fmt -check -recursive"
  ( cd "$tf_root" && terraform fmt -check -recursive -no-color )
fi

# --- Step 2: init (no backend) + validate for every stack ----------------------
for stack in minimal-single-vm kubernetes aws-ec2; do
  say "terraform validate ($stack, -backend=false)"
  (
    cd "$tf_root/stacks/$stack"
    terraform init -backend=false -input=false -no-color >/dev/null
    terraform validate -no-color
  )
done

# --- Step 3: plan from a fixture, never apply ----------------------------------
plan_with() {
  stack=$1
  fixture=$2
  log=$3
  (
    cd "$tf_root/stacks/$stack"
    terraform init -backend=false -input=false -no-color >/dev/null
    # -refresh=false: the plan is built from configuration and the fixture only,
    # so there is no state read and no provider API call to refresh.
    # -lock=false: nothing here can contend for a lock because no state exists.
    terraform plan -input=false -refresh=false -lock=false -no-color \
      -var-file="$fixture"
  ) >"$log" 2>&1
}

plan_stack() {
  stack=$1
  fixture=$2
  say "terraform plan ($stack, fixture $(basename "$fixture"))"
  if plan_with "$stack" "$fixture" "$work_dir/$stack.log"; then
    tail -n 4 "$work_dir/$stack.log" | sed 's/^/    /'
    grep -q 'No changes\.\|Plan:' "$work_dir/$stack.log" ||
      fail "plan for $stack produced neither a plan summary nor 'No changes.'"
  else
    cat "$work_dir/$stack.log" >&2
    fail "terraform plan failed for $stack"
  fi
}

if [ "$mode" = "gate" ]; then
  plan_stack minimal-single-vm "$tf_root/stacks/minimal-single-vm/fixtures/ci-plan.tfvars.json"
  plan_stack kubernetes "$tf_root/stacks/kubernetes/fixtures/ci-plan.tfvars.json"
  printf '\nplan-only gate passed: fmt, validate and plan with no credentials, no apply, no backend.\n'
  exit 0
fi

# --- Step 4: self-test ---------------------------------------------------------
say "self-test: the invalid fixture must be rejected by variable validation"
if plan_with minimal-single-vm \
    "$tf_root/stacks/minimal-single-vm/fixtures/ci-plan-invalid.tfvars.json" \
    "$work_dir/invalid.log"; then
  cat "$work_dir/invalid.log" >&2
  fail "the deliberately invalid fixture planned cleanly, so the gate cannot fail"
fi

for expected in extender_to_ledgers grafana_host_port install_dir; do
  if ! grep -q "$expected" "$work_dir/invalid.log"; then
    cat "$work_dir/invalid.log" >&2
    fail "the invalid fixture failed, but not on the '$expected' validation block"
  fi
done
grep -E 'Invalid value for variable|must be' "$work_dir/invalid.log" | head -n 12 | sed 's/^/    /'
printf '\nself-test passed: the invalid fixture fails on the variable validation blocks.\n'
