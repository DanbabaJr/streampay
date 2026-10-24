# Event schema registry

The contract's event shapes are a **public interface**: the indexer, the
frontend, and third-party consumers decode them. This directory is the
canonical, machine-readable definition of every emitted event — topic layout,
data fields, versions — generated from the contract code and protected by a
CI compatibility gate.

```
schemas/events/
├── registry.json          # flat fingerprint table (source of truth for gates)
├── CHANGELOG.md           # additive-only evolution record (gate-enforced)
├── README.md              # this document
└── v1/                    # registry version 1 — coexists with future v2/
    ├── catalog.json       # v1 event list with fingerprints
    └── events/            # one JSON Schema per event (draft 2020-12)
        └── <event_key>.json
```

## How it works

- **Generated, never hand-edited.** `npm run generated:events` (or
  `cargo test -p streampay-contract --lib --locked event_registry::generate -- --ignored`
  followed by `node scripts/generate_event_types.mjs`) parses every
  `#[contractevent]` struct out of the crate sources with `syn` and rewrites
  this directory plus the consumer artifacts — the same "code is the source of
  truth, artifact is generated" pattern as `surface.rs` /
  `docs/ERROR_SURFACE.md`.
- **In-crate pin.** `event_registry::registry_matches_contract_event_structs`
  re-derives the whole registry in memory and compares it against the
  committed `registry.json` field-for-field: any struct change without a
  registry regeneration fails `cargo test`.
- **Declaration gate.** `event_registry::no_event_is_emitted_that_the_registry_does_not_declare`
  walks every `publish()` call site in the crate and fails if it does not name
  a declared event — and fails if a declared event has no publish site at all.
  This is `surface.rs`'s rule ("every rejection branch must be declared")
  turned around for the emit side: nothing reaches the wire before the
  registry knows about it, and the registry never promises an event that
  nothing emits.
- **CI compatibility gate.** `scripts/event_compat_check.mjs` diffs the
  registry across the PR merge base (CI step *Event schema registry*). Removals
  and type changes fail the build; additions warn and must be recorded in
  [`CHANGELOG.md`](CHANGELOG.md), or the gate fails.
- **Drift gate.** CI re-runs the generator plus `scripts/generate_event_types.mjs`
  and fails on any `git diff` of `schemas/events/`, `docs/EVENTS.md`,
  `indexer/src/generated/events.ts` or `frontend/lib/generated/events.ts`.
- **Codegen consumers.** TypeScript types for every event are generated into
  `indexer/src/generated/events.ts` and `frontend/lib/generated/events.ts`
  from this registry (interfaces, `EVENT_KEYS`, `EVENT_SHAPES`,
  `EVENT_FINGERPRINTS`). The indexer's `decodeEvent` validates topics and
  required data fields against the registry table; the frontend decodes
  `StreamPolicy` through the generated type.

## Compatibility rules (enforced)

| Change | Verdict |
| --- | --- |
| Remove/rename an event or event key | **FAIL** — breaking |
| Remove/rename/re-type/re-order a **topic** field | **FAIL** — topics are positional XDR |
| Remove or re-type a **data** field | **FAIL** — consumers decode by name |
| Re-order data fields | pass — the wire map is symbol-keyed (order-neutral) |
| Remove/rename/re-type a field of a referenced struct (e.g. `StreamPolicy`) | **FAIL** — every referencing event inherits it |
| Add a new event | warn + **required CHANGELOG entry** |
| Add a data field | warn + **required CHANGELOG entry** |
| Add a topic field | warn + **required CHANGELOG entry** (consumers decode positionally) |

| Remove/rename/re-type a field of a referenced struct (e.g. `StreamPolicy`) | **FAIL** — every referencing event inherits it |
| Remove/rename a variant of a referenced enum (e.g. `OwnershipRole`) | **FAIL** — events encode the variant symbol on the wire |
| Add a new event | warn + **required CHANGELOG entry** |
| Add a data field | warn + **required CHANGELOG entry** |
| Add a topic field | warn + **required CHANGELOG entry** (consumers decode positionally) |
| Add an enum variant | warn + **required CHANGELOG entry** |

## Workflow for changing an event

1. Edit `contracts/streaming-payments/src/events.rs` (additive only), wire the
   new field into its `publish()` call site, and regenerate.
2. Regenerate:
   ```bash
   cargo test -p streampay-contract --lib --locked event_registry::generate -- --ignored
   node scripts/generate_event_types.mjs
   ```
3. Record the addition in [`CHANGELOG.md`](CHANGELOG.md) — mention the event
   struct name and each new field name (the gate greps for them).
4. **Commit the struct change, the `publish()` site and the regenerated
   registry together.** The declaration gate makes an unregistered `publish()`
   fail to pass `cargo test`, and the drift gate makes a stale registry fail
   CI — so a half-landed change is never mergeable in the first place.
5. CI proves it: stale-registry test, declaration gate, generation drift gate,
   compatibility gate, and the seeded rename demo below.

To see the gate go red the way CI would: rename a field in `StreamCreated`,
run the two regeneration commands, then

```bash
node scripts/event_compat_check.mjs --base "$(git merge-base HEAD origin/main)"
```

`cargo test` fails first (`registry_matches_contract_event_structs` prints
the per-event fingerprint diff); if you bypass that by regenerating, the
compatibility checker prints `REMOVED data field StreamCreated.sender …`
plus a `MISSING CHANGELOG` error for the new name. The automated version of
this demo runs in CI: `node --test scripts/event_compat_check.test.mjs`.

## Versioning: v1 + v2 coexistence

`registry.json` carries `registry_version`, and all JSON Schemas live under
the matching `vN/` directory. During a governed breaking migration:

- `v1/` stays published **unchanged** while consumers move over;
- `v2/` is added next to it with the new shapes, `registry_version: 2`;
- consumers pin the version they decode (`docs/EVENTS.md` and the TS codegen
  read the current version; the compatibility gate's FAIL verdict is what a
  v1→v2 migration must formally override through the ADR/governance path).

For normal evolution this never triggers: the contract is additive-only, so
every change lands inside the current version directory.

## Third-party consumption

Each `v1/events/<event_key>.json` is standalone JSON Schema (draft 2020-12)
with the topic layout in `x-streampay.topics` / `x-streampay.topicSchema` and
the data map in `properties`. `registry.json`'s `fingerprints` table lets any
consumer assert — without parsing — that they are decoding exactly the shape
they tested against.
