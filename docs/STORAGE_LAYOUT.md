# Storage layout: golden regression suite

Issue #210. This document is the operations manual for
`contracts/streaming-payments/src/storage_golden/` and the committed corpus in
`test_fixtures/storage/`. It answers three questions: what the suite protects,
how to run it, and how to *accept* a layout change on purpose.

## What can break without breaking Rust

Storage layout is the on-ledger XDR shape of everything the contract persists.
A change that compiles, passes every unit test, and keeps Rust semantics can
still make already-deployed instances unreadable. The silent ones:

| Change | Why Rust does not notice | Caught by |
| --- | --- | --- |
| Renaming a `#[contracttype]` struct field | field names are written onto the wire as symbols by the symbol-named map encoding; Rust reads by position/name locally | `decode::golden_records_decode_and_roundtrip`, `decode::harness_detects_field_rename_by_construction` |
| Renaming an enum variant | same: the variant symbol is the encoding | `mid_enum::stream_status_wire_forms_are_pinned`, `mid_enum::intent_status_wire_forms_are_pinned` |
| Retyping a field (`u64` → `i128`, `bool` → `u32`) | both sides exist in Rust; the blob does not decode | `decode` (typed decode fails, message names the field) |
| Adding/removing a struct field | the SDK tolerates it locally | `decode` (field diff names the missing/extra key; an added `Option` field is the one compatible case — see below) |
| Mid-enum semantic shift (variant swapped, discriminant reused) | still decodes as the same Rust variant | `mid_enum::semantic_variant_shift_is_caught_even_when_decode_accepts_it` |
| New storage key, new key enum variant | nothing old breaks; nothing new is pinned | `kind_for_key`'s exhaustive match fails to compile first; then `generate` panics on unknown keys and `decode::golden_manifest_covers_every_persisted_kind` |
| Event topic/payload layout (`#[topic]` moves a field into the topics) | indexers and off-chain readers break first | `decode::golden_events_roundtrip` |
| A migration that loses or rewrites data across an upgrade | each build is internally consistent | `replay::upgrade_replay_preserves_every_record` |

**The one change that is *not* a break: a new `Option` field.** The generated
decoder unpacks a struct over a `VOID`-initialised field slice, so a key the
release line never wrote arrives as `VOID`, and `Option<T>` is the only field
form that accepts `VOID`. The encoder writes every declared field back out, so a
legacy record re-encodes with one extra `VOID`-valued key. `decode` recognises
exactly that shape (`optional_additions`): the key is reported as
`COMPATIBLE ADDITION` and the byte-for-byte check runs over the release-line key
set. It tolerates nothing else — a new *required* field fails the typed decode
before the concession is reached, and a rename whose replacement happens to be
`VOID` still reports the vanished old field
(`decode::compatible_addition_rule_accepts_void_and_nothing_else` proves all
three arms). `Stream.use_oracle: Option<bool>` is the case this rule exists for:
the field is a widening of a release-line `bool`, so old records keep their
meaning (`None` settles against ledger time, like `Some(false)`) and
`migrate_batch` backfills `Some(false)` on the bounded upgrade path.

**Corpus gap as of this landing.** `DataKey` grew six variants after the corpus
was cut: `oracle_config`, `oracle_report`, `pending_ownership`,
`pending_rate_change`, `rate_segments`, `stream_pause`. They are dispatched by `kind_for_key` —
which is why the branch that predated them stopped compiling the moment it merged
— but they have no golden record and stay out of `COVERED_KINDS`. Pinning them
means extending `scenario.rs` (report oracle time, propose an ownership transfer,
propose and accept a rate change, pause a stream) and re-running the `#[ignore]`d generator with a
release-line wasm, which is follow-up work rather than a merge condition.

## Layout

```
contracts/streaming-payments/src/storage_golden/
  mod.rs        blob IO, ScVal rendering, key→kind dispatch, field diffing
  scenario.rs   the canonical lifecycle: streams, intents, fees, policy,
                governance, freeze + migrate, upgrade proposal (T0 .. T0+19d)
  generate.rs   #[ignore]d test: runs the scenario, writes the corpus
  decode.rs     CI test: decodes the corpus with the in-development types
  mid_enum.rs   CI test: proves the harness is not blind to enum drift
  replay.rs     CI test: boots the released wasm, upgrades to this build,
                re-reads every key

test_fixtures/storage/
  manifest.json     one entry per record/event: kind, durability, key render,
                    and the golden field→value map
  records/*.bin     33 blobs, one per persisted key
  events/*.bin      25 blobs, one per emitted event
  baseline/…wasm    the release-line (v0.3.0) bytecode the replay boots
```

