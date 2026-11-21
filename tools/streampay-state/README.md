# streampay-state

Backup, verification and sandbox-replay tool for StreamPay contract storage.

```text
streampay-state export --rpc <url> --contract <C...> --out <snapshot.json>
streampay-state verify --snapshot <snapshot.json> [--format text|json]
streampay-state replay --snapshot <snapshot.json> --rpc <url> --contract <C...>
```

`replay` runs `verify` first and stops on any violation.

## `verify`

Checks a snapshot for internal consistency. The exit code is **0** when no
invariant is violated and **1** otherwise (also when the snapshot cannot be read
or parsed; see [Errors](#errors-and-exit-codes)).

- `--format text` (default): a human summary. Meant for people; do not parse it.
- `--format json`: the versioned report below, on stdout.

```bash
streampay-state verify --snapshot snapshot.json --format json | jq '.ok, .violations'
```

### JSON report, v1

The contract is the JSON Schema [`json-schema-v1.json`](./json-schema-v1.json)
(draft 2020-12). Example (abridged):

```json
{
  "report_version": 1,
  "tool_version": "0.1.0",
  "ok": false,
  "snapshot": { "schema_version": 1, "schema_fingerprint": "…", "expected_schema_fingerprint": "…",
                "contract_id": "C…", "latest_ledger": 123456, "exported_at": 1700000000 },
  "counts": { "streams": 6, "scheduled_intents": 1, "treasuries": 1, "stream_fees": 2 },
  "violations": [
    { "check": "stream_arithmetic", "message": "Stream 1: withdrawn 150 > deposit 100 (invariant violated)" }
  ],
  "unclaimed_by_token": [ { "token": "C…", "unclaimed": "100" } ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `report_version` | integer, always `1` | Version of this contract. |
| `tool_version` | string | Version of the `streampay-state` binary that produced the report. |
| `ok` | boolean | `true` exactly when `violations` is empty; the exit code is `0` only then. |
| `snapshot.schema_version` | integer | Format version recorded in the snapshot. |
| `snapshot.schema_fingerprint` | string | Fingerprint recorded in the snapshot. |
| `snapshot.expected_schema_fingerprint` | string | Fingerprint this build understands. A difference is a `schema_fingerprint` violation. |
| `snapshot.contract_id` | string | Contract the snapshot was exported from. |
| `snapshot.latest_ledger` | integer | Ledger sequence at export time. |
| `snapshot.exported_at` | integer | Export time, Unix seconds. |
| `counts.streams` / `scheduled_intents` / `treasuries` / `stream_fees` | integer | Rows of each kind in the snapshot. |
| `violations[]` | array | Every violation found; empty when `ok`. |
| `violations[].check` | string | Stable identifier of the failed invariant (table below). Match on this. |
| `violations[].message` | string | Human-readable detail. The wording is **not** part of the contract. |
| `unclaimed_by_token[]` | array | Per token, `deposit - withdrawn` summed over `Active` streams, sorted by `token`. Tokens with no active stream are omitted. |
| `unclaimed_by_token[].token` | string | Token contract address. |
| `unclaimed_by_token[].unclaimed` | string | Decimal integer. Amounts are `i128`, so they are strings: parse with `BigInt`, never `Number`. |

#### `check` identifiers

| `check` | Invariant |
|---|---|
| `schema_fingerprint` | The snapshot's fingerprint matches this build's. |
| `stream_arithmetic` | Per stream: `withdrawn >= 0`, `deposit > 0`, `withdrawn <= deposit`; `Depleted` means `withdrawn == deposit`; status is one of `Active`, `Depleted`, `Cancelled`. |
| `duplicate_stream_ids` | Stream ids are unique. |
| `treasury_invariant` | Per token, `charged_total` equals the sum of stream fees, and `withdrawn_total <= charged_total`. |
| `index_completeness` | Every id in the sender and recipient indexes exists in `streams`. |
| `orphan_fee` | Every fee record references an existing stream. |
| `intent_arithmetic` | For scheduled intents, `occurrences_remaining <= occurrences_total`. |

### Compatibility policy

Downstream scripts and drills may depend on this report. Within v1 it is
**additive-only**:

- Fields, `check` identifiers and their types are never removed, renamed or
  re-typed, and `report_version` stays `1`.
- New optional fields and new `check` identifiers **may** be added. Consumers
  must ignore unknown properties and tolerate an unknown `check` value (treat it
  as a violation).
- The schema deliberately sets no `additionalProperties: false` for that reason.
- Anything breaking ships as `json-schema-v2.json` with `report_version: 2`; v1
  stays published and the tool keeps the ability to emit it for a deprecation
  period announced in `CHANGELOG.md`.
- `message` text and the order of `violations` are not part of the contract.

### Errors and exit codes

If the snapshot cannot be read or parsed, **no report is printed**: stdout is
empty, `error: …` goes to stderr and the exit code is `1`. Check the exit code
and that stdout parses before reading `ok`.

### Tests

`cargo test -p streampay-state` runs `verify --format json` over the snapshots in
[`tests/fixtures/`](./tests/fixtures) (`empty`, `valid`, and `all-violations`,
which triggers every `check`), validates every report against the schema, and
checks that the schema itself is valid draft 2020-12. When you add a check:
append its identifier (never reuse one), add it to the table above, the
`CHECKS` list in `tests/verify_report.rs` and the fixture, and describe it in
the schema.
