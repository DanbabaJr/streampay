# Postmortem template

Copy this file to `docs/postmortems/YYYY-MM-DD-<slug>.md` and fill it in. Keep it
**blameless**: describe systems and conditions, not people. Link the filled-in
document from the postmortem issue opened with
[`.github/ISSUE_TEMPLATE/postmortem.yml`](../.github/ISSUE_TEMPLATE/postmortem.yml).

Loss figures use the definitions in [`docs/BOUNTY.md`](./BOUNTY.md) §3:
`MLS = E + R`, where `E` is escrowed value at risk and `R` is the remediation
cost from issue #27's cost model.

---

## Metadata

| Field | Value |
|---|---|
| Status | Draft / In review / Final |
| Date (UTC) | YYYY-MM-DD |
| Severity | Critical / High / Medium / Low / Informational |
| Bounty tier | P1 / P2 / P3 / P4 / n/a |
| Author | @handle |
| Reviewers | @handle(s) |
| Related issues | #… |
| Fix PR(s) | #… |

## Summary

Two or three sentences a future responder can read cold, with no prior context.

## Impact

- **Observed** vs. **potential** loss.
- `E` (escrowed value at risk), `R` (remediation cost), `MLS = E + R`, and the
  realized share of MLS — with the measurements behind each number.
- Affected assets (`A-1`…`A-7`) and invariants from
  [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md).

| Metric | Value | How measured |
|---|---|---|
| `E` | … | on-chain balance, RPC at ledger … |
| `R` | … | issue #27 rent constants |
| `MLS` | … | `E + R` |
| Funds actually lost | … | … |

## Timeline

All times UTC. Record both what happened and how it was noticed.

| Time | Event | Actor / tool |
|---|---|---|
| | Detected | |
| | Triaged / decided | |
| | Contained | |
| | Resolved | |
| | Disclosed | |

Time-to-detect: … · Time-to-decide: … · Time-to-contain: … (compare to the
SLA targets in [`docs/BOUNTY.md`](./BOUNTY.md) §5).

## Root cause

The underlying cause, not just the trigger. Include the **5 whys** if it helps
get past the first plausible explanation.

1. Why …? Because …
2. Why …? Because …

## What went well

## What went poorly

## Detection and prevention

- Which alert, gate, or test should have caught this sooner?
- Was it caught by the pipeline, or by luck / a user?
- What is the smallest change that makes a recurrence impossible, not merely
  less likely?

## Action items

Each item has an owner and a due date and links a tracking issue. Carry these
into the release/rehearsal gates where applicable.

- [ ] … (@owner, by YYYY-MM-DD, #…)
- [ ] … (@owner, by YYYY-MM-DD, #…)

## Evidence

Links to logs, drill output, transaction hashes, and scripts used.
