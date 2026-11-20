# VEX triage: how an advisory gets accepted, fixed or blocked

`vex.json` is the machine-readable record of **what we decided** about each known
advisory, per artifact. It is not a suppression list: an advisory with no entry
blocks the release gate, and an entry that has expired blocks it too. The gate
that reads it is [`scripts/sbom_vex.py`](../../scripts/sbom_vex.py), wired into
[`.github/workflows/sbom-vex.yml`](../../.github/workflows/sbom-vex.yml).

## Why not an ignore list

`deny.toml` already ignores two RUSTSEC advisories, with a comment each. Comments
are for humans, so nothing checks that the reasoning still holds, that anyone
owns the decision, or that it is revisited. Every ignore therefore has a VEX
entry **with the same id**, an owner, a review date and an expiry — and
`tests/sbom_vex_test.py` fails if the two lists disagree.

## The gate

```sh
python3 scripts/sbom_vex.py \
  --sbom rust=sbom/rust/streampay_contract.cdx.json \
  --sbom frontend=sbom/frontend.cdx.json \
  --artifact contract-wasm=target/wasm32v1-none/release/streampay_contract.wasm \
  --sbom-for contract-wasm=rust \
  --lock rust=Cargo.lock \
  --lock frontend=frontend/package-lock.json \
  --advisories cargo-deny=advisories/cargo-deny.json \
  --advisories npm-audit=advisories/npm-audit.json \
  --vex security/vex/vex.json \
  --index-out sbom/sbom-index.json
```

It fails when:

| Condition | Why it blocks |
|---|---|
| an SBOM is malformed, has a component with no resolved version or a bad hash | a dependency audit cannot trust the inventory it is auditing |
| an artifact has no SBOM covering it | shipped bytes with no inventory are unauditable |
| an SBOM disagrees with the lockfile | the SBOM hides or invents a dependency |
| an SBOM drifts from the committed baseline (`--baseline`) | ingredient changes must be reviewed, not absorbed |
| a **critical/high** (or unclassified) advisory has no VEX entry | an unreviewed high finding is not an accepted one |
| a critical/high advisory is still `under_investigation` | "we are looking at it" is not a decision, and it never expires by itself |
| an entry is expired, has no owner, no `analysis.detail`, or `not_affected` with no justification | that is a silent suppression with extra steps |
| an entry names a different component version than the SBOM ships | the decision was made about different bytes |

Medium and low advisories with no entry are printed as warnings with the advisory
id, so they stay visible in the run log without blocking a release on their own.

## Writing an entry

One `vulnerabilities[]` item per advisory in `vex.json`:

```json
{
  "id": "GHSA-aaaa-bbbb-cccc",
  "source": {"name": "npm-audit", "url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc"},
  "description": "one line from the advisory",
  "recommendation": "what would let us remove this entry",
  "analysis": {
    "state": "not_affected",
    "justification": "code_not_reachable",
    "detail": "Why this artifact cannot be reached by the vulnerable code. Be specific: the gate cannot read intent, a reviewer has to be able to check this claim."
  },
  "affects": [{"ref": "pkg:npm/left-pad@1.3.0"}],
  "properties": [
    {"name": "streampay:vex:owner", "value": "security"},
    {"name": "streampay:vex:reviewed_at", "value": "2026-11-20"},
    {"name": "streampay:vex:expires", "value": "2027-04-30"}
  ]
}
```

Rules that are enforced, not advisory:

- `analysis.state` is one of `affected`, `not_affected`, `fixed`, `under_investigation`.
- `analysis.detail` is never empty. `not_affected` additionally needs a CycloneDX
  `justification` (`code_not_reachable`, `requires_configuration`,
  `requires_dependency`, `requires_environment`, `protected_by_compiler`,
  `protected_at_runtime`, `protected_at_perimeter`, `protected_by_mitigating_control`).
- `affects[].ref` is a package URL **with a version**, and that version must be
  the one the SBOM ships. A version bump needs a fresh review.
- `streampay:vex:owner`, `streampay:vex:reviewed_at` and `streampay:vex:expires`
  are required; `expires` is in the past the gate fails. Pick the shortest
  plausible window — 90 days for `under_investigation`, up to six months for a
  `not_affected` whose dependency cannot move.
- One entry per id. Duplicates fail rather than merge silently.

## Triage workflow

1. CI runs cargo-deny, `npm audit` and (when the generator has a requirements
   file) `pip-audit`, then the gate. A new critical/high finding fails the build
   and names the advisory id in the log.
2. Decide: upgrade the dependency (`fixed` needs no entry at all once it is
   gone), or record `not_affected` with a justification you can defend, or
   `affected` with the mitigation and its owner.
3. Add or update the entry in `vex.json`, in the same pull request that changes
   the dependency graph, so the two diffs are reviewed together.
4. Re-run `python3 tests/sbom_vex_test.py` — it also validates the committed
   document, so an expired or justification-less entry fails locally.
5. When the expiry lapses, the next run fails and the decision comes back to a
   human. That is the intended failure mode: nothing is accepted forever by
   accident.

## Why `under_investigation` still blocks for critical/high

A discovered-but-undecided critical advisory is exactly the state an attacker
benefits from: it is acknowledged, so nobody is surprised later, while nothing
has actually been done. The entry is allowed — its expiry is how a time-boxed
investigation is recorded — but a release carrying a critical/high advisory in
that state does not pass the gate. Lower severities may sit there, warn on every
run, and expire.
