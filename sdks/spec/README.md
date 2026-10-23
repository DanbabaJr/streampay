# Canonical spec

`streampay.spec.json` is the single input to every generated client. It is
**derived from the contract sources** by
`sdks/generator/check_contract_surface.py --write-spec`; do not hand-edit it.

## Contents

* `functions` — every client-invokable entrypoint in the contract's
  `#[contractimpl]` block: name, documentation, ordered arguments (names + IR
  types), return type, whether the call is fallible (`error`), and whether it
  mutates state
* `structs` / `enums` — the `#[contracttype]` types reachable from entrypoints
  or events. A payload (tuple) enum variant carries its positional `types`;
  `value` is the declaration index. Neither is the wire tag: soroban-sdk
  encodes every contract enum as a vector of the variant name as a `Symbol`
  followed by the variant's values, so a client cannot mis-decode an enum whose
  declaration order changed
* `events` — event name, topic symbol, topic fields, data fields (the layout
  `#[contractevent]` emits: `[symbol(topic), topic fields…]` plus a
  symbol-keyed data map)
* `constants` — numeric constants clients need, with their Rust type

`__constructor` is not listed: it runs at deploy time and is not an operation a
client can invoke on a deployed contract. The coverage tests check every other
`pub fn`.

IR types are a small language:

| IR | Rust | TypeScript |
|---|---|---|
| `address` | `Address` / `MuxedAddress` | `string` |
| `bool` | `bool` | `boolean` |
| `i128`, `u128`, `u64` | same | `bigint` |
| `u32`, `i32` | same | `number` |
| `string`, `symbol` | `String`, `Symbol` | `string` |
| `bytes32`, `bytes64` | `BytesN<32>`, `BytesN<64>` | `Uint8Array` |
| `{ "vec": T }` | `Vec<T>` | `T[]` |
| `{ "option": T }` | `Option<T>` | `T \| null` |
| `{ "result": { "ok": T, "err": E } }` | `Result<T, E>` | `{ ok: T } \| { error: E }` |
| `void` | `()` | `void` |
| `Name` | a contract struct/enum | generated interface/union |
| `[T, …]` (case `types`) | a tuple enum variant | `{ type: "Case"; values: [T, …] }` |

Error names and codes are **not** in the spec. `generate.py` reads the canonical
catalog (`frontend/lib/errors.ts`), which is generated from `errors.rs` and
gated separately, so there is exactly one error registry in the repository.

## The spec is the contract

`check_contract_surface.py` re-derives the IR from the Rust sources on every CI
run and fails when the checked-in spec differs. The companion tests
(`sdks/generator/test_contract_surface.py`) fail when:

* an entrypoint exists in the contract but not the spec;
* an entrypoint named by `surface.rs`'s branch registry is missing;
* a struct/enum/event/constant drifts;
* the spec is not byte-for-byte what `--write-spec` emits;
* `FINGERPRINT` does not match the canonical JSON.

## Changing the contract

1. Update the contract and its tests.
2. Regenerate the spec and fingerprint:
   `python3 sdks/generator/check_contract_surface.py --write-spec`.
3. Regenerate the clients: `make -C sdks generate` (installs nothing; needs
   Python 3.12).
4. Rebuild the vectors if the wire shape changed: `make -C sdks vectors`.
5. Run `make -C sdks check test`.

Removing or renaming anything is a breaking contract change; bump the SDK
minor/major version per [`../README.md`](../README.md#versioning-policy).

## Provenance

`SPEC_FINGERPRINT` (sha256 of the canonical JSON) is embedded in every SDK and
in every vector, so a client and fixture from different spec revisions fail
loudly instead of silently decoding the wrong layout.
