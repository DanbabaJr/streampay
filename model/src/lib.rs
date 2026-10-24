//! Standalone reference specification model of the StreamPay protocol.
//!
//! Plain Rust functions with no [`soroban_sdk::Env`] dependencies.
//! A reviewer can approve this model directly as the protocol specification.

pub mod action;
pub mod errors;
pub mod events;
pub mod math;
pub mod model;
pub mod seeds;
pub mod types;

pub use action::{Action, ActionSequence};
pub use errors::ModelError;
pub use events::ModelEvent;
pub use math::{
    available_amount, cancel_amounts, elapsed_seconds, fee_amount, streamed_at,
    streamed_at_rate_schedule, streamed_at_schedule, validate_capacity, ModelRateSegment,
};
pub use model::{ModelMutations, StreamPayModel};
pub use seeds::all_seeded_scenarios;
pub use types::{
    ModelFeeScan, ModelStream, ModelStreamStatus, ModelTreasury, ModelTreasuryStatus,
    BPS_DENOMINATOR, MAX_DURATION_SECONDS, MAX_FEE_BPS, MAX_PAGE_SIZE,
};
