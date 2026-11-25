# `conservation` regression seeds

Inputs that used to fail the property fuzz target. `.github/workflows/fuzz-gate.yml`
replays this directory on every pull request with `cargo fuzz run conservation
regressions/conservation -- -runs=0`, and the Saturday campaign replays it before
it starts searching (docs/FUZZ_CAMPAIGN.md, docs/CONSERVATION_FUZZ.md §2.1).

| File | What it pins |
|---|---|
| `pause-clock-2d4236f0.bin` | 79 bytes, `initial_fee_bps = 40`, operations including `PauseStream`. Nightly run 40466335512 (2026-10-27) failed `conservation.rs` Invariant 3 with `schedule accrual diverged from the model for stream 1`, `left: 31975000000`, `right: 0`. The contract was right: the stream was paused, so it prices at its freeze point, while the oracle priced the stored schedule at ledger time. Fixed by pricing at `streampay_model::accrual_clock(now, paused_at)`; the same run's input must now pass. |

Keep the libFuzzer name suffix (`-<first 8 of the crash sha>`) so a seed can be
traced back to the run that produced it.
