# StreamPay TTL sentinel

Watches the storage TTL of every piece of StreamPay state, projects when each
entry archives, alerts before it does — and, as a **separate, optional**
component, can extend TTLs from a funded key of its own.

```text
   scan (read-only core)                 extend (optional, off by default)
   ─────────────────────                 ──────────────────────────────────
   counter-driven enumeration            its own key, its own budget
   getLedgerEntries → liveUntilLedger    ExtendFootprintTTL, ≥ threshold only
   cliff-aware projections               dry-run by default
   alerts: console / JSONL / webhook     never loaded by `scan`
```

The core never needs a key: alerting is read-only, and the extender is a
separate command with its own key, budget and opt-in.

## Quick start

```bash
cd infra/ttl-sentinel
npm ci
npm test                                     # unit tests + fast-forward ledger scenarios (offline)

export STREAMPAY_CONTRACT_ID=C...            # your deployed contract
npm run scan -- --json                       # one pass
npm run scan -- --watch                      # loop every scanIntervalSec
npm run rent -- --streams 1000               # cost projection (see below)
```

Config file (all fields optional; see `ttl-sentinel.config.example.json`):

```bash
node dist/src/cli.js scan --config ./ttl-sentinel.config.json
```

Env overrides: `STREAMPAY_CONTRACT_ID`, `TTL_SENTINEL_RPC_URL`,
`TTL_SENTINEL_WEBHOOK_URL`, `TTL_SENTINEL_STATE_PATH`.

State lives next to `--state` (default `.ttl-sentinel.state.json`):
`.alerts.json` (alert dedup across restarts) and `.spender.json` (extender
budget meter).

## The math: true worst-case cliffs

Soroban TTL rules that decide everything here (verified against
`soroban-sdk`/`rs-soroban-env` and the protocol docs):

1. Writing a value (`persistent().set`) does **not** move `liveUntilLedger`.
   Only `extend_ttl` / `ExtendFootprintTTL` does.
2. `extend_ttl(key, threshold, extend_to)` extends **only if** the remaining
   TTL is below `threshold`, and then sets `liveUntil = now + extend_to`.
   It is a floor, never an exact value.
3. A brand-new persistent entry gets `min_persistent_entry_ttl`, counted
   inclusive of the creating ledger (`remaining = min - 1`).
4. An entry is live *through* its `liveUntilLedger`; it archives at the next
   ledger close.

StreamPay's contract (`contracts/streaming-payments/src/stream.rs`) uses
`extend_ttl(200_000, 500_000)` — but **only on stream and index keys**
(`put_stream`, `push_to_index`, `page_stream_ids`). Nothing extends
`DataKey::NextStreamId`, the contract instance entry, or the Wasm code entry.
From those four facts, the cliff per entry class falls out:

| class | key | extended on-chain? | worst case | best case | at 5 s/ledger |
|---|---|---|---|---|---|
| stream | `DataKey::Stream(id)` | yes, on every write | **200,000** ledgers | 500,000 | 11.6 d / 28.9 d |
| index | `SenderStreams(addr)` / `RecipientStreams(addr)` | yes, on write **and** page read | **200,000** | 500,000 | 11.6 d / 28.9 d |
| counter | `DataKey::NextStreamId` | **never** | **4,095** ledgers | 4,095 | **5.7 h** |
| instance | contract instance entry | **never** | **4,095** | 4,095 | **5.7 h** |
| code | Wasm code entry | **never** | **4,095** | 4,095 | **5.7 h** |

### Deriving the 200,000-ledger stream cliff

Take the last write that *ever* extends a stream entry: it sets
`liveUntil = L_ext + 500_000`. Any later write happens while
`remaining >= 200_000`, i.e. at most `500_000 - 200_000 = 300_000` ledgers
after `L_ext`, and does **not** extend anything. So the final write of the
entry's life happens no later than `L_ext + 300_000`, leaving at least

```text
500_000 - (500_000 - 200_000) = 200_000 ledgers
```

— and that bound is **tight**: a write at `remaining == 200_000` (or a
hair above) leaves exactly the cliff. `test/cliff.test.ts` replays 5,000
pseudo-random write sequences and asserts both the invariant and its
tightness; `test/constants-sync.test.ts` fails if the contract's constants or
its extension behaviour drift — including asserting that the counter is
*never* extended, which is what makes the 4,095-ledger cliff real.

### Deriving the 4,095-ledger cliffs — the finding that matters

`min_persistent_entry_ttl = 4_096` ledgers is **≈ 5.7 hours** at the 5 s
target, and:

