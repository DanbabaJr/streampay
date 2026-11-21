#!/usr/bin/env bash
# Reproducibility harness: build the contract Wasm TWICE from the same commit
# inside the pinned hermetic toolchain and prove the two builds are
# byte-identical — the Wasm AND the extracted spec/interface JSON.
#
# Two independent trees, two independent containers, no shared cargo cache: a
# warm cache or a leftover target/ would make the second build a no-op and turn
# this gate into a tautology. When the builds drift, the report names the
# component that is not deterministic instead of just printing two hashes.
#
# Usage:
#   scripts/reproducible_build.sh [--ref <git-ref>] [--out <dir>] [--native]
#
# Options:
#   --ref <ref>    commit/tag to build twice (default: HEAD)
#   --out <dir>    report directory (default: <repo>/evidence/repro)
#   --native       build on the host instead of in Docker (NOT hermetic)
#
# Environment:
#   STELLAR_CLI_VERSION   override the pinned stellar-cli (default: the ARG in
#                         .github/actions/verify-reproducible-build/Dockerfile)
#
# Writes:
#   <out>/repro-result.env   KEY=VALUE, consumed by scripts/attest.sh
#   <out>/repro-report.md    the human-readable report
#
# Exit status: 0 when both builds are byte-identical, 1 on any drift.
. "$(dirname "$0")/attestation_lib.sh"

ref="HEAD"
out="$REPO_ROOT/evidence/repro"
use_docker=1

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)    ref="${2:?--ref requires a git ref}"; shift 2 ;;
    --out)    out="${2:?--out requires a dir}"; shift 2 ;;
    --native) use_docker=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

ACTION_DIR="$REPO_ROOT/.github/actions/verify-reproducible-build"
dockerfile="$ACTION_DIR/Dockerfile"
rust_channel="$(sed -nE 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
  "$REPO_ROOT/rust-toolchain.toml" | head -n1 || true)"
stellar_cli="${STELLAR_CLI_VERSION:-$(sed -nE 's/^ARG STELLAR_CLI_VERSION=(.*)$/\1/p' "$dockerfile" | head -n1 || true)}"
build_cmd="cd contracts/streaming-payments && stellar contract build"

[ -n "$rust_channel" ] || die "could not read the pinned channel from rust-toolchain.toml"
[ -n "$stellar_cli" ]  || die "could not read the pinned stellar-cli version from $dockerfile"

mkdir -p "$out"
result="$out/repro-result.env"
report="$out/repro-report.md"
rm -f "$result" "$report"

say "Reproducibility harness — two builds from $ref"
info "rust channel   : $rust_channel"
info "stellar-cli    : $stellar_cli"
info "build command  : $build_cmd"
info "mode           : $([ "$use_docker" = 1 ] && echo 'hermetic (docker)' || echo 'NATIVE (not hermetic)')"

# ------------------------------------------------------------- source material
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

commit="$(git -C "$REPO_ROOT" rev-parse "$ref" 2>/dev/null)" \
  || die "not a git revision: $ref"
if ! git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null; then
  warn "the working tree is dirty — building the COMMITTED source at $ref, not your edits"
fi

for side in a b; do
  mkdir -p "$work/$side"
  # git archive gives the exact committed tree: no target/, no editor droppings,
  # no .git, and identical bytes on both sides by construction.
  git -C "$REPO_ROOT" archive "$commit" | tar -x -C "$work/$side" \
    || die "git archive $commit failed"
done

