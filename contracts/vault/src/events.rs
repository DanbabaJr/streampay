//! Events emitted by the Vault contract.

use soroban_sdk::{contractevent, Address};

/// Emitted when the vault is initialized.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInitialized {
    pub owner: Address,
    pub token: Address,
    pub start_time: u64,
    pub end_time: u64,
}

/// Emitted when tokens are deposited into the vault pool.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolFunded {
    pub funder: Address,
    pub amount: i128,
    /// Pool balance after this deposit.
    pub new_balance: i128,
}

/// Emitted when a recipient is added to the vault.
/// Also emitted on rebalance after the join — the new allocation is recorded
/// in the immediately-following `Rebalanced` event.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecipientAdded {
    #[topic]
    pub recipient: Address,
    pub weight: u32,
    pub total_weight: u64,
}

/// Emitted when a recipient is removed from the vault.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecipientRemoved {
    #[topic]
    pub recipient: Address,
    /// Accrued amount paid out at removal time.
    pub paid_out: i128,
    pub total_weight: u64,
}

/// Emitted after every rebalance: records the new pool balance and the
/// total weight so off-chain tools can reconstruct each recipient's
/// allocation without storing per-recipient state.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rebalanced {
    /// Pool balance available for new allocation (after any settlement payouts).
    pub pool_balance: i128,
    pub total_weight: u64,
    /// Number of active recipients after this rebalance.
    pub recipient_count: u32,
}

/// Emitted when a recipient withdraws their accrued share.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultWithdrawn {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
    /// Total paid to this recipient across all withdrawals.
    pub total_paid: i128,
}
