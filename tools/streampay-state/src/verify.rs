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

use std::collections::{HashMap, HashSet};

use crate::model::{Snapshot, SNAPSHOT_SCHEMA_FINGERPRINT};

/// Runs all consistency checks. Returns `Ok(())` if all pass, or an
/// aggregated error listing every violation.
pub fn run(snapshot_path: &str) -> anyhow::Result<()> {
    let raw = std::fs::read_to_string(snapshot_path)
        .map_err(|e| anyhow::anyhow!("cannot read snapshot: {e}"))?;
    let snap: Snapshot =
        serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("cannot parse snapshot: {e}"))?;

    let mut violations: Vec<String> = Vec::new();

    // ── 1. Schema fingerprint ─────────────────────────────────────────────────
    let expected_fp = SNAPSHOT_SCHEMA_FINGERPRINT;
    if snap.schema_fingerprint != expected_fp {
        violations.push(format!(
            "Schema fingerprint mismatch: snapshot has '{}', expected '{}'",
            snap.schema_fingerprint, expected_fp
        ));
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
            violations.push(format!("Stream {}: withdrawn {} < 0", s.id, s.withdrawn));
        }
        if s.deposit <= 0 {
            violations.push(format!("Stream {}: deposit {} <= 0", s.id, s.deposit));
        }
        if s.withdrawn > s.deposit {
            violations.push(format!(
                "Stream {}: withdrawn {} > deposit {} (invariant violated)",
                s.id, s.withdrawn, s.deposit
            ));
        }
        // Status-specific arithmetic.
        match s.status.as_str() {
            "Depleted" => {
                if s.withdrawn != s.deposit {
                    violations.push(format!(
                        "Stream {}: Depleted but withdrawn {} != deposit {}",
                        s.id, s.withdrawn, s.deposit
                    ));
                }
            }
            "Active" => {
                // Accumulate unclaimed balance for balance-coverage check.
                let unclaimed = s.deposit - s.withdrawn;
                *token_unclaimed.entry(s.token.clone()).or_default() += unclaimed;
            }
            "Cancelled" => {
                if s.withdrawn > s.deposit {
                    violations.push(format!(
                        "Stream {}: Cancelled but withdrawn {} > deposit {}",
                        s.id, s.withdrawn, s.deposit
                    ));
                }
            }
            other => {
                violations.push(format!("Stream {}: unknown status '{}'", s.id, other));
            }
        }
    }

    if !duplicate_ids.is_empty() {
        violations.push(format!("Duplicate stream ids: {duplicate_ids:?}"));
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
            violations.push(format!(
                "Treasury invariant violated for token {}: \
                 charged_total={} but Σstream_fees={}",
                t.token, t.charged_total, scanned
            ));
        }
        if t.withdrawn_total > t.charged_total {
            violations.push(format!(
                "Treasury token {}: withdrawn_total {} > charged_total {}",
                t.token, t.withdrawn_total, t.charged_total
            ));
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
                violations.push(format!(
                    "Index entry for address {} references stream id {} which does not exist",
                    entry.address, id
                ));
            }
        }
    }

    // ── 6. Orphan fee records ─────────────────────────────────────────────────
    for f in &snap.stream_fees {
        if !stream_ids.contains(&f.stream_id) {
            violations.push(format!(
                "StreamFee for stream id {} has no matching stream (orphan)",
                f.stream_id
            ));
        }
    }

    // ── 7. Scheduled intent arithmetic ────────────────────────────────────────
    for intent in &snap.scheduled_intents {
        if intent.occurrences_remaining > intent.occurrences_total {
            violations.push(format!(
                "Intent {}: occurrences_remaining {} > occurrences_total {}",
                intent.id, intent.occurrences_remaining, intent.occurrences_total
            ));
        }
    }

    // ── Report ────────────────────────────────────────────────────────────────
    if violations.is_empty() {
        println!("✓ Snapshot verified: no violations found.");
        println!(
            "  {} streams, {} intents, {} treasuries, {} fee records",
            snap.streams.len(),
            snap.scheduled_intents.len(),
            snap.treasuries.len(),
            snap.stream_fees.len()
        );
        // Print per-token unclaimed balance summary.
        for (token, unclaimed) in &token_unclaimed {
            let short = &token[..token.len().min(16)];
            println!("  Token {short}…: {unclaimed} stroops across active streams");
        }
        Ok(())
    } else {
        let msg = format!(
            "Snapshot verification FAILED ({} violation{}):\n{}",
            violations.len(),
            if violations.len() == 1 { "" } else { "s" },
            violations
                .iter()
                .map(|v| format!("  • {v}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        Err(anyhow::anyhow!("{msg}"))
    }
}
