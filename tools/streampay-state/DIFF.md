# `streampay-state diff`

Compares two state snapshots (see `export`) and reports what was added, removed
or changed per key family, with field-level deltas. Use it to compare a
snapshot before and after an incident, or the exports of two RPC providers.

```text
streampay-state diff --a <before.json> --b <after.json> [--format text|json] [--include-provenance]
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The snapshots are identical. |
| `1` | Differences were found. |
| `2` | Error: a file is missing or unreadable, is not valid snapshot JSON, a required field is missing or mistyped, a family contains a duplicate key, or the arguments are invalid. **Nothing is written to stdout.** |

Errors are always detected before the first byte of the report is written, so a
script can rely on `stdout` being empty whenever the exit code is `2`.

```bash
streampay-state diff --a before.json --b after.json --format json > diff.json
case $? in
  0) echo "identical" ;;
  1) echo "differences in diff.json" ;;
  *) echo "diff failed" >&2 ;;
esac
```

## What is compared

Records are matched by key and compared field by field, using the same model
(`model.rs`) as `export` and `verify`.

| Family | Key |
|---|---|
| `streams` | `id` |
| `scheduled_intents` | `id` |
| `treasuries` | `token` |
| `stream_fees` | `stream_id` and `token` |
| `sender_indexes`, `recipient_indexes` | `address` (the `stream_ids` list is compared in order: the indexes are append-only and creation-ordered) |

The order of records inside a file does not matter. Two keys that are equal
within one family make the file ambiguous, so that is an error (`2`), not a
difference; run `verify` on the file.

Header fields come in two kinds:

- **state**: `schema_version`, `schema_fingerprint`, `contract_id`,
  `contract_schema_version`, `contract_frozen`, `governor`. Any change is a
  difference.
- **provenance**: `exported_at`, `rpc_url`, `latest_ledger`. They describe how
  and when a snapshot was taken, so they differ between any two exports. They
  are **reported but not counted** unless `--include-provenance` is given.

## Determinism and memory

The report is a pure function of the two files: records are visited in key
order and fields in the order declared in `model.rs`, so two runs produce
byte-identical output.

Each snapshot is parsed once and held once. Records are sorted by reference
(never cloned) and the two sorted views are merge-walked, writing each change
to stdout as it is found. A first pass only counts, so the summary can come
first. The diff itself is never collected in memory, so its size does not add to
the footprint; peak memory is about two parsed snapshots. (The snapshot file
format is a single JSON document, so each file is still parsed in full.)

## JSON report (`--format json`)

Amounts (`i128`) are decimal **strings**, as in the `verify` report.

```json
{
  "report_version": 1,
  "identical": false,
  "include_provenance": false,
  "inputs": { "a": "before.json", "b": "after.json" },
  "summary": {
    "header": { "state_changed": 0, "provenance_changed": 3 },
    "families": {
      "streams": { "added": 1, "removed": 0, "changed": 2 },
      "scheduled_intents": { "added": 0, "removed": 0, "changed": 0 },
      "treasuries": { "added": 0, "removed": 0, "changed": 0 },
      "stream_fees": { "added": 0, "removed": 0, "changed": 0 },
      "sender_indexes": { "added": 0, "removed": 0, "changed": 0 },
      "recipient_indexes": { "added": 0, "removed": 0, "changed": 0 }
    }
  },
  "header": [
    { "field": "exported_at", "kind": "provenance", "from": 1700000000, "to": 1700009999 }
  ],
  "changes": [
    { "family": "streams", "change": "changed", "key": 1,
      "fields": [ { "field": "withdrawn", "from": "1000", "to": "2000" } ] },
    { "family": "streams", "change": "added", "key": 5,
      "record": { "sender": "G…", "deposit": "250", "status": "Active" } }
  ]
}
```

- `changes` is ordered by family (as in `summary.families`), then by key.
- `change` is `added` or `removed` (with the full `record`), or `changed` (with
  `fields`, only the fields that differ).
- `key` is a number for ids, a string for addresses and tokens, and
  `{ "stream_id", "token" }` for fee records.
- `A` is the "before" side: a record only in A is `removed`, only in B `added`.

## Tests

`cargo test -p streampay-state` runs `tests/diff_cli.rs` against the snapshots in
[`tests/fixtures/diff/`](./tests/fixtures/diff): identical, added, removed
(inputs swapped), changed-field, provenance-only and state-header changes, and
five corrupt inputs (garbage, truncated, missing field, wrong type, duplicate
keys). It also checks byte-identical repeat runs, record-order independence and a
30,000-stream snapshot.
