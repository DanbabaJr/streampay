//! Oracle-based external reference clock with staleness bounds and safe fallback.
//!
//! # Threat Model & Trust Model
//! 1. **Opt-in per stream:** Default clock source remains Stellar ledger time (`env.ledger().timestamp()`).
//!    Only streams created with `use_oracle: true` settle against the oracle clock.
//! 2. **Governance Power Statement:** Publishers and threshold parameters are chosen by the contract
//!    governor (`set_oracle_config`). However, oracle reports and threshold changes *cannot brick*
//!    streams: if quorum is lost, publishers rotate, or threshold changes, the stream
//!    seamlessly falls back to native ledger time without freezing or locking funds.
//! 3. **M-of-N Quorum:** The governor configures an authorized set of `publishers: Vec<Address>`
//!    and a required threshold `threshold <= publishers.len()`. A single compromised publisher
//!    under an M-of-N scheme (e.g., 1 rogue publisher under 2-of-3) cannot manipulate the resolved time.
//! 4. **Staleness Bound (`max_stale_seconds`):** Each publisher report carries `reported_time` and
//!    `ledger_time` (the ledger timestamp when the report was submitted on-chain). A report is
//!    valid if and only if `current_ledger_time <= report.ledger_time + max_stale_seconds`.
//!    Reports older than `max_stale_seconds` are discarded.
//! 5. **Future Timestamp Protection:** Reports with `reported_time > current_ledger_time + max_stale_seconds`
//!    are rejected upon submission, preventing futuristic timestamps.
//! 6. **Safe Fallback to Ledger Time:** If fewer than `threshold` valid reports exist within
//!    `max_stale_seconds`, the oracle resolver safely falls back to the current ledger timestamp
//!    `env.ledger().timestamp()` and emits an [`OracleStaleFallback`] event. Streams never freeze.
//! 7. **Checks-Effects-Interactions (CEI):** Oracle time resolution is an effect step executed
//!    strictly *before* any state mutation or token transfers. The accrual math itself
//!    ([`crate::stream::streamed_at`]) remains a pure function of `now: u64`.

use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::errors::StreamError;
use crate::events::{OracleConfigUpdated, OracleStaleFallback, OracleTimeReported};
use crate::stream::{DataKey, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

/// Default maximum staleness: 3600 seconds (1 hour).
pub const DEFAULT_MAX_STALE_SECONDS: u64 = 3600;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Oracle configuration stored in instance storage."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    #[cfg_attr(not(target_family = "wasm"), doc = " Authorized oracle publishers.")]
    pub publishers: Vec<Address>,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Minimum number of fresh publisher reports required for quorum."
    )]
    pub threshold: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Maximum staleness in seconds before a report is considered stale."
    )]
    pub max_stale_seconds: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " An individual report from an authorized publisher."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleReport {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The external reference timestamp."
    )]
    pub reported_time: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp when the report was recorded on-chain."
    )]
    pub ledger_time: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Result of resolving reference time for a stream."
)]
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct ResolvedTime {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The resolved reference timestamp."
    )]
    pub timestamp: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Whether the timestamp came from oracle aggregation (`true`) or ledger fallback (`false`)."
    )]
    pub is_oracle: bool,
}

/// Sets or updates the oracle publisher registry, threshold, and staleness bound.
/// Must be authorized by the governor.
pub fn set_oracle_config(
    env: &Env,
    publishers: Vec<Address>,
    threshold: u32,
    max_stale_seconds: u64,
) -> Result<(), StreamError> {
    if threshold == 0 || threshold > publishers.len() {
        return Err(surface::reject(Branch::InvalidOracleThreshold));
    }
    let effective_max_stale = if max_stale_seconds == 0 {
        DEFAULT_MAX_STALE_SECONDS
    } else {
        max_stale_seconds
    };
    let config = OracleConfig {
        publishers,
        threshold,
        max_stale_seconds: effective_max_stale,
    };
    env.storage()
        .instance()
        .set(&DataKey::OracleConfig, &config);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    OracleConfigUpdated {
        threshold,
        max_stale_seconds: effective_max_stale,
    }
    .publish(env);

    Ok(())
}

