# Canonical spec

`streampay.spec.json` is the single input to every generated client. It is
**derived from the contract sources** by
`sdks/generator/check_contract_surface.py --write-spec`; do not hand-edit it.

## Contents

* `functions` — every client-invokable entrypoint in the contract's
  `#[contractimpl]` block: name, documentation, ordered arguments (names + IR
  types), return type, whether the call is fallible (`error`), and whether it
  mutates state
* `structs` / `enums` / `unions` — the `#[contracttype]` types reachable from
  entrypoints or events. `enums` are all-unit enums with their wire
  `encoding`: `symbol` (no discriminants; Soroban encodes `Vec[Symbol(case)]`)
  or `u32` (every case has `= N`). `unions` are enums whose cases carry tuple
  payloads, encoded `Vec[Symbol(case), payload…]`, cases in declaration order
* `events` — event name, topic symbol, topic fields, data fields (the layout
  `#[contractevent]` emits: `[symbol(topic), topic fields…]` plus a
  symbol-keyed data map)
* `constants` — numeric constants clients need, with their Rust type

`__constructor` is not listed: it runs at deploy time and is not an operation a
client can invoke on a deployed contract. The coverage tests check every other
`pub fn`.

IR types are a small language:

| IR | Rust |
|---|---|
| `address` | `Address` / `MuxedAddress` |
| `bool` | `bool` |
| `i128`, `u128`, `u64`, `u32`, `i32` | same |
| `string`, `symbol` | `String`, `Symbol` |
| `bytes32`, `bytes64` | `BytesN<32>`, `BytesN<64>` |
| `{ "vec": T }` | `Vec<T>` |
| `{ "option": T }` | `Option<T>` |
| `{ "result": { "ok": T, "err": E } }` | `Result<T, E>` |
| `void` | `()` |
| `Name` | a contract struct / enum / payload enum | language-specific (see each SDK) |

Error names and codes are **not** in the spec. `generate.py` reads the canonical
catalog (`frontend/lib/errors.ts`), which is generated from `errors.rs` and
gated separately, so there is exactly one error registry in the repository.

## The spec is the contract

`check_contract_surface.py` re-derives the IR from the Rust sources on every CI
run and fails when the checked-in spec differs. The companion tests
(`sdks/generator/test_contract_surface.py`) fail when:

* an entrypoint exists in the contract but not the spec (the spec's operation
  set is smaller than the contract's), or the other way round;
* an entrypoint named by `surface.rs`'s branch registry is missing;
* the parser misses any `pub fn` in the `#[contractimpl]` block, including
  `__constructor`;
* an event or event-referenced type disagrees with
  `schemas/events/registry.json`;
* a struct/enum/event/constant drifts;
* the spec is not byte-for-byte what `--write-spec` emits;
* `FINGERPRINT` does not match the canonical JSON.

## Changing the contract

1. Update the contract and its tests.
2. Regenerate the spec and fingerprint:
   `python3 sdks/generator/check_contract_surface.py --write-spec`.
3. Regenerate any language clients present: `make -C sdks generate`
   (Python 3.12, stdlib only).
4. Rebuild the vectors (they embed the spec fingerprint): `make -C sdks vectors`.
5. Run `make -C sdks check`.

## Provenance

`SPEC_FINGERPRINT` (sha256 of the canonical JSON) is embedded in every SDK and
in every vector, so a client and fixture from different spec revisions fail
loudly instead of silently decoding the wrong layout.
