# Multi-region active-active indexer (#583)

Every region runs a complete indexer: it polls Soroban RPC, projects into its own
SQLite store and serves reads. There is no primary and no write forwarding — a
region that loses connectivity to the others keeps ingesting.

```
us-east ─┐
eu-west ─┼─ ingestion + projection + read API (identical everywhere)
ap-south ┘
          └─ shared: delivery lease (one leader per subscription), watermark gossip
```

## Convergence

Each region projects the same event set, so the projections are compared rather
than replicated. `indexer/src/multiregion/convergence.ts` folds a stream's whole
journal in `(ledger, id)` order to produce the deterministic reference row, then
compares regions by a stream fingerprint / Merkle root.

A region can temporarily diverge: the projection's monotonic guard drops an event
that arrives after a later ledger for the same stream (a retried window, a
parallel fetch). The event is still journalled, so `reconcileRegion` repairs the
row from the fold and re-running it is a no-op. `compareRegions` reports exactly
which streams disagree, so divergence is repairable, not just detectable.

## Freshness and read routing

Regions report `(watermark, health)`. `streampay_region_ledger_watermark` and
`streampay_region_consistency_lag_ledgers` are derived from those reports, and
`FreshnessReadRouter` sends a read to the freshest healthy region — lowest lag,
then configured priority, then region id, so the choice is deterministic.

- `READ_FRESHNESS_MAX_LAG_LEDGERS` (default 5) is the lag beyond which a region
  stops taking reads.
- `routeFor(ledger)` never returns a region that has not projected `ledger`
  (read-your-writes).
- When no region qualifies the router throws `NoFreshRegionError`; it never
  falls back to stale data silently.

At the data plane, each region Service only holds Ready endpoints, so a failed
region is removed from `HTTPRoute` by readiness rather than by a second health
mechanism.

## Exactly-once webhook delivery

All regions hold the outbox, so delivery leadership is fenced in the shared lease
table (`delivery_leases`): one subscription has one leader epoch, leases expire,
and every takeover increments the epoch. A leader that stalls past its lease is
rejected by `assertLeader` the moment a new epoch is visible, so failover can
duplicate at most an in-flight HTTP request — never a claimed intent, because
`markDelivered` is also guarded by the intent's claim token.

## Deploying

```bash
kubectl apply -k infra/multiregion
```

The Prometheus rules alert on a region whose lag stays high, on zero healthy
regions, and on drifting watermarks with low lag (a region that stopped
ingesting without failing its probe).

## Chaos coverage

`indexer/src/multiregion/regions.test.ts` covers the failure modes that matter:

- same events delivered in different orders → divergence detected, fold repairs
  it, both regions land on the same root;
- a region dying mid-ingest → nothing committed is lost, `routeFor` skips it;
- a delivery leader stalling past its lease → the next region takes over and the
  stale leader is fenced out, with each event delivered exactly once.
