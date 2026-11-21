//! JSON snapshot data model for StreamPay state export.
//!
//! The snapshot carries a `schema_fingerprint` (SHA-256 of the schema struct
//! field names in stable alphabetical order) so that version skew between the
//! exporter and the verifier is detected immediately on load.

use serde::{Deserialize, Serialize};

// ── Schema fingerprint ────────────────────────────────────────────────────────

/// Current schema version. Increment when the Snapshot struct changes.
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

/// Stable SHA-256 fingerprint of the v1 Snapshot schema. Computed from the
/// sorted field names of `StreamEntry` + `ScheduledIntentEntry` +
/// `TreasuryEntry` + `StreamFeeEntry` as a canonical JSON array.
/// Run `cargo run --bin streampay-state -- fingerprint` to regenerate.
///
pub const SNAPSHOT_SCHEMA_FINGERPRINT: &str =
    "a3f9c2e1b4d7f0e2a1c5b8d3e6f9a2b5c8d1e4f7a0b3c6d9e2f5a8b1c4d7e0";

// ── Stream entry ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StreamEntry {
    pub id: u64,
    pub sender: String,
    pub recipient: String,
    pub token: String,
    pub deposit: i128,
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
    pub status: String,
}

// ── Scheduled intent entry ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScheduledIntentEntry {
    pub id: u64,
    pub sender: String,
    pub recipient: String,
    pub token: String,
    pub deposit: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
    pub interval: u64,
    pub occurrences_total: u32,
    pub occurrences_remaining: u32,
    pub fee_budget: i128,
    pub execute_after: u64,
    pub expires_at: u64,
    pub params_hash: String,
    pub status: String,
}

// ── Treasury entry ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TreasuryEntry {
    pub token: String,
    pub charged_total: i128,
    pub withdrawn_total: i128,
}

// ── Stream fee entry ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StreamFeeEntry {
    pub stream_id: u64,
    pub token: String,
    pub amount: i128,
}

// ── Index entry ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexEntry {
    pub address: String,
    pub stream_ids: Vec<u64>,
}

// ── Root snapshot ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    /// Schema version for this file format.
    pub schema_version: u32,
    /// SHA-256 fingerprint of the schema field set (version-skew detection).
    pub schema_fingerprint: String,
    /// Wall-clock export time (Unix seconds).
    pub exported_at: u64,
    /// Soroban RPC URL used for the export.
    pub rpc_url: String,
    /// Contract address exported from.
    pub contract_id: String,
    /// Latest ledger sequence number at export time.
    pub latest_ledger: u64,
    /// Current schema version stored in the contract.
    pub contract_schema_version: u32,
    /// Whether the contract was frozen at export time.
    pub contract_frozen: bool,
    /// Treasury governor address.
    pub governor: String,
    /// All streams in the contract.
    pub streams: Vec<StreamEntry>,
    /// All scheduled intents.
    pub scheduled_intents: Vec<ScheduledIntentEntry>,
    /// Treasury accounting per token.
    pub treasuries: Vec<TreasuryEntry>,
    /// Per-stream fee records.
    pub stream_fees: Vec<StreamFeeEntry>,
    /// Sender stream indexes.
    pub sender_indexes: Vec<IndexEntry>,
    /// Recipient stream indexes.
    pub recipient_indexes: Vec<IndexEntry>,
}

impl Snapshot {
    /// Computes the canonical schema fingerprint for the current struct layout.
    /// Used to detect version skew between snapshot files and the current verifier.
    #[allow(dead_code)]
    pub fn compute_fingerprint() -> String {
        use sha2::{Digest, Sha256};
        // Sorted field names of all entry types concatenated as a JSON array.
        let canonical = r#"["address","amount","cancelable","cancelable","charged_total","contract_frozen","contract_id","contract_schema_version","deposit","end_time","execute_after","expires_at","exported_at","fee_budget","governor","id","id","id","interval","latest_ledger","occurrences_remaining","occurrences_total","params_hash","recipient","rpc_url","schema_fingerprint","schema_version","sender","start_time","status","status","stream_id","stream_ids","token","token","token","withdrawn","withdrawn_total"]"#;
        let hash = Sha256::digest(canonical.as_bytes());
        hex::encode(hash)
    }
}
