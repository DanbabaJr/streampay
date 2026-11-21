//! `verify` sub-command: checks a snapshot for internal consistency.
//!
//! # Invariants checked
//!
//! 1. **Schema fingerprint** — the file's `schema_fingerprint` matches the
//!    current model's fingerprint.
//! 2. **Balance coverage** — for each token, `Σ(deposit - withdrawn)` across
//!    active streams ≤ implied contract balance. (We cannot query the actual
//!    on-chain balance from the snapshot alone, but we verify internal arithmetic
//!    consistency: `withdrawn ≤ deposit` for every stream.)
//! 3. **Status arithmetic** — depleted streams have `withdrawn == deposit`;
//!    cancelled streams have `withdrawn ≤ deposit`.
//! 4. **Treasury invariant** — for each token,
//!    `treasury.charged_total == Σ stream_fees` for that token.
//! 5. **Index completeness** — every stream id in `sender_indexes` and
//!    `recipient_indexes` also appears in `streams`.
//! 6. **Orphan detection** — every `stream_fees` entry references a stream id
//!    that exists in `streams`.
//! 7. **No duplicate stream ids** — stream ids are unique.
//!
//! # Output
//!
//! `--format text` (default) prints the human summary. `--format json` prints
//! a [`Report`] — the versioned, machine-readable contract documented in
//! `README.md` and published as `json-schema-v1.json` — to stdout. The exit
//! code is the same in both formats: 0 when no violation was found, 1 otherwise.

use std::collections::{BTreeMap, HashMap, HashSet};

use clap::ValueEnum;
use serde::Serialize;

use crate::model::{Snapshot, SNAPSHOT_SCHEMA_FINGERPRINT};

/// Version of the JSON report contract (`json-schema-v1.json`). Within v1 the
/// report only ever gains fields; see README.md for the compatibility policy.
pub const REPORT_VERSION: u32 = 1;

/// Stable identifiers for the invariants checked. These strings are part of
/// the v1 contract (the `check` enum in the schema): never rename or reuse one;
/// new checks are appended.
pub mod check {
    pub const SCHEMA_FINGERPRINT: &str = "schema_fingerprint";
    pub const STREAM_ARITHMETIC: &str = "stream_arithmetic";
    pub const DUPLICATE_STREAM_IDS: &str = "duplicate_stream_ids";
    pub const TREASURY_INVARIANT: &str = "treasury_invariant";
    pub const INDEX_COMPLETENESS: &str = "index_completeness";
    pub const ORPHAN_FEE: &str = "orphan_fee";
    pub const INTENT_ARITHMETIC: &str = "intent_arithmetic";
}

/// Output format of `verify`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Format {
    /// Human-readable summary (default).
    Text,
    /// Versioned JSON report on stdout.
    Json,
}

/// One failed invariant.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Violation {
    /// Which invariant failed — one of the identifiers in [`check`].
    pub check: &'static str,
    /// Human-readable description. Wording may change; match on `check`.
    pub message: String,
}

/// Facts about the snapshot that was verified.
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotInfo {
    pub schema_version: u32,
    pub schema_fingerprint: String,
    pub expected_schema_fingerprint: &'static str,
    pub contract_id: String,
    pub latest_ledger: u64,
    pub exported_at: u64,
}

/// Row counts of the verified snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct Counts {
    pub streams: usize,
    pub scheduled_intents: usize,
    pub treasuries: usize,
    pub stream_fees: usize,
}

/// Unclaimed balance across the active streams of one token.
#[derive(Debug, Clone, Serialize)]
pub struct TokenBalance {
    pub token: String,
    /// Decimal string: amounts are i128 and can exceed JSON/JS safe integers.
    pub unclaimed: String,
}

/// The machine-readable verify report (contract: `json-schema-v1.json`).
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub report_version: u32,
    pub tool_version: &'static str,
    /// `true` exactly when `violations` is empty.
    pub ok: bool,
    pub snapshot: SnapshotInfo,
    pub counts: Counts,
    pub violations: Vec<Violation>,
    /// Sorted by token for stable output.
    pub unclaimed_by_token: Vec<TokenBalance>,
}

