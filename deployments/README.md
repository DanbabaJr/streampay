# Deployment records

Append-only records of every promotion. Because a public chain's history cannot
be edited, the release pipeline keeps its own history the same way: it only ever
adds to it.

## `promotions.log`

One line per promotion event, written by `scripts/record_promotion.sh`:

```
<UTC ISO-8601> | tag=<release tag> | env=<env> | result=<result> | digest=<wasm sha256> | interface=<interface sha256> | contract=<contract id> | actor=<who> | run=<url>
```

`result` is one of `promoted`, `rolled-back`, `rehearsed`. **Never edit or
remove a line** — a correction is a new line.

This file is the in-repo mirror. The durable, externally-visible log is the
append-only comment thread on the pinned issue named by the `PROMOTION_ISSUE`
repository variable, plus the per-run release assets. `rollback_mainnet.sh`
reads all three (explicit override → issue thread → this file).

## `runs/`

One markdown file per promotion run, written by `scripts/record_promotion.sh`,
with the run's gate-evidence references. Safe to commit; never deleted.

## `interface/`

Per-environment contract-interface baselines (`<env>.sha256` and, for a readable
diff, `<env>.json`). These are what the schema-diff gate compares against — see
[`../docs/DEPLOY_PIPELINE.md`](../docs/DEPLOY_PIPELINE.md). A baseline is only
updated after a promotion is approved and recorded.