Blob formats (both are `u32` little-endian length prefixes, then XDR):

* record: `u32le | LedgerKey xdr | u32le | LedgerEntry xdr`
* event: `u32le | ScVec topics xdr | u32le | ScVal data xdr`

Instance-storage keys (`governor`, `fee_bps`, …) are *not* ledger entries of
their own — they live inside the `contract_instance` value. `generate` pins each
one as a standalone record too (durability labelled `Instance`) so a layout
change fails with the per-key name instead of one opaque diff inside the
instance blob.

The scenario is deterministic: same source, same 33 records and 25 events,
byte-for-byte. `stream_paused` / `stream_resumed` (#24) have no release-line
counterpart, so their two blobs were cut from the dev build and appended to the
manifest on their own: the scenario emits them on the generator path only,
after both snapshots and at a single timestamp (a zero-length pause), so no
pinned record moved. CI depends on that (see the freshness gate below).

## Running it

```bash
# The decode + mid_enum + replay tests, as CI runs them:
STORAGE_GOLDEN_REQUIRE_WASM=1 cargo test -p streampay-contract --lib --locked storage_golden

# Regenerate the corpus — only from a checkout of the release line you are
# pinning (see §Accepting a layout change): the generator writes the layout of
# the build it runs on.
cargo test -p streampay-contract --lib --locked storage_golden::generate -- --ignored
```

`replay` is the only test that needs a compiled wasm of the *current* source,
because it upgrades the running instance to those exact bytes:

```bash
(cd contracts/streaming-payments && stellar contract build)   # CI path
# Without stellar-cli, soroban-sdk's build script needs the opt-out:
SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 \
  cargo build -p streampay-contract --target wasm32v1-none --release
```

Without that artifact the replay prints `SKIP upgrade_replay: …` and passes, so
a unit-test-only run on a fresh clone is not broken — but in CI
`STORAGE_GOLDEN_REQUIRE_WASM=1` turns the same skip into a failure, which is why
`.github/workflows/ci.yml` builds the wasm *before* the test steps and sets the
variable at job level.

## In CI

| Step | Fails when |
| --- | --- |
| `Wasm build (stellar contract build)` | the artifact the replay upgrades to cannot be built (step runs before the tests on purpose) |
| `Unit + property tests` | any golden record/event no longer decodes, round-trips, or survives the replay, with `STORAGE_GOLDEN_REQUIRE_WASM=1` making a silent skip impossible |
| `Storage-layout corpus is intact` | a blob the manifest names is not committed, a committed blob has no manifest entry, a blob is empty, or the baseline wasm is missing. It deliberately does **not** regenerate the corpus — see below. |

The removed `corpus is up to date` step ran the generator and diffed
`test_fixtures/storage/`, which cannot pass. The generator writes the layout of
**the build it runs on**, while the committed corpus is pinned to the release
line (v0.3.0). The first layout change after the cut therefore makes the step
fail because the corpus is *current*, not because anything is wrong — and it
rewrites the pinned blobs in the workspace, destroying the only artifact whose
value is that it does not move. The unreviewed-layout-change signal belongs to
the tests above, and they hold it: `decode` fails the moment a release-line
record stops decoding (it is what caught the `use_oracle` widening), `mid_enum`
catches renames and semantic shifts a typed decode cannot see, and `replay`
proves untouched records survive the upgrade byte-for-byte.

## Accepting a layout change (the only sanctioned path)

A layout change is a **breaking on-chain migration**: instances already on
testnet/mainnet hold the old bytes. Never regenerate to make a red test green.

1. Confirm the failure is intentional and stated in the PR description: which
   kind, which field, old wire form → new wire form.
2. Decide the migration story **before** touching fixtures — a `schema_version`
   bump plus a bounded `migrate_storage` path, or an explicit "no deployed
   instance holds this key yet". If neither exists, this is a bug, not a layout
   change.
3. Run the scenario/generator on a scratch branch **of the release line the
   corpus pins** (that is how the committed blobs were cut):
   `cargo test -p streampay-contract --lib --locked storage_golden::generate -- --ignored`
   Running it on the build under review instead produces *that* build's shape
   and overwrites the release-line records, which is the coverage loss this
   suite exists to prevent. Use a dev-build run only to read the field diff,
   and never commit its blobs over the pinned ones.
4. Review `git diff test_fixtures/storage/manifest.json` field by field. Every
   changed line must be one you predicted; an unrelated key moving means the
   scenario picked up extra state — fix the scenario, not the corpus.
5. Keep `COVERED_KINDS` (`decode.rs`) in step with the contract: a new persisted
   key gets a new entry, a dispatch arm in `kind_for_key` (`mod.rs`), and a
   `typed_roundtrip` decoder arm. Adding a key without them fails the generator
   by design.
6. Document the migration in `docs/UPGRADES.md` and note the affected keys here
   if the change alters which records survive an upgrade.
7. Re-capture the baseline wasm **only** when the released line moved (§
   Replacing the baseline below).

### Reviewer sign-off checklist

- [ ] The PR states the storage change as a wire-form diff, not a Rust diff.
- [ ] `schema_version` moved (or the author proves no live instance holds the key).
- [ ] A migration path exists, is bounded, and is covered by its own tests.
- [ ] The diff of `manifest.json` contains only the predicted fields.
- [ ] Old blobs still decode (`decode::golden_records_decode_and_roundtrip`) or
      their removal is explained — deleting a golden record is a deliberate act.
- [ ] Every `COMPATIBLE ADDITION:` line the decode tests print is an addition this
      PR intends, and the PR says how the absent value behaves (backfilled by
      `migrate_batch`, or inert on reads). A note the author cannot explain is a
      layout change wearing a compatible costume.
- [ ] `replay` still proves byte-identical survival for every untouched key.
- [ ] Two reviewers, one of whom has read `docs/UPGRADES.md`.
- [ ] The testnet smoke (§ below) was run if the change affects an
      already-deployed instance.

## Replacing the baseline wasm

`test_fixtures/storage/baseline/streampay-v0.3.0-baseline.wasm` is the release
bytecode the replay boots and upgrades away from. Replace it when the promoted
release moves (a release cut, not a feature merge):

```bash
git switch <the released tag or main commit>
(cd contracts/streaming-payments && stellar contract build)
cp target/wasm32v1-none/release/streampay_contract.wasm \
   "$REPO/test_fixtures/storage/baseline/streampay-<new version>-baseline.wasm"
```

Update `baseline_wasm_path()` in `storage_golden/mod.rs` and the file name here.
The replay asserts the running instance really is the committed artifact
(`the replay must boot the committed baseline wasm`), so a stale or mislabelled
baseline fails loudly rather than upgrading from the wrong bytes. If the new
baseline happens to hash equal to the in-development build, the replay prints a
`NOTE:` and only the data-survival assertions carry signal.

`*.wasm` is gitignored repo-wide; `!test_fixtures/**/*.wasm` re-includes the
fixture deliberately, so this artifact is a tracked file.

## Testnet smoke (two-phase, manual)

`scripts/storage_golden_smoke.sh` repeats the replay against a real chain. It
deploys the committed baseline wasm, writes data through it by reusing
`scripts/deploy_testnet.sh`, records ten read-backs, and proposes the upgrade to
the freshly built artifact. The contract enforces a 24 h timelock
(`MIN_UPGRADE_DELAY_SECONDS`), so the run is necessarily split:

```bash
scripts/storage_golden_smoke.sh --dry-run write   # offline plan + preflight
scripts/storage_golden_smoke.sh write             # deploy, write, propose
# … 24 h …
scripts/storage_golden_smoke.sh verify            # upgrade, re-read, diff, write
```

`verify` fails naming the exact JSON field that moved, checks accrual never
regressed, then proves the new bytecode still writes (`execute_scheduled`,
`withdraw_max`). Per-run state lives in `.storage_golden_smoke/` (gitignored);
the evidence is the `pre.*.json` / `post.*.json` pair for every read. It needs
`stellar-cli`, `cargo`, `node`, `curl`, and testnet funds, and is not part of CI.

## Known limits

* Only `ContractData` keys are pinned: token balances and other contracts'
  storage are out of scope (SAC layout is chain-defined).
* The suite pins XDR shape, not interpretation: a change that keeps the wire
  form and alters meaning (e.g. re-scaling a rate) is an accrual-behaviour
  question and belongs to the model/differential tests.
* Field *order* in a `#[contracttype]` struct is wire-neutral and is
  deliberately not flagged: the host canonicalises symbol-keyed maps, so both
  the golden blob and a fresh encode present keys sorted by symbol, not by
  declaration order (verified with a probe: a reordered `Stream` still decoded
  and re-encoded to byte-identical XDR). Renaming, removing, or changing the
  type of a field is a real break and is caught — a planted rename of
  `Stream.withdrawn` made every golden stream record fail to decode.
* TTL/rent parameters are recorded as the snapshot holds them; eviction behaviour
  is covered by `infra/ttl-sentinel`, not here.
* `render` is the diffing grammar: adding an `ScVal` variant means extending it
  in `mod.rs` or the generator reports the unknown shape.
