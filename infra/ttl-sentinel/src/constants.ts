//! Constants mirrored from the StreamPay contract and the Stellar network.
//!
//! The contract-side TTL numbers MUST stay in sync with
//! `contracts/streaming-payments/src/stream.rs`; `test/constants-sync.test.ts`
//! fails if they drift.

// ---------------------------------------------------------------------------
// Contract (mirrors stream.rs)
// ---------------------------------------------------------------------------

/// `TTL_THRESHOLD_LEDGERS` in `contracts/streaming-payments/src/stream.rs`:
/// the contract calls `extend_ttl(key, THRESHOLD, EXTEND_TO)` on every stream
/// write; the host only extends when the entry's remaining TTL drops below
/// this threshold.
export const CONTRACT_TTL_THRESHOLD_LEDGERS = 200_000;

/// `TTL_EXTEND_LEDGERS` in `stream.rs`: an extending write sets
/// `liveUntilLedger = current + 500_000` (~28.9 days at 5 s/ledger).
export const CONTRACT_TTL_EXTEND_LEDGERS = 500_000;

// ---------------------------------------------------------------------------
// Network parameters (Stellar mainnet; the test snapshots in
// contracts/streaming-payments/test_snapshots agree on min/max)
// ---------------------------------------------------------------------------

/// `min_persistent_entry_ttl`: TTL granted to a brand-new persistent entry
/// (counted inclusive of the creating ledger, so the observed remaining TTL
/// is `min - 1` and `liveUntilLedger = create + min - 1`).
export const MIN_PERSISTENT_ENTRY_TTL = 4096;

/// `max_entry_ttl`: no extension may exceed this target.
export const MAX_ENTRY_TTL = 6_312_000;

// ---------------------------------------------------------------------------
// Ledger cadence
// ---------------------------------------------------------------------------

/// Protocol target ledger close time (seconds).
export const TARGET_LEDGER_SECONDS = 5;

/// Fastest *credible* close time under the current whole-second protocol:
/// consecutive close times may differ by as little as 1 second. All
/// worst-case schedule math uses this floor, never the 5 s target.
export const FASTEST_CREDIBLE_LEDGER_SECONDS = 1;

/// Ledgers per day at the 5 s target (used only for human-facing estimates).
export const LEDGERS_PER_DAY_AT_TARGET = 86_400 / TARGET_LEDGER_SECONDS; // 17_280

/// Ledgers in a 30-day month at the 5 s target: 30 * 86400 / 5 = 518_400.
export const LEDGERS_PER_30_DAY_MONTH = (30 * 86_400) / TARGET_LEDGER_SECONDS;

// ---------------------------------------------------------------------------
// Rent model (rs-soroban-env `fees.rs`, parameter values from CAP-0066,
// protocol 23). Verify against the live network config before quoting
// production numbers — see README "Cost projection".
// ---------------------------------------------------------------------------

export const STROOPS_PER_XLM = 10_000_000n;

/// `persistent_rent_rate_denominator`: 1 KB of persistent state is charged
/// `fee_per_rent_1kb` stroops once per this many ledgers.
export const PERSISTENT_RENT_RATE_DENOMINATOR = 1215n;

/// `MINIMUM_RENT_WRITE_FEE_PER_1KB` — floor of the dynamic per-1KB rent fee.
export const MIN_RENT_WRITE_FEE_PER_1KB = 1000n;

/// CAP-0066 `rentFee1KBSorobanStateSizeLow` — per-1KB fee at empty state
/// (the floor above dominates: `low` is negative so the curve starts at 0
/// state and only reaches `high` at the target state size).
export const RENT_FEE_1KB_LOW = -17_000n;

/// CAP-0066 `rentFee1KBSorobanStateSizeHigh` — per-1KB fee once live state
/// reaches the target size. This is the upper bound used in cost tables.
export const RENT_FEE_1KB_HIGH = 10_000n;

/// CAP-0066 `sorobanLiveStateTargetSizeBytes` — 3 GB of live Soroban state.
export const RENT_STATE_TARGET_BYTES = 3_000_000_000n;

/// CAP-0066 `sorobanStateRentFeeGrowthFactor` — slope multiplier past target.
export const RENT_STATE_GROWTH_FACTOR = 5_000n;

/// CAP-0066 `feeWrite1KB` — used for the 48-byte TTL-entry write that every
/// TTL extension pays on top of rent.
export const FEE_WRITE_PER_1KB = 3500n;

/// `TTL_ENTRY_SIZE_BYTES` in `fees.rs` — every extension rewrites a
/// fixed-size 48-byte TTL entry.
export const TTL_ENTRY_SIZE_BYTES = 48;

/// `CODE_ENTRY_RENT_DISCOUNT_FACTOR` in `fees.rs` — Wasm code entries pay
/// 1/3 of the computed rent.
export const CODE_ENTRY_RENT_DISCOUNT_FACTOR = 3n;

// ---------------------------------------------------------------------------
// RPC limits
// ---------------------------------------------------------------------------

/// `getLedgerEntries` accepts at most 200 keys per request.
export const RPC_MAX_LEDGER_KEYS = 200;
