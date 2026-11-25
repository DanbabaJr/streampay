# Frontend Data Architecture

## Client/server map

| Surface | Server-owned work | Client-owned work |
| --- | --- | --- |
| `/` dashboard | Static route shell and server actions for Soroban reads | Freighter connection, localStorage cache, forms, stream controls, and transaction signing |
| `/stream/[id]` | Initial `get_stream` read and rendered stream data; the route streams a `Loading…` fallback while the RPC read is pending | Wallet detection, live accrual display, refresh polling, and signed withdraw/cancel actions |
| `app/actions.ts` | Read-only `get_stream`, `available`, and paged address-index reads | Calls are initiated by client islands; no signing operation is exposed here |
| `lib/stellar-read.ts` | `server-only` Soroban RPC client and response decoding | Not importable by client components |
| `lib/stellar.ts` | None | Freighter signing and mutating Soroban transactions; dynamically imported only when a write is requested |

The dashboard cannot server-render address-specific streams before Freighter grants access. Its initial navigation therefore renders the disconnected state without an RPC request. Once connected, reads cross a server-action boundary; signing remains in the browser. Discovery loads recipient and sender index pages concurrently, then resolves stream IDs in batches of five and merges each completed batch into the visible list before requesting later index pages.

The dashboard's create and stream-list panels are separate lazy client islands, each with its own `Loading…` Suspense fallback. The stream detail route has a route-data Suspense boundary. Its live available-balance read begins in the client after the initial server-rendered stream arrives.

## Waterfall audit

Counts below are Soroban `simulateTransaction` requests, not HTTP requests. They are derived from the call sites and should be checked against the browser Network panel/RPC trace for a benchmark deployment.

| Flow | Before | After | Notes |
| --- | ---: | ---: | --- |
| Cold dashboard navigation | 0 | 0 | Wallet address is not available until user consent; no initial chain read is possible. The initial bundle now defers form/list islands and the transaction SDK. |
| Dashboard cached IDs after connect | N `get_stream` calls | N `get_stream` server actions | N is the number of cached IDs. Calls remain parallel; data is revalidated on chain. |
| Discover address streams | `P_r + P_s + N_r + N_s` | `P_r + P_s + N_unique` | `P_*` is the number of 50-ID index pages; `N_*` is the number of indexed IDs whose stream read is attempted. The two roles are queried concurrently. The new flow deduplicates IDs across roles before reads and displays each completed five-stream batch. |
| Cold `/stream/[id]` detail | 2: `get_stream` + `available`, both after hydration | 2: server `get_stream` + client `available` | Same chain call count; stream fields are in the initial streamed HTML instead of waiting for client hydration. |
| Detail refresh, every 15 seconds | 2 | 2 | `get_stream` and `available` remain concurrent. |

### TTI measurement

No before/after Lighthouse or browser trace was available in the implementation environment: Node/npm and frontend dependencies are not installed here. Do not treat the bundle split or SSR change as a measured TTI win.

For the PR benchmark, build and serve production output on both the parent revision and this change, with identical RPC/network settings. Run five Chrome Performance traces per revision on slow-4G and 4x CPU throttling, report the median Time to Interactive (including the Freighter-connected dashboard state separately from the disconnected state), and attach Lighthouse reports plus the Soroban RPC Network-panel export. TTI is a trace-derived comparison; current Lighthouse versions may omit the deprecated TTI metric.

Suggested PR footer: `Closes #94`.