/// Returns the current oracle configuration, if configured.
pub fn get_oracle_config(env: &Env) -> Option<OracleConfig> {
    env.storage().instance().get(&DataKey::OracleConfig)
}

/// Records a timestamp report from an authorized publisher.
pub fn submit_oracle_time(
    env: &Env,
    publisher: Address,
    timestamp: u64,
) -> Result<(), StreamError> {
    publisher.require_auth();

    let config: OracleConfig = env
        .storage()
        .instance()
        .get(&DataKey::OracleConfig)
        .ok_or_else(|| surface::reject(Branch::OraclePublishersNotConfigured))?;

    let mut is_authorized = false;
    for p in config.publishers.iter() {
        if p == publisher {
            is_authorized = true;
            break;
        }
    }
    if !is_authorized {
        return Err(surface::reject(Branch::NotOraclePublisher));
    }

    let now_ledger = env.ledger().timestamp();
    // Guard against crazy future timestamps beyond staleness bound
    if timestamp > now_ledger.saturating_add(config.max_stale_seconds) {
        return Err(surface::reject(Branch::OracleReportTooOld));
    }

    let report = OracleReport {
        reported_time: timestamp,
        ledger_time: now_ledger,
    };

    let key = DataKey::OracleReport(publisher.clone());
    env.storage().persistent().set(&key, &report);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    OracleTimeReported {
        publisher,
        reported_time: timestamp,
        ledger_time: now_ledger,
    }
    .publish(env);

    Ok(())
}

/// Reads the latest report from a publisher, if any.
pub fn get_oracle_report(env: &Env, publisher: Address) -> Option<OracleReport> {
    env.storage()
        .persistent()
        .get(&DataKey::OracleReport(publisher))
}

/// Resolves the reference timestamp for a stream.
///
/// If `use_oracle` is false, returns `env.ledger().timestamp()`.
/// If `use_oracle` is true, collects fresh reports from configured publishers.
/// If valid fresh reports >= `threshold`, calculates median timestamp.
/// If quorum cannot be formed (stale feed or insufficient reports), falls back to
/// `env.ledger().timestamp()` and emits `OracleStaleFallback`.
pub fn resolve_stream_time(env: &Env, stream_id: u64, use_oracle: bool) -> ResolvedTime {
    let ledger_time = env.ledger().timestamp();
    if !use_oracle {
        return ResolvedTime {
            timestamp: ledger_time,
            is_oracle: false,
        };
    }

    let Some(config) = get_oracle_config(env) else {
        OracleStaleFallback {
            stream_id,
            ledger_time,
        }
        .publish(env);
        return ResolvedTime {
            timestamp: ledger_time,
            is_oracle: false,
        };
    };

    let mut valid_times = Vec::new(env);
    for publisher in config.publishers.iter() {
        if let Some(report) = get_oracle_report(env, publisher) {
            // Freshness check: current ledger time must not exceed report.ledger_time + max_stale_seconds
            if ledger_time <= report.ledger_time.saturating_add(config.max_stale_seconds) {
                valid_times.push_back(report.reported_time);
            }
        }
    }

    if valid_times.len() < config.threshold {
        OracleStaleFallback {
            stream_id,
            ledger_time,
        }
        .publish(env);
        return ResolvedTime {
            timestamp: ledger_time,
            is_oracle: false,
        };
    }

    // Sort valid_times (insertion sort for small publisher count) to find the median.
    let n = valid_times.len();
    let mut i = 1;
    while i < n {
        let mut j = i;
        while j > 0 {
            let a = valid_times.get(j - 1).unwrap();
            let b = valid_times.get(j).unwrap();
            if a > b {
                valid_times.set(j - 1, b);
                valid_times.set(j, a);
                j -= 1;
            } else {
                break;
            }
        }
        i += 1;
    }

    // Median of sorted timestamps
    let median_time = valid_times.get(n / 2).unwrap();

    ResolvedTime {
        timestamp: median_time,
        is_oracle: true,
    }
}