- `next_stream_id()` does `get(&key).unwrap_or(1)` then `set(...)` with **no**
  `extend_ttl` — so the counter archives ~5.7 h after the first
  `create_stream` and is never refreshed. An archived counter is referenced by
  the next `create_stream` transaction's footprint, so creation fails (or
  forces a paid restore) until it is extended. **Stream creation is a
  ~6-hourly incident without external TTL maintenance.**
- Invoking a contract does **not** auto-extend its instance or code entries.
  A `stellar contract deploy` (no TTL flag) therefore leaves a deployment
  that bricks roughly 5.7 hours later, for every entrypoint — including
  `get_stream`. Restoring grants `min_persistent_entry_ttl` again: a ~6-hour
  treadmill unless the entries are *extended*, which is what the optional
  extender (`extendTo = 500_000` ≈ 28.9 d) does.

This is exactly why the sentinel models classes separately instead of using
one threshold: applying the stream schedule to the counter would page
critical on every freshly created stream (`test/fastforward.test.ts` asserts
that contrast explicitly).

### Schedule vs. cliff (the margin, justified)

Worst-case *scan gap* is computed at the **fastest credible cadence, 1 s per
ledger** (consecutive whole-second close times may differ by as little as one
second) — never at the 5 s target. With a 5-minute scan interval
(`scanIntervalSec = 300`):

| class | warn | crit | worst scan gap (1 s) | warn margin `cliff-(warn+gap)` | crit lead `crit-gap` |
|---|---:|---:|---:|---:|---:|
| stream / index | 150,000 (75 % of cliff) | 60,000 | 300 | **+49,700** ledgers (≈ 2.8 d @5 s) | 59,700 ledgers (≈ 3.5 d @5 s) |
| counter / instance / code | 3,000 (73 % of cliff) | 1,200 | 300 | **+795** ledgers (≈ 66 min @5 s) | 900 ledgers (≈ 75 min @5 s) |

`assertScheduleSafety()` runs on every `scan` and **refuses to run** with a
schedule whose warning could land outside its class cliff; config validation
enforces the weaker bound (`warn < cliff`) for every command. The margins in
the table are the provable ones for a *single* missed interval (1 ledger/s ×
300 s = 300 ledgers). `test/fastforward.test.ts` fast-forwards the ledger
scan-by-scan at a deliberately slower 3,000 s cadence (600 ledgers per gap)
and asserts the observed timings: the stream warns at 149,600 remaining, goes
critical at 59,600 and archives exactly at `liveUntil`; counter, instance and
code do the same on their 4,095-ledger cliff.

**Coverage vs. prevention.** An alert is *preventive* only if it fires while
remaining TTL > 0. The schedule tolerates outages up to
`warn - crit = 90,000` ledgers for streams (≈ 5.2 d at 5 s) and
`3,000 - 1,200 = 1,800` ledgers (≈ 2.5 h) for never-extended entries; beyond
that the sentinel detects expiry on resume but could not have prevented it
(asserted in the "missed scans" fast-forward test).

## Cost projection (input for the pricing and dust work)

Rent follows `rs-soroban-env::fees.rs` exactly, with CAP-0066 (protocol 23)
parameter values — floor 1,000 / state-target 10,000 stroops per 1 KB,
`persistent_rent_rate_denominator = 1215`, 3 GB live-state target, growth
factor 5,000 past it, and the 1/3 code-entry discount:

```text
rent_stroops = ceil(size_bytes × fee_per_rent_1kb × ledgers / (1024 × 1215))
```

Sizes are **measured**, not guessed: 504 B per `Stream` entry (the fixture in
`test/sizes.test.ts` mirrors the contract's `i128` fields and fails if the
struct changes), 92 B counter, 96 B instance, `136 + 12 × ids` B per index
entry, and the Wasm code entry is the Wasm size itself. `scan` measures every
entry from the chain and feeds the same projector.

Monthly rent at current scale (30 d = 518,400 ledgers at 5 s/ledger; 120 KB
Wasm placeholder; index entries pessimistically one id each):

| streams | XLM/month at floor fee (`≤ 2 GB` state) | XLM/month at 3 GB-target ceiling |
|---:|---:|---:|
| 1 | 1.708 | 17.078 |
| 100 | 5.008 | 50.078 |
| 1,000 | 35.008 | 350.078 |
| 10,000 | 335.009 | 3,350.079 |

Marginal cost is **0.021 XLM per live stream per month** (0.21 at the
ceiling) plus the fixed entries. Breakdown at 1,000 streams: 21.0 streams +
12.3 index + 1.7 code + 0.008 counter/instance.

Two consequences for the pricing/dust work:

