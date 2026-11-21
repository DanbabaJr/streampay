# WASM plugin filters (issue #580)

Small WASM filter/transform plugins that run sandboxed per subscription,
shaping the event stream server-side — field projection, predicate
filtering, enrichment — without a custom indexer fork.

## ABI (version 1)

A plugin is a WebAssembly module with **no imports**. It must export:

- `memory` — linear memory, at least 1 page, with a declared maximum no
  larger than 4 pages.
- `transform(inputPtr: i32, inputLen: i32) -> i32`

Memory layout (fits in one 64 KiB page):

| Region | Offset | Contents |
|---|---|---|
| Input | `0` | UTF-8 JSON of the full `DecodedEvent` (`bigint` as decimal strings) |
| Output | `32768` | UTF-8 JSON reply written by the plugin |
| Plugin data | `60000` | Constant data (reply templates, match needles) |

`transform` returns the reply length in bytes, or `-1` to drop the event.
Any other negative value, or a length above 32 KiB, is a host error and
the invocation falls back to the raw stream.

Reply shape: a JSON object. If it has a `data` object, that becomes the
event's new `data`. Any other top-level key that is not an envelope key
(`id`, `pagingToken`, `ledger`, `ledgerClosedAt`, `contractId`, `name`,
`streamId`, `txHash`, `traceId`, `spanId`, `linkedSpanContext`) is merged
into `data` — that is how a plugin enriches an event. Without a `data`
key, the reply object minus envelope keys *is* the new data. Envelope
fields are always taken from the input: a plugin cannot rewrite an
event's id, ledger, name or stream id.

## What a plugin cannot do

With no imports it has no host functions to call: no I/O, no network, no
clock, no randomness, no state outside its own linear memory. It sees
only the one event it is given. Validation rejects any module with an
import (naming it, e.g. `wasi_snapshot_preview1.fd_write`), a start
section, no memory maximum, or a maximum above the cap — before it runs.

## Identity, versioning, approval

- A plugin's id is the hex SHA-256 of its exact bytes (`pluginDigest`).
  Same bytes, same id; different bytes, different id.
- A `version` string (e.g. `1.2.0`) is stored as metadata alongside the
  digest; a digest cannot be re-registered under a different version.
- A plugin cannot run for a tenant until that tenant approves that exact
  digest (`WasmPluginRegistry.approve`). Approvals and plugin bytes live
  in SQLite (`wasm_plugins`, `wasm_plugin_approvals`) and are mirrored in
  memory; `StreamStore` owns one registry over its database.

## Resource bounds ("fuel")

V8 exposes no instruction fuel counter, so fuel is a proxy:

- **Wall-clock** per invocation (default 500 ms, env
  `WASM_PLUGIN_TIMEOUT_MS`, max 5000 ms), enforced by running the
  transform in a `node:worker_threads` worker and terminating the worker
  on expiry. An infinite loop or unbounded `memory.grow` loop is killed;
  the subscription falls back to the raw stream with an alert, and
  ingestion never stalls. The budget must exceed worker spawn time
  (~250 ms measured in this sandbox; a pool would cut that) — a budget
  below spawn time times out every invocation, so keep it above that
  floor when tuning.
- **Memory cap** (4 pages), enforced at validation from the module's
  declared maximum.
- **Input/output size caps** (32 KiB each).

## Dispatch and fallback

`PluginDispatcher` binds one approved plugin to one subscription id.
Dispatch order per event:

```
raw event → plugin transform → redaction → subscriber
```

Outcomes: `transformed`, `dropped` (plugin returned `-1`), `passthrough`
(no subscription bound), `fallback` (plugin unknown/unapproved, trapped,
timed out, or replied with garbage). A fallback delivers the raw event
and records an alert in `fallbackLog` (and via `onFallback`, which the
server wires to a warning log; the API exposes `GET /api/wasm/fallbacks`).

## Privacy redaction — after transforms, never before

`src/redaction.ts` truncates full Stellar addresses in event `data` to
the 8-character prefix (`sanitizeAddress`) when redaction is enabled
(env `WASM_REDACTION_ENABLED=1`). It runs downstream of the plugin on
every path (transformed, passthrough, fallback), so a plugin that emits
a full address in its output still has it redacted. Disabled by default,
so existing delivery behaviour is unchanged unless an operator opts in.

## HTTP API

Present only when the server was started with a dispatcher configured
(`run()` always configures one).

- `POST /api/wasm/plugins` — `{ bytesBase64, version, name? }` → `201 { digest, version, name, size }` (400 for an invalid module)
- `GET /api/wasm/plugins` — registered plugins (digests, versions, sizes)
- `POST /api/wasm/plugins/:digest/approve` — `{ tenant }`
- `POST /api/wasm/plugins/:digest/revoke` — `{ tenant }`
- `POST /api/wasm/subscriptions` — `{ subscriptionId, tenant, pluginDigest }`
- `DELETE /api/wasm/subscriptions/:id`
- `GET /api/wasm/fallbacks` — recent fallback alerts (last 100)

SSE opt-in: `GET /events/stream?tenant=<tenant>&plugin=<digest>`
runs live *and* replayed events for that connection through the tenant's
approved plugin, in journal order (dispatch is serialised per
connection; live events arriving during replay are buffered, not
reordered). Dropped events are not written. Without those query params,
SSE behaves exactly as before.

## Example plugin

The example plugin drops `withdrawn` events and passes everything else
through unchanged. It is built on demand by
`buildDropIfContainsPlugin("withdrawn")` in `builder.ts` — there is no WAT
toolchain in this repo, so example and test plugins are hand-encoded there
(see the builder's header comment). The generated module is 189 bytes with
sha256
`e58bcb8d09b2816cc9f2d11044964092367651cc14adea3066dc358982590905`
(pinned by `wasm.test.ts`); no binary is checked in.

## Conformance vectors

`conformance-vectors.json` lists input events and expected outputs for
the `passthrough`, `drop-withdrawn`, `project` and `enrich` plugins.
`wasm.test.ts` runs every vector through the real host (worker included)
and re-runs it to prove determinism: same input + same plugin digest
always yields the same output.

## Files

| File | Role |
|---|---|
| `abi.ts` | ABI constants, limits, digest, reply-shape docs |
| `validate.ts` | Import/memory/start-section validation (no instantiation) |
| `builder.ts` | Hand-encoded example/hostile plugin builders |
| `worker.ts` | Worker-thread entry point: instantiate, call, reply |
| `host.ts` | Per-invocation worker spawn, timeout, reply parsing |
| `registry.ts` | Content-addressed registry + per-tenant approvals (SQLite) |
| `dispatcher.ts` | Per-subscription dispatch, fallback + alerts, redaction last |
| `conformance-vectors.json` | Determinism vectors |
