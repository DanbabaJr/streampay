# Indexer ingestion: parallel ledger windows with ordering guarantees

Implements [issue #117](https://github.com/streampay/streampay/issues/117). The indexer used to
walk Soroban's `getEvents` cursor one page at a time, so catching up a backlog cost
`requests x latency` with no overlap. This document describes the replacement, why it produces
exactly the same database state as the old walk, and what it actually buys.

Code: `indexer/src/ingest/planner.ts` (pure planning), `indexer/src/ingest/sequencer.ts`
(per-stream ordering and gap accounting), `indexer/src/ingest/pipeline.ts` (fetch, reorder,
commit), `indexer/src/rpc-manager.ts` (the rate budget the depth is read from).
Tests: `indexer/src/ingest/pipeline.test.ts` (42 cases, including the reordering torture test).
Benchmark: `perf/harness/synthetic_archive.mjs` + `perf/harness/indexer_parallel_bench.mjs`.

## The shape of it

One tick does this:

1. Read the tip (`getLatestLedger`) and the durable windowed position.
2. Size and tile the backlog `[position+1 .. tip-confirmations]` into **disjoint, contiguous**
   ledger windows, capped per tick.
3. Issue window reads up to `depth` in flight, where `depth` is derived from the RPC manager's
   own rate budget rather than a constant.
4. **Consume them in plan order** through a reorder buffer, and commit each complete window.
5. Record the position and the observed event density for the next tick.

## Correctness argument

The claim is: after any sequence of ticks, the database equals the database the serial cursor
walk would have produced over the same ledgers. Four properties compose into it.

**1. The partition is disjoint and contiguous.** `planWindows` emits
`{from,to}` ranges where `window[i].to + 1 === window[i+1].from`, no ledger appears in two
windows, and no ledger in the backlog appears in none. Every event belongs to exactly one
window, so concatenating window results in plan order reproduces the serial ordering — this is
what makes the parallel fetch a re-shard of the same read instead of a different read.

**2. A window is only committed when it is proven complete.** `readWindow` returns
`{events, through, complete}`. `complete` is true only under one of two rules:

- **Rule 1 — an event past the upper bound.** The response contained an event with
  `ledger > window.to`, so the endpoint demonstrably served everything up to `window.to`.
- **Rule 2 — a short page from an endpoint that is caught up.** The page returned fewer events
  than `pageLimit`, and *that endpoint's own* `latestLedger >= window.to`. A short page from a
  lagging replica proves nothing, so the window is not committed and the tick stops at the
  lagging boundary (`caughtUp = false`) rather than committing later windows out of order.

A window denser than `maxPagesPerWindow x pageLimit` is committed only up to the last ledger
whose page was fully drained, and that boundary ledger is re-read next tick. Position tracking
moves only over proven-complete ledgers, and the page cursor is deliberately *not* persisted on
the windowed path — a cursor from a window that proved complete by reading past its bound points
beyond that bound, and resuming from it would skip the windows in between.

**3. Commits happen in plan order.** `fill()` may issue up to `depth` reads concurrently, but the
loop always awaits `pending.shift()`, the oldest outstanding window. So arrival order is
irrelevant: a window that answers in 300ms does not commit ahead of one that takes 3s. The
torture test in `pipeline.test.ts` makes an endpoint whose latency *inverts* with ledger range
and asserts the final snapshot (streams + every journalled event row) is `deepEqual` to the
depth-1 reference, that responses really did land out of order, and that the reorder buffer
actually filled to the derived depth.

**4. Writes are exactly-once and monotonic.** `store.ingestPage` inserts events with
`INSERT OR IGNORE` keyed on the event id, and projects streams with
`ON CONFLICT(stream_id) DO UPDATE ... WHERE excluded.last_ledger >= streams.last_ledger`. When
the guard rejects an update, `ingestPage` reports it as a `projectionSkips` rather than silently
writing. Even if ordering were somehow broken, a stale event could be journalled but could never
rewind a stream's projection — the guard is the last line of defence, and the tests assert it is
*not needed* when commits stay ordered (`projectionSkips === 0`).

**Per-stream sequencing and gap detection.** `Sequencer` tracks each stream's last journalled
ledger and classifies an event older than the committed position as `late`, and classifies a
resume point that jumps forward as a coverage `gap` with the number of skipped ledgers. Both are
surfaced on the tick report and the stats route instead of being swallowed, and it is seeded
from durable state so a restart still sees lateness. Duplicate delivery (the ordinary kind:
overlapping re-reads at a window boundary) is counted in `duplicates` and changes nothing.

**Migration.** A database that has a legacy `cursor` and no windowed position runs the old
cursor walk for one tick, which records a position; later ticks window from it. `INGEST_PARALLEL=0`
selects the cursor walk permanently — that path is kept, tested, and bounded per tick so an
endpoint that ignores cursors cannot spin inside one poll.

## Where the concurrency comes from

### Depth: the budget, not a magic number

`deriveInFlight` applies Little's law to the live `RateBudgetSnapshot` from `RpcManager`
(issue #56):

```
depth = clamp(1 .. maxInFlight, floor(maxRps x observedLatencyMs / 1000 / perRead),
                     floor(availableTokens / perRead))
```

`perRead` is 2 when hedged reads are on — `RpcManager.call()` spends one token but the
*endpoints* see two requests when the primary stalls, and a 429 storm is an endpoint phenomenon.
Before the first response lands, latency is unmeasured and depth is 1: the tick starts serial and
opens itself up as the endpoint's speed becomes known. Depth is re-derived at every admission,
not once per tick, because both the EWMA and the token bucket move while windows are in flight.
`INGEST_MAX_IN_FLIGHT` can only lower this ceiling; it cannot raise the budget. That is the
property the "budget-capped" bench row demonstrates: at `RPC_MAX_RPS=8` the same configuration
derives depth 2 and runs at roughly the depth-2 time, not the depth-8 time.

### Window size: observed density, not a constant

Windowing trades request *count* for latency hiding, so a fixed window size is wrong in both
directions: too small and a sparse backlog needs thousands of empty reads, too large and a dense
one blows past the page budget. Each tick re-sizes windows from a durable EWMA of events per
ledger (`ingest_density`, alpha 0.4):

```
windowLedgers = clamp(1 .. maxWindowLedgers, round(pageLimit / eventsPerLedger), spread)
```

where `spread = ceil(backlog ledgers / maxWindowsPerTick)` — so a backlog wider than the per-tick
cap still makes bounded progress instead of stalling, and the ceiling still binds.

While density is unknown the tick uses `PROBE_WINDOWS = 4` wide windows as a sample, then plans
from the measurement. Four is deliberate: a larger probe made the *first* tick slower than the
cursor walk it replaces, which is the opposite of the point.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `INGEST_PAGE_LIMIT` | `1000` | Events per `getEvents` page; also the target events per window. |
| `INGEST_WINDOW_LEDGERS` | `20` | Cold-start floor for the window size, before density is measured. |
| `INGEST_MAX_WINDOW_LEDGERS` | `5000` | Ceiling on a sparse backlog's window size. |
| `INGEST_MAX_WINDOWS_PER_TICK` | `200` | Windows planned per tick; also the serial path's requests-per-tick bound. |
| `INGEST_MAX_IN_FLIGHT` | `8` | Ceiling the budget-derived depth can be lowered to, never raised above. |
| `INGEST_CONFIRMATIONS` | `0` | Ledgers of finality kept off the tip. |
| `INGEST_MAX_PAGES_PER_WINDOW` | `8` | Pages per window before it commits a partial range and defers the rest. |
| `INGEST_PARALLEL` | `1` | `0` pins the pipeline to the legacy serial cursor walk. |
| `RPC_MAX_RPS` | `10` | The rate budget the depth is derived from (issue #56). |

## Throughput

**DECLARED SYNTHETIC.** `perf/harness/synthetic_archive.mjs` generates a deterministic StreamPay
event archive (`stream_created`, `withdrawn`, `stream_topped_up`, `stream_cancelled`, seeded
mulberry32, sortable by ledger then stream id). Nothing is captured from mainnet and no network
is touched: the Soroban endpoint is an in-process function that sleeps for a configured latency
before answering from the archive, with a real binary search over ledger ranges. What *is* real is
everything the indexer does — the production `RpcManager` (token bucket, endpoint health, latency
EWMA), the production XDR `decoder`, the production SQLite `store` and the production pipeline.
Read these as "what the fetch strategy costs at this latency", not as a mainnet measurement.

Generator: `--streams=1500 --span=150000 --seed=20261017` -> 8,004 events over 150,000 ledgers
(~0.053 events/ledger), which is the right order of magnitude for a contract that has been live
for a few months. Reproduce with:

```sh
npm --prefix indexer run bench:ingest                        # page limit 1000
npm --prefix indexer run bench:ingest -- --page-limit=100 --depths=1,2,4,8,16
```

### Store-bound: page limit 1000, latency 250 ms

| scenario | derived depth | window ledgers | requests | ticks | events | wall ms | network ms | store ms | events/s | vs serial |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| serial cursor walk (before #117) | 1 | 0 | 9 | 1 | 8,004 | 7,400 | 2,250 | 4,263 | 1,082 | 1.00x |
| windowed depth 2 | 2 | 18,727 | 16 | 2 | 8,004 | 7,143 | 4,000 | 4,494 | 1,120 | 1.04x |
| windowed depth 4 | 4 | 18,727 | 16 | 2 | 8,004 | 6,393 | 4,000 | 4,334 | 1,252 | 1.16x |
| windowed depth 8 | 8 | 18,727 | 16 | 2 | 8,004 | 6,202 | 4,000 | 4,189 | 1,290 | 1.19x |
| windowed depth 8, budget-capped (maxRps 8) | 4 | 18,727 | 16 | 2 | 8,004 | 6,512 | 4,000 | 3,860 | 1,229 | 1.14x |
| windowed depth 8, hedged reads (2 endpoints) | 8 | 18,727 | 16 | 2 | 8,004 | 6,383 | 4,000 | 4,341 | 1,254 | 1.16x |

Both runs print the same state digest for every scenario (`fb32431186d81e85`).

Here SQLite is the floor: 8,004 events cost ~4.2s of `ingestPage` no matter how the reads were
scheduled, and only 9 requests were needed in the first place, so there is almost no latency to
hide. Parallelism gains 19% at depth 8 and the derived depth drops from 8 to 4 under
`RPC_MAX_RPS=8`, which is the intended behaviour, not a regression. **The honest conclusion for a
sparse archive is that windowing costs almost nothing and buys almost nothing.** Its value in this
regime is that the 150,000-ledger backlog is covered in 16 requests instead of an unbounded
cursor grind, with the same final state.

### Network-bound: page limit 100, latency 250 ms

Same archive, so the fetch strategy has to do the work instead of the store:

| scenario | derived depth | window ledgers | requests | ticks | events | wall ms | network ms | store ms | events/s | vs serial |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| serial cursor walk (before #117) | 1 | 0 | 81 | 1 | 8,004 | 26,480 | 20,250 | 4,733 | 302 | 1.00x |
| windowed depth 1 | 1 | 1,867 | 123 | 2 | 8,005 | 36,881 | 30,750 | 4,319 | 217 | 0.72x |
| windowed depth 2 | 2 | 1,867 | 123 | 2 | 8,005 | 21,090 | 30,750 | 4,395 | 380 | 1.26x |
| windowed depth 4 | 4 | 1,867 | 123 | 2 | 8,005 | 13,534 | 30,750 | 4,740 | 591 | 1.96x |
| windowed depth 8 | 8 | 1,867 | 123 | 2 | 8,005 | 10,530 | 30,750 | 4,667 | 760 | 2.51x |
| windowed depth 16 | 16 | 1,867 | 123 | 2 | 8,005 | 8,436 | 30,750 | 3,872 | 949 | 3.14x |
| windowed depth 8, budget-capped (maxRps 8) | 2 | 1,867 | 123 | 2 | 8,005 | 21,426 | 30,750 | 4,518 | 374 | 1.24x |
| windowed depth 8, hedged reads (2 endpoints) | 8 | 1,867 | 123 | 2 | 8,005 | 10,501 | 30,750 | 4,525 | 762 | 2.52x |

All eight scenarios finish with the same state digest (`fb32431186d81e85`), the same 8,004 rows,
zero projection rewinds and every event inserted exactly once. The `8,005 events` column counts
events *seen*, which is one higher than inserted: the window boundary re-read delivers one
already-journalled id, and the journal ignores it. That duplicate is the mechanism, not an
accident.

What the numbers say:

- **2.5x at the default depth, 3.1x at depth 16** for a backlog where round trips dominate.
  `network ms` is the *sum* of request times, not the critical path — 30,750 ms of it fits inside
  8,436 ms of wall time because 16 windows were in flight.
- **Depth 1 is slower than the serial walk (0.72x).** Proving a window complete costs an extra
  request whenever a page comes back exactly full (Rule 1 needs to read past the bound), so
  windowing issues 123 requests where the cursor walk needed 81. Without overlap that overhead is
  pure loss. This only happens while the endpoint's latency is unmeasured, i.e. for the first
  response of a tick, which is why depth is re-derived at every admission rather than pinned.
- **The budget binds visibly**: `RPC_MAX_RPS=8` derives depth 2 and lands at 21,426 ms, within
  noise of the hand-set depth-2 run — the pipeline cannot out-spend the manager.
- **Hedged reads cost the expected amount**: identical wall time here, because the simulated
  endpoints never stall; the depth charge (2 requests per read) is what protects the endpoints.

## Caveats worth knowing

- The serial path sends the `getEvents` cursor at the **top level** of `params`, which is what the
  existing indexer has always done; a stock Soroban client nests it under `pagination`. The
  windowed path resumes from `ingest_ledger`, so it never depends on that quirk, and the bench's
  simulated node accepts either placement.
- `maxWindowLedgers` truncates the probe as well as steady-state plans, so a very sparse backlog
  with a tight ceiling takes several ticks to reach the tip. `caughtUp` reports that honestly
  rather than calling a capped plan a catch-up.
- The bench measures one process, one in-memory SQLite database, and an endpoint that never
  returns a 429 or a lagging `latestLedger`. Those paths are covered by tests, not by this table.