- **Code rent dominates small deployments and is scale-invariant**: ~14.6 XLM
  per MiB of Wasm per month at the floor fee (145.6 at the ceiling) — 1.7 XLM/
  month for a 120 KB contract. A big Wasm is a permanent cost centre; a
  StreamPay deployment below ~80 live streams pays more for its bytecode than
  for its streams.
- **Dust accrual must beat 0.021 XLM/stream/month**: a stream whose total
  deposit is less than ~a month of rent is rent-negative — input for a
  dust-minimum decision.

`npm run rent -- --streams N [--addresses A] [--code-bytes B] [--state-size S]`
prints the table offline; `scan` reports it from *measured* on-chain sizes.
Refresh `sorobanStateSizeBytes` (and the CAP-0066 constants) from the live
network config before quoting production numbers — the fee curve is flat at
1,000 stroops/KB until ~2 GB of live Soroban state.

## What the scanner watches, and how it stays correct

- **Enumeration** — `NextStreamId` yields contiguous ids from 1, so ids
  `1..next_id-1` are fetched with batched `getLedgerEntries` (≤ 200 keys per
  request, RPC's hard limit). No dependency on event retention (a public RPC
  keeps ~7 days of events, far less than the cliffs above).
- **Counter unavailable** — falls back to the cached high-water mark *plus a
  bounded 200-id probe run* so streams created during downtime are still
  found; speculative ids that are absent are never reported as expired
  (they may simply not exist).
- **Index keys** — probed for every address ever seen (sender and recipient),
  remembered in the state cache so archived streams keep their addresses.
- **Instance/code** — the Wasm code key is cached once discovered, so the
  code entry stays monitored even after the instance archives (a live SAC
  instance with a built-in executable has no Wasm hash, which is handled).
- **Cadence** — sampled from `getLatestLedger` on each pass; ETAs are shown
  at the fastest credible cadence and the 5 s target, and all safety math is
  in ledgers (deterministic) with the 1 s floor used for worst cases.

## The optional extender (separately funded, off by default)

Auto-extension means *signing a transaction* with a funded account, so it
raises two questions the read-only core deliberately does not answer: **who
pays**, and **who holds the key**.

- It is opt-in twice: `extender.enabled = true` in config **and** `--execute`
  (default is dry-run, which prints the plan and submits nothing).
- The key comes from an env var named in config (`extender.secretKeyEnv`,
  default `TTL_SENTINEL_EXTENDER_SECRET`) — never a CLI flag (`ps` leaks
  argv), never read by `scan`, never logged.
- The protocol allows anyone to extend anyone's entry (`ExtendFootprintTTL`
  sets a floor and leaves longer-lived entries alone), so a low-balance hot
  key is sufficient: keep it funded with a small balance and a monthly budget.
- Safeguards: only entries below `extender.thresholdLedgers`, most urgent
  first, ≤ `maxEntriesPerTx` per transaction, monthly XLM cap enforced from
  the persisted spend meter, and the run stops on the first failed submission.
- Extending a never-extended entry lifts its cliff from 4,095 to ≥ 200,000
  ledgers — the fast-forward suite asserts the alert then resolves.

`docs/ARCHITECTURE.md` §12 covers where this sits in the system.

## Limitations (read this before relying on it)

- **Read-only core cannot prevent expiry by itself.** It is an alerting
  service; prevention means acting on an alert (a contract write, an
  off-chain extension, or enabling the extender).
- **A cold start with an archived counter is blind beyond the probe run.**
  Recovery is bounded by `counterFallbackProbeRun`; the durable fix is the
  contract extending its own counter entry (out of scope here, tracked as a
  contract-side finding).
- **Rent figures depend on live network parameters.** Constants mirror
  CAP-0066; verify against `stellar-cli`/Lab network limits and set
  `sorobanStateSizeBytes` before publishing prices.
- **Alert cadence is wall-clock based.** Ledger-time alerting is exact; a
  stalled network stretches wall time, which only adds margin.

## Layout

```text
src/constants.ts   contract + network constants (checked against stream.rs)
src/cliff.ts       worst-case cliff model and schedule-safety assertions
src/cadence.ts     ledger cadence sampling and wall-clock bounds
src/project.ts     per-entry projection: severity, remaining TTL, ETAs
src/scanner.ts     enumeration, TTL reads, measured sizes, state cache
src/alerts.ts      transition state machine + console/JSONL/webhook sinks
src/rent.ts        the fees.rs rent model and monthly projections
src/extender.ts    optional funded ExtendFootprintTTL submitter
src/cli.ts         scan / rent / extend
test/              unit tests + fake chain for fast-forward ledger scenarios
```
