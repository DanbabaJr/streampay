#!/bin/sh
# apply_and_check_drift.sh -- the two claims the issue asks for, measured:
#
#   1. time from "this directory has only .tf files in it" to "the stack is
#      rendered and applied" (the apply-to-zero-output demo);
#   2. `terraform plan` immediately after an apply reports NO changes, which is
#      the definition of idempotent re-apply.
#
# Run it against a stack with whatever -var arguments that stack needs:
#
#   infra/terraform/scripts/apply_and_check_drift.sh \
#     --stack minimal-single-vm \
#     -- -var contract_id=C... -var apply_locally=true \
#        -var 'bootstrap_command=["sh","-c","echo rendered"]'
#
# Everything before `--` configures this script; everything after it is handed to
# terraform verbatim, so the same invocation works for stacks/minimal-single-vm
# (which writes a bundle) and stacks/kubernetes (which writes manifests).
#
# Exit codes: 0 converged and no drift; 1 plan after apply showed changes;
# 2 the apply itself failed. Nothing is destroyed on failure -- re-running
# converges, that is the point.
set -eu

stack=""
mode="apply"
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) stack="${2:-}"; shift 2 ;;
    --plan-only) mode="plan"; shift ;;
    --) shift; break ;;
    *) printf 'usage: %s --stack <name> [--plan-only] -- [terraform args...]\n' "$0" >&2; exit 2 ;;
  esac
done

[ -n "$stack" ] || { echo "--stack is required" >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
stack_dir="$repo_root/infra/terraform/stacks/$stack"
[ -d "$stack_dir" ] || { echo "no such stack: $stack_dir" >&2; exit 2; }

cd "$stack_dir"

if [ ! -d .terraform ]; then
  echo "==> terraform init ($stack)"
  terraform init -input=false -no-color
fi

echo "==> terraform apply ($stack)"
started=$(date +%s)
if ! terraform apply -auto-approve -input=false -no-color "$@"; then
  echo "apply failed; nothing was measured" >&2
  exit 2
fi
elapsed=$(( $(date +%s) - started ))

echo
echo "==> plan after apply (must be empty)"
# -detailed-exitcode: 0 = no changes, 1 = errored, 2 = changes planned. Anything
# but 0 means the module is not converge-safe, so a second apply would churn.
set +e
plan_out=$(terraform plan -detailed-exitcode -input=false -no-color "$@" 2>&1)
plan_code=$?
set -e

printf '%s\n' "$plan_out" | tail -n 20

if [ "$plan_code" -ne 0 ]; then
  echo
  echo "DRIFT: plan after apply exited $plan_code. The stack is not idempotent." >&2
  echo "Re-running apply would change something it just wrote; find the field in" >&2
  echo "the plan output above and make the module agree with what it applied." >&2
  exit 1
fi

echo
echo "converged in ${elapsed}s, plan after apply reported no changes."
