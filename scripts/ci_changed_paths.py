#!/usr/bin/env python3
"""Emit PR path flags for the consolidated CI workflow."""

import argparse
import os
from pathlib import Path
import subprocess
import sys


COMMON_PATHS = (
    ".github/workflows/ci.yml",
    "scripts/ci_changed_paths.py",
    "tests/ci_changed_paths_test.py",
)

PATH_GROUPS = {
    "fuzz": (
        "contracts/**",
        "fuzz/**",
        "model/**",
        "Cargo.toml",
        "Cargo.lock",
        ".github/workflows/fuzz-gate.yml",
    ),
    "infra": (
        "infra/**",
        "digests/**",
        "indexer/**",
        ".dockerignore",
        "perf/baselines/docker.json",
        "perf/harness/check_image_budget.mjs",
        "perf/test/image_budget.test.mjs",
        ".github/workflows/infra.yml",
    ),
    "indexer_image": (
        "infra/docker/**",
        "indexer/**",
        ".dockerignore",
        "perf/baselines/docker.json",
        "perf/harness/check_image_budget.mjs",
        "perf/test/image_budget.test.mjs",
        ".github/workflows/infra.yml",
    ),
    "sbom": (
        "contracts/**",
        "Cargo.lock",
        "Cargo.toml",
        "deny.toml",
        "frontend/package.json",
        "frontend/package-lock.json",
        "indexer/**",
        ".dockerignore",
        "sdks/**",
        "tools/streampay-cli/**",
        "infra/docker/**",
        "security/vex/**",
        "scripts/sbom_vex.py",
        "tests/sbom_vex_test.py",
        ".github/workflows/sbom-vex.yml",
    ),
    "sdk": (
        "sdks/**",
        "contracts/streaming-payments/src/**",
        "contracts/streaming-payments/test_snapshots/**",
        "schemas/events/registry.json",
        "frontend/lib/errors.ts",
        "perf/**",
        ".github/workflows/sdk.yml",
    ),
    "wasm_diff": (
        "contracts/**",
        "Cargo.toml",
        "Cargo.lock",
        ".github/workflows/wasm-diff.yml",
        ".github/workflows/wasm-diff-comment.yml",
        ".github/actions/**",
        ".github/scripts/**",
        "scripts/wasm-report.mjs",
    ),
    "whitepaper": (
        "docs/WHITEPAPER.md",
        "contracts/**",
        "scripts/check_whitepaper_claims.py",
        ".github/workflows/whitepaper-claims.yml",
    ),
    "attestation": (
        "scripts/attest.sh",
        "scripts/verify_wasm.sh",
        "scripts/attestation_lib.sh",
        "scripts/attestation_keygen.sh",
        "scripts/reproducible_build.sh",
        "tests/attestation_tamper_audit.sh",
        "attestations/**",
        ".github/workflows/attestation.yml",
    ),
    "release_signing": (
        "scripts/attestation_lib.sh",
        "scripts/sigstore_lib.sh",
        "scripts/sigstore_sign.sh",
        "scripts/verify_sigstore.sh",
        "tests/sigstore_verify_test.sh",
        "docs/SIGSTORE.md",
        ".github/workflows/release-sign.yml",
    ),
    "rotation": (
        "indexer/src/secrets/**",
        "indexer/src/webhooks/**",
        "indexer/src/rpc-manager.ts",
        "indexer/src/rpc-credentials.test.ts",
        "infra/secrets-rotation/**",
        ".github/workflows/secrets-rotation.yml",
    ),
    "rehearsal": (
        ".github/workflows/promote.yml",
        ".github/workflows/rehearsal.yml",
        "scripts/**",
        "docs/DEPLOY_PIPELINE.md",
        "docs/CANARY_RUNBOOK.md",
        "deployments/**",
    ),
}


def path_matches(path, pattern):
    if pattern.endswith("/**"):
        return path.startswith(pattern[:-2])
    if any(char in pattern for char in "*?["):
        raise ValueError(f"unsupported CI path pattern: {pattern}")
    return path == pattern


def changed_paths(root, base_sha, head_sha):
    merge_base = subprocess.run(
        ["git", "merge-base", base_sha, head_sha],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if merge_base.returncode != 0 or not merge_base.stdout.strip():
        raise RuntimeError(
            f"cannot resolve merge base for {base_sha} and {head_sha}: "
            f"{merge_base.stderr.strip()}"
        )
    diff = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z",
         merge_base.stdout.strip(), head_sha],
        cwd=root,
        capture_output=True,
    )
    if diff.returncode != 0:
        raise RuntimeError(
            "cannot list changed paths: "
            + diff.stderr.decode("utf-8", errors="replace").strip()
        )
    return {
        path.decode("utf-8", errors="surrogateescape")
        for path in diff.stdout.split(b"\0")
        if path
    }


def path_flags(paths):
    flags = {}
    for name, patterns in PATH_GROUPS.items():
        all_patterns = patterns + COMMON_PATHS
        flags[name] = any(path_matches(path, pattern)
                          for path in paths for pattern in all_patterns)
    return flags


def write_outputs(flags, output):
    lines = "".join(f"{name}={'true' if value else 'false'}\n"
                    for name, value in flags.items())
    if output:
        with open(output, "a", encoding="utf-8", newline="\n") as handle:
            handle.write(lines)
    else:
        sys.stdout.write(lines)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-name", default=os.environ.get("GITHUB_EVENT_NAME"))
    parser.add_argument("--base-sha", default=os.environ.get("PR_BASE_SHA"))
    parser.add_argument("--head-sha", default=os.environ.get("GITHUB_SHA", "HEAD"))
    parser.add_argument("--output", default=os.environ.get("GITHUB_OUTPUT"))
    parser.add_argument("--root", default=os.environ.get("GITHUB_WORKSPACE", "."))
    args = parser.parse_args(argv)

    if args.event_name != "pull_request":
        parser.error("ci_changed_paths.py only supports pull_request events")
    if not args.base_sha:
        parser.error("a nonempty PR base SHA is required")

    try:
        flags = path_flags(changed_paths(Path(args.root), args.base_sha, args.head_sha))
        write_outputs(flags, args.output)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"CI path detection failed closed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