/// Reads `snapshot_path`, verifies it and prints the report in `format`.
/// Returns `Ok(())` when all checks pass, or an error summarising the
/// violations (in text mode the error lists every one).
pub fn run(snapshot_path: &str, format: Format) -> anyhow::Result<()> {
    let raw = std::fs::read_to_string(snapshot_path)
        .map_err(|e| anyhow::anyhow!("cannot read snapshot: {e}"))?;
    let snap: Snapshot =
        serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("cannot parse snapshot: {e}"))?;
    let report = build_report(&snap);

    match format {
        Format::Json => {
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report.ok {
                Ok(())
            } else {
                Err(anyhow::anyhow!(
                    "snapshot verification failed ({} violation{})",
                    report.violations.len(),
                    if report.violations.len() == 1 {
                        ""
                    } else {
                        "s"
                    }
                ))
            }
        }
        Format::Text => print_text(&report),
    }
}

/// Runs every invariant check over `snap` (no I/O).
pub fn build_report(snap: &Snapshot) -> Report {
    let mut violations: Vec<Violation> = Vec::new();

    // ── 1. Schema fingerprint ─────────────────────────────────────────────────
    let expected_fp = SNAPSHOT_SCHEMA_FINGERPRINT;
    if snap.schema_fingerprint != expected_fp {
        violations.push(Violation {
            check: check::SCHEMA_FINGERPRINT,
            message: format!(
                "Schema fingerprint mismatch: snapshot has '{}', expected '{}'",
                snap.schema_fingerprint, expected_fp
            ),
        });
    }

    // ── 2 & 3. Per-stream arithmetic ──────────────────────────────────────────
    let mut stream_ids: HashSet<u64> = HashSet::new();
    let mut token_unclaimed: HashMap<String, i128> = HashMap::new();
    let mut duplicate_ids: Vec<u64> = Vec::new();

    for s in &snap.streams {
        if !stream_ids.insert(s.id) {
            duplicate_ids.push(s.id);
        }
        if s.withdrawn < 0 {
            violations.push(Violation {
                check: check::STREAM_ARITHMETIC,
                message: format!("Stream {}: withdrawn {} < 0", s.id, s.withdrawn),
            });
        }
        if s.deposit <= 0 {
            violations.push(Violation {
                check: check::STREAM_ARITHMETIC,
                message: format!("Stream {}: deposit {} <= 0", s.id, s.deposit),
            });
        }
        if s.withdrawn > s.deposit {
            violations.push(Violation {
                check: check::STREAM_ARITHMETIC,
                message: format!(
                    "Stream {}: withdrawn {} > deposit {} (invariant violated)",
                    s.id, s.withdrawn, s.deposit
                ),
            });
        }
        // Status-specific arithmetic.
        match s.status.as_str() {
            "Depleted" => {
                if s.withdrawn != s.deposit {
                    violations.push(Violation {
                        check: check::STREAM_ARITHMETIC,
                        message: format!(
                            "Stream {}: Depleted but withdrawn {} != deposit {}",
                            s.id, s.withdrawn, s.deposit
                        ),
                    });
                }
            }
            "Active" => {
                // Accumulate unclaimed balance for balance-coverage check.
                let unclaimed = s.deposit - s.withdrawn;
                *token_unclaimed.entry(s.token.clone()).or_default() += unclaimed;
            }
            "Cancelled" => {
                if s.withdrawn > s.deposit {
                    violations.push(Violation {
                        check: check::STREAM_ARITHMETIC,
                        message: format!(
                            "Stream {}: Cancelled but withdrawn {} > deposit {}",
                            s.id, s.withdrawn, s.deposit
                        ),
                    });
                }
            }
            other => {
                violations.push(Violation {
                    check: check::STREAM_ARITHMETIC,
                    message: format!("Stream {}: unknown status '{}'", s.id, other),
                });
            }
        }
    }

    if !duplicate_ids.is_empty() {
        violations.push(Violation {
            check: check::DUPLICATE_STREAM_IDS,
            message: format!("Duplicate stream ids: {duplicate_ids:?}"),
        });
    }

    // ── 4. Treasury invariant ─────────────────────────────────────────────────
    // Sum stream fees per token and compare with treasury.charged_total.
    let mut fee_sum: HashMap<String, i128> = HashMap::new();
    for f in &snap.stream_fees {
        *fee_sum.entry(f.token.clone()).or_default() += f.amount;
    }
    for t in &snap.treasuries {
        let scanned = *fee_sum.get(&t.token).unwrap_or(&0);
        if scanned != t.charged_total {
            violations.push(Violation {
                check: check::TREASURY_INVARIANT,
                message: format!(
                    "Treasury invariant violated for token {}: \
                 charged_total={} but Σstream_fees={}",
                    t.token, t.charged_total, scanned
                ),
            });
        }
        if t.withdrawn_total > t.charged_total {
            violations.push(Violation {
                check: check::TREASURY_INVARIANT,
                message: format!(
                    "Treasury token {}: withdrawn_total {} > charged_total {}",
                    t.token, t.withdrawn_total, t.charged_total
                ),
            });
        }
    }

    // ── 5. Index completeness ─────────────────────────────────────────────────
    for entry in snap
        .sender_indexes
        .iter()
        .chain(snap.recipient_indexes.iter())
    {
        for &id in &entry.stream_ids {
            if !stream_ids.contains(&id) {
                violations.push(Violation {
                    check: check::INDEX_COMPLETENESS,
                    message: format!(
                        "Index entry for address {} references stream id {} which does not exist",
                        entry.address, id
                    ),
                });
            }
        }
    }

    // ── 6. Orphan fee records ─────────────────────────────────────────────────
    for f in &snap.stream_fees {
        if !stream_ids.contains(&f.stream_id) {
            violations.push(Violation {
                check: check::ORPHAN_FEE,
                message: format!(
                    "StreamFee for stream id {} has no matching stream (orphan)",
                    f.stream_id
                ),
            });
        }
    }

    // ── 7. Scheduled intent arithmetic ────────────────────────────────────────
    for intent in &snap.scheduled_intents {
        if intent.occurrences_remaining > intent.occurrences_total {
            violations.push(Violation {
                check: check::INTENT_ARITHMETIC,
                message: format!(
                    "Intent {}: occurrences_remaining {} > occurrences_total {}",
                    intent.id, intent.occurrences_remaining, intent.occurrences_total
                ),
            });
        }
    }

    let mut unclaimed_by_token: Vec<TokenBalance> = token_unclaimed
        .into_iter()
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .map(|(token, unclaimed)| TokenBalance {
            token,
            unclaimed: unclaimed.to_string(),
        })
        .collect();
    unclaimed_by_token.sort_by(|a, b| a.token.cmp(&b.token));

    Report {
        report_version: REPORT_VERSION,
        tool_version: env!("CARGO_PKG_VERSION"),
        ok: violations.is_empty(),
        snapshot: SnapshotInfo {
            schema_version: snap.schema_version,
            schema_fingerprint: snap.schema_fingerprint.clone(),
            expected_schema_fingerprint: SNAPSHOT_SCHEMA_FINGERPRINT,
            contract_id: snap.contract_id.clone(),
            latest_ledger: snap.latest_ledger,
            exported_at: snap.exported_at,
        },
        counts: Counts {
            streams: snap.streams.len(),
            scheduled_intents: snap.scheduled_intents.len(),
            treasuries: snap.treasuries.len(),
            stream_fees: snap.stream_fees.len(),
        },
        violations,
        unclaimed_by_token,
    }
}

/// The human-readable rendering of a report (the pre-JSON output).
fn print_text(report: &Report) -> anyhow::Result<()> {
    if report.ok {
        println!("✓ Snapshot verified: no violations found.");
        println!(
            "  {} streams, {} intents, {} treasuries, {} fee records",
            report.counts.streams,
            report.counts.scheduled_intents,
            report.counts.treasuries,
            report.counts.stream_fees
        );
        for b in &report.unclaimed_by_token {
            let short = &b.token[..b.token.len().min(16)];
            println!(
                "  Token {short}…: {} stroops across active streams",
                b.unclaimed
            );
        }
        Ok(())
    } else {
        let msg = format!(
            "Snapshot verification FAILED ({} violation{}):\n{}",
            report.violations.len(),
            if report.violations.len() == 1 {
                ""
            } else {
                "s"
            },
            report
                .violations
                .iter()
                .map(|v| format!("  • {}", v.message))
                .collect::<Vec<_>>()
                .join("\n")
        );
        Err(anyhow::anyhow!("{msg}"))
    }
}
