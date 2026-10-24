//! Storage layout and persistence helpers for the vault.
//!
//! # Layout
//!
//! - Instance storage: `VaultConfig` (owner, token, start, end, total_weight,
//!   recipient_count, pool_balance).  Instance storage is cheapest for
//!   hot data that changes every transaction.
//!
//! - Persistent storage: one `Recipient` entry per registered address.
//!   These entries can be long-lived; TTL is extended on every mutation.
//!
//! The recipient list is maintained as an append-only Vec<Address> under a
//! single persistent key so iteration during rebalance is O(n) without
//! having to scan a sparse id space.  n is expected to be small (payroll
//! teams, DAO contributors) — the contract caps at MAX_RECIPIENTS.

use soroban_sdk::{contracttype, Address, Env, Vec};

pub(crate) const TTL_THRESHOLD: u32 = 200_000;
pub(crate) const TTL_EXTEND: u32 = 500_000;

/// Maximum number of simultaneous recipients.
/// Bounds the O(n) rebalance loop to a safe per-call budget.
pub const MAX_RECIPIENTS: u32 = 50;

/// Vault-wide configuration, kept in instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfig {
    pub owner: Address,
    pub token: Address,
    pub start_time: u64,
    pub end_time: u64,
    /// Sum of all active recipient weights.
    pub total_weight: u64,
    /// Number of active recipients.
    pub recipient_count: u32,
    /// Tokens in the vault reserved for pending recipient withdrawals or
    /// not yet allocated to any window.
    ///
    /// # Invariant
    ///
    /// `pool_balance` decreases by each window's allocation sum on rebalance
    /// and increases on `fund`.  It never goes below zero; the `check_solvency`
    /// guard enforces this after every rebalance.
    pub pool_balance: i128,
}

/// Per-recipient state, kept in persistent storage.
///
/// # Accounting model
///
/// The vault uses a two-level accounting model:
///
/// - `settled`: cumulative tokens *locked in as obligation* across all
///   completed windows (increased on rebalance, never decreased).
/// - `withdrawn`: cumulative tokens *actually transferred* to the recipient
///   (increased on `withdraw` or `remove_recipient`).
/// - `deposit` / `rebalance_time`: parameters of the *current* accrual window.
///
/// At any time:
///   `pending_in_window = owed_at(deposit, window_duration, elapsed)`
///   `available         = settled - withdrawn + pending_in_window`
///
/// This correctly handles tokens settled across multiple rebalances: they
/// accumulate in `settled` and are only cleared when the recipient withdraws.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recipient {
    pub weight: u32,
    /// Deposit allocated at the last rebalance (current window only).
    pub deposit: i128,
    /// Tokens locked in as obligation from all *completed* windows.
    /// Increased on each rebalance; never decreased.
    pub settled: i128,
    /// Total tokens actually transferred to this recipient (lifetime).
    /// Increased on `withdraw` and on payout at `remove_recipient`.
    pub withdrawn: i128,
    /// Ledger timestamp at which the current deposit window started.
    pub rebalance_time: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// VaultConfig in instance storage.
    Config,
    /// Per-recipient record (persistent).
    Recipient(Address),
    /// Ordered list of active recipient addresses (persistent).
    RecipientList,
}

// ---------------------------------------------------------------- config --

pub fn has_config(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Config)
}

pub fn get_config(env: &Env) -> VaultConfig {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("vault not initialized")
}

pub fn put_config(env: &Env, cfg: &VaultConfig) {
    env.storage().instance().set(&DataKey::Config, cfg);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

// ------------------------------------------------------------ recipients --

pub fn get_recipient(env: &Env, addr: &Address) -> Option<Recipient> {
    let key = DataKey::Recipient(addr.clone());
    let r = env.storage().persistent().get(&key);
    if r.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    }
    r
}

pub fn put_recipient(env: &Env, addr: &Address, r: &Recipient) {
    let key = DataKey::Recipient(addr.clone());
    env.storage().persistent().set(&key, r);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

pub fn remove_recipient(env: &Env, addr: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Recipient(addr.clone()));
}

// ------------------------------------------------------- recipient list --

pub fn get_recipient_list(env: &Env) -> Vec<Address> {
    let key = DataKey::RecipientList;
    let list: Option<Vec<Address>> = env.storage().persistent().get(&key);
    list.unwrap_or_else(|| Vec::new(env))
}

pub fn put_recipient_list(env: &Env, list: &Vec<Address>) {
    let key = DataKey::RecipientList;
    env.storage().persistent().set(&key, list);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}
