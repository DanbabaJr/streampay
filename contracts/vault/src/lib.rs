#![no_std]

//! # StreamPay Vault
//!
//! A single funded pool that streams tokens to N recipients continuously,
//! each receiving a pro-rata share according to their weight.
//!
//! ## Solvency guarantee
//!
//! After every rebalance:
//! ```text
//! sum(deposit_i) + sum(settled_i - withdrawn_i) <= contract_token_balance
//! ```
//! i.e. the vault can always pay every pending obligation.  `pool_balance`
//! tracks the above right-hand side; `check_solvency` asserts it after every
//! allocation.
//!
//! ## Accounting model
//!
//! Each recipient carries:
//! - `deposit`        — tokens allocated to their *current* window.
//! - `rebalance_time` — when the current window started.
//! - `settled`        — cumulative obligation locked in from *all past* windows.
//! - `withdrawn`      — cumulative tokens actually transferred (lifetime).
//!
//! Available at time `t`:
//! ```text
//! pending  = owed_at(deposit, window_duration, elapsed(t))
//! available = settled - withdrawn + pending
//! ```
//!
//! ## Rebalance on join / leave
//!
//! 1. **Settle** — for each recipient compute `pending` for the elapsed
//!    portion of the current window, add it to `settled`, then reset their
//!    window (`deposit = 0, rebalance_time = now`).  Deduct the newly settled
//!    amount from `pool_balance` (those tokens are now "spoken for").
//! 2. **Allocate** — split `pool_balance` pro-rata among all active
//!    recipients.  Each gets `floor(pool_balance * w_i / total_weight)`.
//! 3. **Solvency check** — `sum(deposit_i) <= pool_balance`.
//! 4. **Residual** — `pool_balance - sum(deposit_i)` (floor remainder) stays
//!    in the contract and is included in the *next* rebalance's pool.
//!
//! ## Fair-degradation (underfunded pool)
//!
//! Pro-rata allocation naturally applies a haircut when `pool_balance < ideal`.
//! No operation is rejected; deposits are simply smaller.
//!
//! ## Pure math (fuzz target)
//!
//! [`owed_at`] takes only `(i128, u64, u64)` — no `Env`.  Export it from
//! the crate so a fuzz harness can call it directly.

#[cfg(test)]
extern crate std;

mod errors;
mod events;
mod math;
mod storage;
#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token::TokenClient, Address, Env, Vec};

pub use errors::VaultError;
pub use math::owed_at;
pub use storage::{Recipient, VaultConfig, MAX_RECIPIENTS};

