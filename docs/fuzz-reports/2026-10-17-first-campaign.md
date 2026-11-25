<!-- First campaign for #116. Budget 1.9 h (not 8 h): the environment it ran in caps a background job at 2 h. Produced by scripts/fuzz/campaign.sh; numbers unedited. -->

# Fuzz campaign report

- **Window:** 2026-10-17T19:01:56Z → 2026-10-17T20:57:14Z (1.90 h of fuzzing, budget 1.9 h)
- **Commit:** `952fa321868ad420ad2955fc4876b394e898b017`
- **Host:** Linux 6.18.44-fc-v139 x86_64, 2 cores, 2 workers per slice; rustc 1.97.0 (2d8144b78 2026-07-07)
- **Targets (round-robin, 15 min slices):** campaign,differential,conservation,streamed_at
- **Total executions:** 956,159,616 (139,994/s across all workers)

## Per target

| Target | Fuzzing time | Executions | Runs/sec | Edge coverage | Gained after first slice | Corpus after merge | New crashers |
|---|---|---|---|---|---|---|---|
| `campaign` | 0.50 h | 299,803 | 167 | 6,253 / 105,076 (5.95%) | +38 edges | 1,751 | 0 |
| `differential` | 0.50 h | 423,974,327 | 235,541 | 153 / 100,079 (0.15%) | +0 edges | 169 | 0 |
| `conservation` | 0.50 h | 668,127 | 371 | 5,706 / 102,986 (5.54%) | +6 edges | 1,611 | 0 |
| `streamed_at` | 0.40 h | 531,217,359 | 371,481 | 38 / 99,769 (0.04%) | +0 edges | 11 | 0 |

## Crashes

No crashers. No divergence between the contract and the reference model (`campaign`, `differential`), and no broken property (`conservation`, `streamed_at`).

Known divergences suppressed during this run (see docs/FUZZ_CAMPAIGN.md): KD-1, unless the run set STREAMPAY_FUZZ_STRICT.
