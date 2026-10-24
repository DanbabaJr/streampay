//! State types and constants for the StreamPay reference model.

/// Maximum supported stream duration: 100 years (36,525 days = 3,155,760,000 seconds).
pub const MAX_DURATION_SECONDS: u64 = 3_155_760_000;

/// Maximum number of items returned in a paginated index scan.
pub const MAX_PAGE_SIZE: u32 = 50;

/// Protocol cap on configurable fee rate (100 bps = 1.00%).
pub const MAX_FEE_BPS: u32 = 100;

/// Basis-point denominator: 10,000 bps = 100%.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Lifecycle state of a payment stream.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub enum ModelStreamStatus {
    /// Running; funds accrue linearly and may be withdrawn or topped up.
    Active,
    /// Cancelled; remaining funds were split between sender and recipient. Terminal.
    Cancelled,
    /// Fully accrued and fully withdrawn. Terminal.
    Depleted,
}

/// Full state of a payment stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelStream {
    pub id: u64,
    pub sender: String,
    pub recipient: String,
    pub token: String,
    pub deposit: i128,
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
    pub status: ModelStreamStatus,
}

impl ModelStream {
    /// Full stream duration in seconds.
    pub fn duration(&self) -> u64 {
        self.end_time - self.start_time
    }
}

/// Per-token treasury accounting for accumulated protocol fees.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelTreasury {
    pub charged_total: i128,
    pub withdrawn_total: i128,
}

impl ModelTreasury {
    pub fn collectible(&self) -> i128 {
        self.charged_total.saturating_sub(self.withdrawn_total)
    }
}

/// Read-only snapshot of treasury status for a token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelTreasuryStatus {
    pub token: String,
    pub governor: String,
    pub pending_governor: Option<String>,
    pub fee_bps: u32,
    pub max_fee_bps: u32,
    pub charged_total: i128,
    pub withdrawn_total: i128,
    pub collectible: i128,
}

/// One bounded page of protocol fee scan across stream ids.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelFeeScan {
    pub token: String,
    pub fees_in_range: i128,
    pub next_start_id: u64,
    pub done: bool,
}

/// Governance-managed policy floors and ceilings for streams.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelStreamPolicy {
    pub min_rate: i128,
    pub max_rate: i128,
    pub min_duration: u64,
    pub max_duration: u64,
    pub min_deposit: i128,
}