# ------------------------------------------------------------------ build twice
if [ "$use_docker" = 1 ]; then
  require docker
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable (pass --native to build on the host)"
  [ -f "$dockerfile" ] || die "hermetic Dockerfile not found: $dockerfile"

  image="streampay-repro:${commit:0:12}"
  say "Building the hermetic image $image"
  docker build --quiet \
    --build-arg "RUST_VERSION=$rust_channel" \
    --build-arg "STELLAR_CLI_VERSION=$stellar_cli" \
    -t "$image" "$ACTION_DIR" >/dev/null \
    || die "docker build of the hermetic image failed"

  for side in a b; do
    say "Build $side of 2 (cold container, cold cargo cache)"
    # --entrypoint is set explicitly: the image's ENTRYPOINT is `bash -c`, so
    # passing `bash -c ...` as the command would nest and silently do nothing.
    # Network stays up because cargo has to reach crates.io; that does not weaken
    # the result — Cargo.lock pins every version and cargo rejects any crate
    # whose checksum differs from the locked one.
    docker run --rm \
      --entrypoint /bin/bash \
      -v "$work/$side:/workspace" -w /workspace \
      -e CARGO_TERM_COLOR=never \
      "$image" -c "$build_cmd" \
      || die "build $side failed inside the container"
  done

  # Extract the spec/interface JSON inside the container too, so the host needs
  # no stellar-cli. This is the "spec-json" half of the reproducibility claim.
  for side in a b; do
    docker run --rm --network none \
      --entrypoint /bin/bash \
      -v "$work/$side:/workspace" -w /workspace \
      "$image" -c "stellar contract info interface --wasm $WASM_REL --output json > repro-spec.json" \
      || die "spec extraction failed for build $side"
  done
else
  warn "NATIVE mode: the host toolchain is not pinned, so a mismatch may be environmental"
  require stellar
  for side in a b; do
    say "Build $side of 2 (native)"
    rm -rf "$work/$side/target"
    (cd "$work/$side/contracts/streaming-payments" && stellar contract build) \
      || die "native build $side failed"
    stellar contract info interface --wasm "$work/$side/$WASM_REL" --output json \
      > "$work/$side/repro-spec.json" || die "spec extraction failed for build $side"
  done
fi

# ------------------------------------------------------------------- compare
compare_component() {
  local name="$1" fa="$2" fb="$3"
  # tr rather than ${name^^}: bash 3.2 (stock macOS) has no case-mapping.
  local upper
  upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
  [ -f "$fa" ] || { printf '%s\n' "$name: MISSING from build a" >&2; return 1; }
  [ -f "$fb" ] || { printf '%s\n' "$name: MISSING from build b" >&2; return 1; }

  local ha hb sa sb
  ha="$(att_sha256 "$fa")"; hb="$(att_sha256 "$fb")"
  sa="$(wc -c < "$fa" | tr -d ' ')"; sb="$(wc -c < "$fb" | tr -d ' ')"

  if [ "$ha" = "$hb" ]; then
    info "$name: identical ($ha, $sa bytes)"
    printf 'REPRO_%s_SHA256=%s\n' "$upper" "$ha" >> "$result"
    return 0
  fi

  # Name the non-deterministic component precisely: where the bytes first part
  # company, how far the damage spreads, and whether the length changed (a
  # length change points at embedded paths/timestamps, an equal-length change at
  # codegen or link order).
  local first differing verdict
  first="$(cmp "$fa" "$fb" 2>&1 | sed -nE 's/.*byte ([0-9]+).*/\1/p' | head -n1 || true)"
  differing="$(cmp -l "$fa" "$fb" 2>/dev/null | head -n 100000 | wc -l | tr -d ' ' || true)"
  if [ "$sa" != "$sb" ]; then
    verdict="LENGTH CHANGED ($sa vs $sb bytes) — suspect an embedded absolute path, timestamp or build-id"
  else
    verdict="same length, $differing differing byte(s) — suspect codegen unit or link ordering"
  fi

  {
    printf '\n### NON-DETERMINISTIC COMPONENT: `%s`\n\n' "$name"
    printf '| | build a | build b |\n|---|---|---|\n'
    printf '| sha256 | `%s` | `%s` |\n' "$ha" "$hb"
    printf '| size | %s | %s |\n' "$sa" "$sb"
    printf '\n- first differing byte: **%s**\n' "${first:-unknown}"
    printf -- '- differing bytes: **%s**%s\n' "$differing" \
      "$([ "$differing" -ge 100000 ] && echo ' (capped at 100000)' || true)"
    printf -- '- verdict: %s\n' "$verdict"
  } >> "$report"

  printf '%s\n' "ERROR: $name is NOT reproducible — $verdict" >&2
  printf 'REPRO_%s_SHA256=%s\n' "$upper" "$ha" >> "$result"
  return 1
}

