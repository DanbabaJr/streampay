# Real-user monitoring and Core Web Vitals budgets

Consent-gated field monitoring plus a lab CI gate. Code: `frontend/lib/rum/`,
`frontend/app/api/rum/route.ts`, `frontend/app/rum/page.tsx`,
`frontend/scripts/rum-budget-gate.mjs`. Budgets: `frontend/rum/budgets.json`.

## Metric definitions

- **LCP** (Largest Contentful Paint, ms): time until the largest content element renders. Good is 2500 ms or less at p75.
- **INP** (Interaction to Next Paint, ms): worst-case latency of user interactions. Good is 200 ms or less at p75.
- **CLS** (Cumulative Layout Shift, unitless): unexpected layout movement. Good is 0.1 or less at p75.
- **TBT** (Total Blocking Time, ms): lab-only proxy for INP, since lab runs have no real interactions.

Field budgets are judged at the 75th percentile per route, as Google does.

## Budget rationale

Field budgets use the public "good" thresholds, with a small allowance for
`/stream/[id]` LCP because it waits on a chain read. Lab budgets are looser
than the baseline (simulated throttling is pessimistic) and the gate also
fails on a regression of more than `tolerancePct` (10%) against
`rum/lab-baseline.json`, so a slow drift fails even while under the absolute
ceiling. Refresh the baseline deliberately with `--update-baseline` after an
accepted change.

## Privacy model

- **Default off.** Nothing loads or sends until the user clicks Allow. Only the stored value `granted` counts; anything else is off. Opt-out applies on the very next metric.
- **Allowlist redaction at both ends.** The client and `/api/rum` rebuild the payload from `route, metric, value, rating, nav`. Unknown fields are dropped.
- **Routes are templated** (`/stream/[id]`, `/`, `other`). Stream ids, addresses and query strings never leave the page.
- No cookies (`credentials: omit`), no user agent, IP or session id is stored. The IP-derived rate-limit key lives in memory for one window only.
- The privacy regression suite (`tests/rum-privacy.test.ts`) asserts this.

## Cost controls

- Sampling: `NEXT_PUBLIC_RUM_SAMPLE_RATE` (0 to 1, default 0.1), decided once per page load.
- Max 20 beacons per page; ingest rate limit 60 per minute per key; body limit 1 KB; in-memory storage capped at 1000 samples per route and metric.
- **Kill switch:** set `RUM_KILL_SWITCH=1` on the server. `/api/rum` answers 410, and clients stop for that page load.

## Lab CI gate

1. Run Lighthouse on `/` and a stream page, e.g. `npx lighthouse http://localhost:3000/ --output=json --output-path=lh-home.json`.
2. `node scripts/lighthouse-to-lab.mjs "/=lh-home.json" "/stream/[id]=lh-stream.json" > lab-results.json`
3. `npm run rum:gate -- --measured lab-results.json` exits 1 on any regression.

The gate logic is covered by self-tests in `tests/rum-gate.test.ts`, including
a CLI test that a regression exits non-zero. Running Lighthouse itself in CI
is left as a follow-up because it needs a browser runner.

## Dashboard

`/rum` shows per-route p50/p75/p95 against budget. The in-memory sink resets
on restart and is per instance; replace `lib/rum/sink.ts` with a durable store
for production.
