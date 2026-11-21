# Seed-expansion contract

`model/src/seeds.rs` owns two kinds of corpus input:

- **Fixed scenarios** (`seed_*`, `all_seeded_scenarios`): hand-written
  `ActionSequence`s used as readable unit/property scenarios.
- **Generated sequences** (`generate_sequence(seed)`): the deterministic
  mapping from a `u64` seed to an action sequence that the differential harness
  and fuzz campaigns replay.

This document freezes the second one. A platform-dependent expansion would make
differential failures unreproducible and CI flaky, so the algorithm, the
sampling, the action mapping and the serialized bytes are all pinned by
`model/goldens/seed_expansion.txt`.

## Frozen algorithm

- **Version:** `SEED_EXPANSION_VERSION = 1`.
- **Expander:** SplitMix64, seeded with the `u64` seed value directly (no hashing
  of the seed's bytes).
- **Arithmetic:** wrapping `u64` only. Rust defines wrapping arithmetic exactly
  on every target, so Linux, macOS, Windows and wasm32 agree. No floats, no
  platform-sized integers, no addresses, no clocks, no map iteration order.
- **Constants:**
  - gamma `0x9E37_79B9_7F4A_7C15`
  - mixer 1 `0xBF58_476D_1CE4_E5B9`
  - mixer 2 `0x94D0_49BB_1331_11EB`
- **Step:**

  ```text
  state = state + gamma            (wrapping)
  z = state
  z = (z ^ (z >> 30)) * mixer1     (wrapping)
  z = (z ^ (z >> 27)) * mixer2     (wrapping)
  output = z ^ (z >> 31)
  ```

  For `seed = 0` the first output is `0xE220_A839_7B1D_CDAF`.
- **Derived draws:** `next_u32` is the high half of the next `u64`
  (`(word >> 32) as u32`); `next_below(n)` is `word % n` (and `0` for `n == 0`);
  `next_bool` is `word & 1 == 1`.
- **Seed bytes:** `SeedExpander::seed_bytes(seed)` is the 8-byte
  **little-endian** encoding of the seed (`u64::to_le_bytes`). Serialized
  `ActionSequence`s (`ActionSequence::to_bytes`) are little-endian throughout
  and start with the `STMP` magic.

## Frozen generation mapping

`generate_sequence(seed)` emits `GENERATED_SEQUENCE_LEN` (6) actions. Each action
first draws `kind = next_below(10)`, then consumes draws in the order below.
`below(n)` means `next_below(n)` and `flag()` means `next_bool()`; field order
inside an action is the consumption order.

| kind | action | draws |
| ---- | ------ | ----- |
| 0 | `CreateStream` | `sender_idx = below(4)`, `recipient_idx = below(4)`, `deposit = 1 + below(1_000_000_000)`, `start_delay = below(86_400)`, `duration = 1 + below(86_400)`, `cancelable = flag()` |
| 1 | `Withdraw` | `stream_id = 1 + below(50)`, `amount = 1 + below(1_000_000_000)` |
| 2 | `WithdrawMax` | `stream_id = 1 + below(50)` |
| 3 | `CancelStream` | `caller_idx = below(4)`, `stream_id = 1 + below(50)` |
| 4 | `TopUp` | `caller_idx = below(4)`, `stream_id = 1 + below(50)`, `amount = 1 + below(1_000_000_000)` |
| 5 | `SetFeeBps` | `caller_is_gov = flag()`, `new_fee_bps = below(101)` |
| 6 | `NominateGovernor` | `caller_is_gov = flag()`, `nominee_idx = below(4)` |
| 7 | `AcceptGovernor` | `caller_idx = below(4)` |
| 8 | `WithdrawTreasury` | `caller_is_gov = flag()`, `recipient_idx = below(4)`, `amount = 1 + below(1_000_000_000)` |
| 9 | `AdvanceTime` | `seconds = below(2_592_000)` |

`generate_sequence_with_rng` exposes that mapping over a raw `u64` word stream.
The determinism suite drives a deliberately perturbed stream through it to prove
the golden comparison catches a changed expansion.

## Golden vectors

Committed at `model/goldens/seed_expansion.txt`, one row per generator:

```text
label|seed|first 4 expanded u64s (big-endian hex)|ActionSequence::to_bytes hex
```

Rows cover all 14 fixed generators and the generated sequences at seeds
`0, 1, 2, 42, 0x00C0FFEE`. `model/tests/seed_determinism.rs` recomputes the whole
document and compares byte-for-byte (after CRLF normalization). The expander
row pins the raw word stream independently of the action mapping.

A deliberately perturbed expansion (shift 29 instead of 30) is asserted to
disagree with both the recomputed sequence and the committed golden row, so a
broken comparison cannot pass silently.

## Bless flow

Only regenerate the fixture for an intentional contract change, and only with:

```sh
npm run seed:golden:bless
```

That runs the test with `STREAMPAY_SEED_GOLDEN_BLESS=1`, rewriting
`model/goldens/seed_expansion.txt`. CI never blesses: `cargo test -p
streampay-model` fails on any drift. A re-bless must:

1. Bump `SEED_EXPANSION_VERSION` in `model/src/seeds.rs`.
2. Update this document if the algorithm or mapping changed.
3. Explain the change in the PR that carries it.

## CI coverage

The repository's Rust CI runs on Linux (`ubuntu-latest`) only; there are no
Windows or macOS `cargo test` legs. The construction above is
platform-independent by design, so the goldens are meaningful on every target,
and adding a Windows or macOS leg later requires no new fixture, only the
existing `cargo test -p streampay-model`.