say "Comparing build a against build b"
wasm_ok=1 spec_ok=1
compare_component wasm "$work/a/$WASM_REL" "$work/b/$WASM_REL" || wasm_ok=0
compare_component spec "$work/a/repro-spec.json" "$work/b/repro-spec.json" || spec_ok=0

# Preserve both artifacts so a mismatch can be inspected after the fact.
mkdir -p "$out/build-a" "$out/build-b"
for side in a b; do
  cp "$work/$side/$WASM_REL" "$out/build-$side/" 2>/dev/null || true
  cp "$work/$side/repro-spec.json" "$out/build-$side/" 2>/dev/null || true
done

verified=$([ "$wasm_ok" = 1 ] && [ "$spec_ok" = 1 ] && echo true || echo false)
{
  printf 'REPRO_VERIFIED=%s\n' "$verified"
  printf 'REPRO_RUNS=2\n'
  printf 'REPRO_WASM_IDENTICAL=%s\n' "$([ "$wasm_ok" = 1 ] && echo true || echo false)"
  printf 'REPRO_SPEC_IDENTICAL=%s\n' "$([ "$spec_ok" = 1 ] && echo true || echo false)"
  printf 'REPRO_COMMIT=%s\n' "$commit"
  printf 'REPRO_MODE=%s\n' "$([ "$use_docker" = 1 ] && echo docker || echo native)"
} >> "$result"

{
  printf '# Reproducibility report — %s\n\n' "${ref}"
  printf -- '- commit: `%s`\n' "$commit"
  printf -- '- mode: %s\n' "$([ "$use_docker" = 1 ] && echo 'hermetic docker' || echo 'native (NOT hermetic)')"
  printf -- '- rust channel: `%s`\n' "$rust_channel"
  printf -- '- stellar-cli: `%s`\n' "$stellar_cli"
  printf -- '- build command: `%s`\n' "$build_cmd"
  if [ "$use_docker" = 1 ]; then
    printf -- '- runs: 2 (independent trees, independent containers, cold cargo cache)\n\n'
  else
    printf -- '- runs: 2 (independent trees, host toolchain — NOT hermetic)\n\n'
  fi
  printf '| component | build a | build b | identical |\n|---|---|---|---|\n'
  printf '| wasm | `%s` | `%s` | %s |\n' \
    "$(att_sha256 "$out/build-a/$(basename "$WASM_REL")" 2>/dev/null || echo '-')" \
    "$(att_sha256 "$out/build-b/$(basename "$WASM_REL")" 2>/dev/null || echo '-')" \
    "$([ "$wasm_ok" = 1 ] && echo 'yes' || echo '**NO**')"
  printf '| spec-json | `%s` | `%s` | %s |\n' \
    "$(att_sha256 "$out/build-a/repro-spec.json" 2>/dev/null || echo '-')" \
    "$(att_sha256 "$out/build-b/repro-spec.json" 2>/dev/null || echo '-')" \
    "$([ "$spec_ok" = 1 ] && echo 'yes' || echo '**NO**')"
  printf '\n'
} > "$out/summary.md"
cat "$report" >> "$out/summary.md" 2>/dev/null || true
mv "$out/summary.md" "$report"

if [ "$verified" = "true" ]; then
  say "REPRODUCIBLE: both builds are byte-identical (wasm and spec-json)"
  info "report: ${report#"$REPO_ROOT"/}"
  exit 0
fi

cat "$report" >&2
die "reproducibility check FAILED — see ${report#"$REPO_ROOT"/}"