use events::{
    PoolFunded, Rebalanced, RecipientAdded, RecipientRemoved, VaultInitialized, VaultWithdrawn,
};
use storage::{
    get_config, get_recipient, get_recipient_list, has_config, put_config, put_recipient,
    put_recipient_list, remove_recipient,
};

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    // ---------------------------------------------------------------- init --

    /// Initialize the vault.  Must be called exactly once, at deploy time.
    ///
    /// - `start_time` must not be in the past.
    /// - `end_time` must be strictly after `start_time`.
    pub fn initialize(
        env: Env,
        owner: Address,
        token: Address,
        start_time: u64,
        end_time: u64,
    ) -> Result<(), VaultError> {
        if has_config(&env) {
            return Err(VaultError::AlreadyInitialized);
        }
        let now = env.ledger().timestamp();
        if start_time < now || end_time <= start_time {
            return Err(VaultError::InvalidTimeRange);
        }
        owner.require_auth();
        put_config(
            &env,
            &VaultConfig {
                owner: owner.clone(),
                token: token.clone(),
                start_time,
                end_time,
                total_weight: 0,
                recipient_count: 0,
                pool_balance: 0,
            },
        );
        VaultInitialized {
            owner,
            token,
            start_time,
            end_time,
        }
        .publish(&env);
        Ok(())
    }

    // --------------------------------------------------------------- fund --

    /// Deposit `amount` tokens into the pool.
    ///
    /// Does not trigger a rebalance.  New tokens become available at the
    /// next `add_recipient` or `remove_recipient` call.
    pub fn fund(env: Env, funder: Address, amount: i128) -> Result<(), VaultError> {
        if amount <= 0 {
            return Err(VaultError::ZeroValue);
        }
        let mut cfg = require_config(&env)?;
        funder.require_auth();

        // Pull first (incoming transfer; no state to corrupt before the pull).
        let pull_res = TokenClient::new(&env, &cfg.token).try_transfer_from(
            &env.current_contract_address(),
            &funder,
            &env.current_contract_address(),
            &amount,
        );
        match pull_res {
            Ok(Ok(())) => {}
            _ => return Err(VaultError::FundTransferFailed),
        }

        cfg.pool_balance = cfg
            .pool_balance
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        put_config(&env, &cfg);

        PoolFunded {
            funder,
            amount,
            new_balance: cfg.pool_balance,
        }
        .publish(&env);
        Ok(())
    }

    // ---------------------------------------------------- add_recipient --

    /// Register a new recipient with the given weight and trigger a rebalance.
    ///
    /// Owner-only.  Rejects duplicate registrations and calls after the
    /// vault's end time.
    pub fn add_recipient(env: Env, recipient: Address, weight: u32) -> Result<(), VaultError> {
        if weight == 0 {
            return Err(VaultError::ZeroValue);
        }
        let mut cfg = require_config(&env)?;
        cfg.owner.require_auth();

        let now = env.ledger().timestamp();
        if now >= cfg.end_time {
            return Err(VaultError::VaultClosed);
        }
        if get_recipient(&env, &recipient).is_some() {
            return Err(VaultError::RecipientAlreadyExists);
        }
        if cfg.recipient_count >= MAX_RECIPIENTS {
            return Err(VaultError::TooManyRecipients);
        }

        // 1. Settle current windows for all existing recipients.
        let (pool_for_allocation, mut list) = settle_all(&env, &cfg, now)?;

        // 2. Register the new recipient with a zeroed window (no past accrual).
        put_recipient(
            &env,
            &recipient,
            &Recipient {
                weight,
                deposit: 0,
                settled: 0,
                withdrawn: 0,
                rebalance_time: now,
            },
        );
        list.push_back(recipient.clone());

        let new_total_weight = cfg
            .total_weight
            .checked_add(weight as u64)
            .ok_or(VaultError::MathOverflow)?;

        // 3. Allocate pool pro-rata among all recipients (including the new one).
        let residual = allocate_deposits(&env, &list, pool_for_allocation, new_total_weight, now)?;

        cfg.total_weight = new_total_weight;
        cfg.recipient_count = list.len();
        cfg.pool_balance = residual;
        put_config(&env, &cfg);
        put_recipient_list(&env, &list);

        RecipientAdded {
            recipient,
            weight,
            total_weight: new_total_weight,
        }
        .publish(&env);
        Rebalanced {
            pool_balance: pool_for_allocation,
            total_weight: new_total_weight,
            recipient_count: cfg.recipient_count,
        }
        .publish(&env);
        Ok(())
    }

    // ------------------------------------------------- remove_recipient --

    /// Remove a recipient, paying out all they are owed (settled + pending).
    ///
    /// Owner-only.  Settles all recipients first, then removes the target
    /// and rebalances the remainder.
    pub fn remove_recipient(env: Env, recipient: Address) -> Result<(), VaultError> {
        let mut cfg = require_config(&env)?;
        cfg.owner.require_auth();

        // Verify existence before mutating anything.
        let departing_weight = get_recipient(&env, &recipient)
            .ok_or(VaultError::RecipientNotFound)?
            .weight;
        let now = env.ledger().timestamp();

        // 1. Settle all windows.
        let (pool_for_allocation, mut list) = settle_all(&env, &cfg, now)?;

        // 2. Compute what the departing recipient is owed (settled - withdrawn).
        //    After settle_all their pending is now in `settled`; their current
        //    window deposit is 0 (settle_all resets it).
        let departing = get_recipient(&env, &recipient).ok_or(VaultError::RecipientNotFound)?;
        let owed = departing
            .settled
            .checked_sub(departing.withdrawn)
            .ok_or(VaultError::MathOverflow)?;

        // Remove from list and storage (CEI: all effects before token transfer).
        remove_from_list(&env, &mut list, &recipient);
        remove_recipient(&env, &recipient);

        let new_total_weight = cfg
            .total_weight
            .checked_sub(departing_weight as u64)
            .ok_or(VaultError::MathOverflow)?;

        let residual = if list.is_empty() {
            pool_for_allocation
        } else {
            allocate_deposits(&env, &list, pool_for_allocation, new_total_weight, now)?
        };

        cfg.total_weight = new_total_weight;
        cfg.recipient_count = list.len();
        cfg.pool_balance = residual;
        put_config(&env, &cfg);
        put_recipient_list(&env, &list);

        RecipientRemoved {
            recipient: recipient.clone(),
            paid_out: owed,
            total_weight: new_total_weight,
        }
        .publish(&env);
        Rebalanced {
            pool_balance: pool_for_allocation,
            total_weight: new_total_weight,
            recipient_count: cfg.recipient_count,
        }
        .publish(&env);

        // Interaction last (CEI).
        if owed > 0 {
            let res = TokenClient::new(&env, &cfg.token).try_transfer(
                &env.current_contract_address(),
                &recipient,
                &owed,
            );
            match res {
                Ok(Ok(())) => {}
                _ => return Err(VaultError::RecipientPayoutFailed),
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------- withdraw --

    /// Claim all currently available tokens.  Recipient-only.
    ///
    /// Does not trigger a rebalance; the current window continues unchanged.
    pub fn withdraw(env: Env, recipient: Address) -> Result<i128, VaultError> {
        let cfg = require_config(&env)?;
        recipient.require_auth();

        let mut r = get_recipient(&env, &recipient).ok_or(VaultError::RecipientNotFound)?;
        let now = env.ledger().timestamp();

        let available = available_for(&cfg, &r, now)?;
        if available <= 0 {
            return Err(VaultError::NothingToWithdraw);
        }

        // CEI: record withdrawal before transferring.
        r.withdrawn = r
            .withdrawn
            .checked_add(available)
            .ok_or(VaultError::MathOverflow)?;
        put_recipient(&env, &recipient, &r);

        VaultWithdrawn {
            recipient: recipient.clone(),
            amount: available,
            total_paid: r.withdrawn,
        }
        .publish(&env);

        let res = TokenClient::new(&env, &cfg.token).try_transfer(
            &env.current_contract_address(),
            &recipient,
            &available,
        );
        match res {
            Ok(Ok(())) => {}
            _ => return Err(VaultError::WithdrawTransferFailed),
        }
        Ok(available)
    }

    // --------------------------------------------------------- read-only --

    /// Full vault configuration snapshot.
    pub fn vault_status(env: Env) -> Result<VaultConfig, VaultError> {
        require_config(&env)
    }

    /// Stored state for a single recipient.
    pub fn recipient_status(env: Env, recipient: Address) -> Result<Recipient, VaultError> {
        require_config(&env)?;
        get_recipient(&env, &recipient).ok_or(VaultError::RecipientNotFound)
    }

    /// Accrued-but-unwithdraw balance for `recipient` at the current ledger time.
    pub fn available(env: Env, recipient: Address) -> Result<i128, VaultError> {
        let cfg = require_config(&env)?;
        let r = get_recipient(&env, &recipient).ok_or(VaultError::RecipientNotFound)?;
        let now = env.ledger().timestamp();
        available_for(&cfg, &r, now)
    }
}

// ----------------------------------------------------------------- helpers --

fn require_config(env: &Env) -> Result<VaultConfig, VaultError> {
    if !has_config(env) {
        return Err(VaultError::NotInitialized);
    }
    Ok(get_config(env))
}

/// Accrued-but-unwithdraw balance for `r` at `now`.
///
/// `available = (settled - withdrawn) + owed_at(deposit, window_duration, elapsed)`
fn available_for(cfg: &VaultConfig, r: &Recipient, now: u64) -> Result<i128, VaultError> {
    let duration = cfg.end_time.saturating_sub(r.rebalance_time).max(1);
    let window_end = r.rebalance_time.saturating_add(duration).min(cfg.end_time);
    let elapsed = math::elapsed(now, r.rebalance_time, window_end);
    let pending = math::owed_at(r.deposit, duration, elapsed)?;
    let from_past = r
        .settled
        .checked_sub(r.withdrawn)
        .ok_or(VaultError::MathOverflow)?;
    Ok(from_past.saturating_add(pending).max(0))
}

/// Settle every active recipient's current window up to `now`.
///
/// For each recipient:
/// - Computes `pending = owed_at(deposit, duration, elapsed)`.
/// - Adds `pending` to `r.settled`.
/// - Resets `r.deposit = 0` and `r.rebalance_time = now`
///   (the window is consumed; a fresh one starts after `allocate_deposits`).
/// - Deducts `pending` from `pool` (those tokens are now "spoken for").
///
/// Returns `(pool_available_for_new_allocation, list)`.
fn settle_all(env: &Env, cfg: &VaultConfig, now: u64) -> Result<(i128, Vec<Address>), VaultError> {
    let list = get_recipient_list(env);
    let mut pool = cfg.pool_balance;

    for i in 0..list.len() {
        let addr = list.get(i).unwrap();
        let mut r = match get_recipient(env, &addr) {
            Some(r) => r,
            None => continue,
        };

        let duration = cfg.end_time.saturating_sub(r.rebalance_time).max(1);
        let window_end = r.rebalance_time.saturating_add(duration).min(cfg.end_time);
        let elapsed = math::elapsed(now, r.rebalance_time, window_end);
        let pending = math::owed_at(r.deposit, duration, elapsed)?;

        if pending > 0 {
            r.settled = r
                .settled
                .checked_add(pending)
                .ok_or(VaultError::MathOverflow)?;
        }
        let unaccrued = r
            .deposit
            .checked_sub(pending)
            .ok_or(VaultError::MathOverflow)?;
        pool = pool
            .checked_add(unaccrued)
            .ok_or(VaultError::MathOverflow)?;

        // Reset the window; allocate_deposits will set a fresh deposit.
        r.deposit = 0;
        r.rebalance_time = now;
        put_recipient(env, &addr, &r);
    }

    Ok((pool.max(0), list))
}

/// Allocate `pool_balance` pro-rata among `list` and write each recipient's
/// new `deposit` and `rebalance_time`.
///
/// Returns the integer residual (floor remainder) that was not allocated;
/// it remains in the contract and is included in the next rebalance's pool.
fn allocate_deposits(
    env: &Env,
    list: &Vec<Address>,
    pool_balance: i128,
    total_weight: u64,
    now: u64,
) -> Result<i128, VaultError> {
    if total_weight == 0 || list.is_empty() {
        return Ok(pool_balance);
    }
    let mut total_allocated: i128 = 0;

    for i in 0..list.len() {
        let addr = list.get(i).unwrap();
        let mut r = get_recipient(env, &addr).ok_or(VaultError::RecipientNotFound)?;
        let deposit = math::pro_rata_deposit(pool_balance, r.weight, total_weight)?;
        r.deposit = deposit;
        r.rebalance_time = now;
        put_recipient(env, &addr, &r);
        total_allocated = total_allocated
            .checked_add(deposit)
            .ok_or(VaultError::MathOverflow)?;
    }

    // Guard: the sum of allocations must not exceed the pool.
    math::check_solvency(total_allocated, pool_balance)?;
    Ok(pool_balance - total_allocated)
}

/// Remove an address from the in-memory list and persist the result.
fn remove_from_list(env: &Env, list: &mut Vec<Address>, target: &Address) {
    let mut i = 0u32;
    while i < list.len() {
        if list.get(i).as_ref() == Some(target) {
            list.remove(i);
            break;
        }
        i += 1;
    }
    put_recipient_list(env, list);
}
