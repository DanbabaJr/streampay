//! Adversarial / Hostile Token Fuzz & Integration Harness
//!
//! Evaluates the funds paths of `StreamingPayments` against deliberately
//! misbehaving SEP-41 token contracts to prove the contract degrades safely
//! and preserves internal accounting invariants without balance divergence.
//!
//! # Hostile Token Variants Implemented:
//! 1. [`RevertingToken`]: Intentionally returns errors or aborts during `transfer`
//!    or `transfer_from` based on configurable trigger flags (simulates failed
//!    payouts, frozen recipient accounts, blacklisted callers, or transfer limits).
//! 2. [`PanickingToken`]: Unconditionally or conditionally panics (host trap)
//!    inside `transfer` or `transfer_from`. Soroban aborts the transaction, rolling
//!    back any uncommitted state changes.
//! 3. [`DoubleChargingToken`]: Maliciously debits additional funds or simulates
//!    double-charging/reentrancy hooks on transfer calls.
//! 4. [`LyingBalanceToken`]: Reports manipulated, inflated, zero, or negative
//!    fictional balances in `balance()`, verifying the streaming contract does not
//!    rely on external token queries for internal accounting or invariant checks.
//!
//! # Invariant (Oracle):
//! Across arbitrary permutations of entrypoints and injected hostile token behaviors,
//! no hostile token variant may leave a stream's internal accounting diverging from
//! the actual contract balance. Specifically:
//! `actual_token_balance >= outstanding_stream_obligations + collectible_treasury_fees`
//! and whenever a transfer fails, atomic rollback ensures the contract's internal
//! ledger does not advance without matching token movements.

#![cfg(test)]

extern crate std;

use std::format;
use std::vec::Vec;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    token::Client as TokenClient,
    Address, Env, MuxedAddress, String as SdkString,
};

use crate::test_client::StreamingPaymentsClient as Client;
use crate::{StreamError, StreamStatus, StreamingPayments};

// ---------------------------------------------------------------- Hostile Errors
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum HostileError {
    TransferRejected = 1001,
    TransferFromRejected = 1002,
}

// ---------------------------------------------------------------- 1. RevertingToken
/// A token that can be configured to revert on `transfer` or `transfer_from`.
#[contract]
pub struct RevertingToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RevertingKey {
    Balance(Address),
    RevertTransfer,
    RevertTransferFrom,
}

#[contractimpl]
impl RevertingToken {
    pub fn set_revert_transfer(env: Env, enable: bool) {
        env.storage()
            .temporary()
            .set(&RevertingKey::RevertTransfer, &enable);
    }

    pub fn set_revert_transfer_from(env: Env, enable: bool) {
        env.storage()
            .temporary()
            .set(&RevertingKey::RevertTransferFrom, &enable);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = RevertingKey::Balance(to);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&RevertingKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: MuxedAddress,
        amount: i128,
    ) -> Result<(), HostileError> {
        let should_revert: bool = env
            .storage()
            .temporary()
            .get(&RevertingKey::RevertTransfer)
            .unwrap_or(false);
        if should_revert {
            return Err(HostileError::TransferRejected);
        }
        let from_key = RevertingKey::Balance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_bal < amount {
            return Err(HostileError::TransferRejected);
        }
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));

        let to_addr: Address = to.into();
        let to_key = RevertingKey::Balance(to_addr);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
        Ok(())
    }

    pub fn transfer_from(
        env: Env,
        _spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), HostileError> {
        let should_revert: bool = env
            .storage()
            .temporary()
            .get(&RevertingKey::RevertTransferFrom)
            .unwrap_or(false);
        if should_revert {
            return Err(HostileError::TransferFromRejected);
        }
        let from_key = RevertingKey::Balance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_bal < amount {
            return Err(HostileError::TransferFromRejected);
        }
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));

        let to_key = RevertingKey::Balance(to);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
        Ok(())
    }

    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _live_until_ledger: u32,
    ) {
    }

    pub fn burn(_env: Env, _from: Address, _amount: i128) {}

    pub fn burn_from(_env: Env, _spender: Address, _from: Address, _amount: i128) {}

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "Reverting Hostile Token")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "REV")
    }
}

// ---------------------------------------------------------------- 2. PanickingToken
/// A token that deliberately invokes `panic!` on `transfer` or `transfer_from`.
#[contract]
pub struct PanickingToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PanickingKey {
    Balance(Address),
    PanicTransfer,
    PanicTransferFrom,
}

#[contractimpl]
impl PanickingToken {
    pub fn set_panic_transfer(env: Env, enable: bool) {
        env.storage()
            .temporary()
            .set(&PanickingKey::PanicTransfer, &enable);
    }

    pub fn set_panic_transfer_from(env: Env, enable: bool) {
        env.storage()
            .temporary()
            .set(&PanickingKey::PanicTransferFrom, &enable);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = PanickingKey::Balance(to);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&PanickingKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        let should_panic: bool = env
            .storage()
            .temporary()
            .get(&PanickingKey::PanicTransfer)
            .unwrap_or(false);
        if should_panic {
            panic!("Hostile PanickingToken: explicit transfer panic");
        }
        let from_key = PanickingKey::Balance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        assert!(from_bal >= amount, "insufficient balance");
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));

        let to_addr: Address = to.into();
        let to_key = PanickingKey::Balance(to_addr);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
    }

    pub fn transfer_from(env: Env, _spender: Address, from: Address, to: Address, amount: i128) {
        let should_panic: bool = env
            .storage()
            .temporary()
            .get(&PanickingKey::PanicTransferFrom)
            .unwrap_or(false);
        if should_panic {
            panic!("Hostile PanickingToken: explicit transfer_from panic");
        }
        let from_key = PanickingKey::Balance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        assert!(from_bal >= amount, "insufficient balance");
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));

        let to_key = PanickingKey::Balance(to);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
    }

    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _live_until_ledger: u32,
    ) {
    }

    pub fn burn(_env: Env, _from: Address, _amount: i128) {}

    pub fn burn_from(_env: Env, _spender: Address, _from: Address, _amount: i128) {}

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "Panicking Hostile Token")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "PANIC")
    }
}

// ---------------------------------------------------------------- 3. DoubleChargingToken
/// A token that charges double fee/debit from the caller or attempts reentrancy attacks.
#[contract]
pub struct DoubleChargingToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DoubleChargeKey {
    Balance(Address),
    DrainExtraFee,
    ReenterTarget,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReenterConfig {
    pub target: Address,
    pub stream_id: u64,
    pub amount: i128,
}

#[contractimpl]
impl DoubleChargingToken {
    pub fn set_drain_extra(env: Env, enable: bool) {
        env.storage()
            .temporary()
            .set(&DoubleChargeKey::DrainExtraFee, &enable);
    }

    pub fn arm_reentrancy(env: Env, target: Address, stream_id: u64, amount: i128) {
        env.storage().temporary().set(
            &DoubleChargeKey::ReenterTarget,
            &Some(ReenterConfig {
                target,
                stream_id,
                amount,
            }),
        );
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = DoubleChargeKey::Balance(to);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DoubleChargeKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        let reenter: Option<ReenterConfig> = env
            .storage()
            .temporary()
            .get(&DoubleChargeKey::ReenterTarget)
            .unwrap_or(None);
        if let Some(cfg) = reenter {
            if cfg.target == from {
                env.storage()
                    .temporary()
                    .remove(&DoubleChargeKey::ReenterTarget);
                let client = Client::new(&env, &cfg.target);
                // Attempt reentrant double-withdrawal while in transfer
                let _ = client.try_withdraw(&cfg.stream_id, &cfg.amount);
            }
        }

        let drain_extra: bool = env
            .storage()
            .temporary()
            .get(&DoubleChargeKey::DrainExtraFee)
            .unwrap_or(false);
        let extra = if drain_extra { amount } else { 0 };
        let from_key = DoubleChargeKey::Balance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        let total_deduct = amount + extra;
        assert!(
            from_bal >= total_deduct,
            "insufficient balance for double charge"
        );
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - total_deduct));

        let to_addr: Address = to.into();
        let to_key = DoubleChargeKey::Balance(to_addr);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
    }

    pub fn transfer_from(env: Env, _spender: Address, from: Address, to: Address, amount: i128) {
        let drain_extra: bool = env
            .storage()
            .temporary()
            .get(&DoubleChargeKey::DrainExtraFee)
            .unwrap_or(false);
        let extra = if drain_extra { amount } else { 0 };
        let from_key = DoubleChargeKey::Balance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        let total_deduct = amount + extra;
        assert!(
            from_bal >= total_deduct,
            "insufficient balance for double pull"
        );
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - total_deduct));

        let to_key = DoubleChargeKey::Balance(to);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
    }

    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _live_until_ledger: u32,
    ) {
    }

    pub fn burn(_env: Env, _from: Address, _amount: i128) {}

    pub fn burn_from(_env: Env, _spender: Address, _from: Address, _amount: i128) {}

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "Double Charging Hostile Token")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "DBL")
    }
}

// ---------------------------------------------------------------- 4. LyingBalanceToken
/// A token that reports false / fake balances, demonstrating the streaming contract
/// does not rely on external balance queries for its internal stream accounting.
#[contract]
pub struct LyingBalanceToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LyingKey {
    ActualBalance(Address),
    LieMode,
}

#[contractimpl]
impl LyingBalanceToken {
    /// 0 = truth, 1 = always zero, 2 = always i128::MAX, 3 = negative balance
    pub fn set_lie_mode(env: Env, mode: u32) {
        env.storage().temporary().set(&LyingKey::LieMode, &mode);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = LyingKey::ActualBalance(to);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        let mode: u32 = env
            .storage()
            .temporary()
            .get(&LyingKey::LieMode)
            .unwrap_or(0);
        match mode {
            1 => 0,
            2 => i128::MAX,
            3 => -1_000_000,
            _ => env
                .storage()
                .persistent()
                .get(&LyingKey::ActualBalance(id))
                .unwrap_or(0),
        }
    }

    pub fn actual_balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&LyingKey::ActualBalance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        let from_key = LyingKey::ActualBalance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        assert!(from_bal >= amount, "insufficient actual balance");
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));

        let to_addr: Address = to.into();
        let to_key = LyingKey::ActualBalance(to_addr);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
    }

    pub fn transfer_from(env: Env, _spender: Address, from: Address, to: Address, amount: i128) {
        let from_key = LyingKey::ActualBalance(from);
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        assert!(from_bal >= amount, "insufficient actual balance");
        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));

        let to_key = LyingKey::ActualBalance(to);
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage().persistent().set(&to_key, &(to_bal + amount));
    }

    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _live_until_ledger: u32,
    ) {
    }

    pub fn burn(_env: Env, _from: Address, _amount: i128) {}

    pub fn burn_from(_env: Env, _spender: Address, _from: Address, _amount: i128) {}

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "Lying Hostile Token")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "LIE")
    }
}

// ---------------------------------------------------------------- Test Harness & Oracle
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
}

#[derive(Clone, Debug)]
struct TrackedStream {
    id: u64,
    token_idx: usize,
    deposit: i128,
    withdrawn: i128,
    start: u64,
    end: u64,
    cancelable: bool,
    live: bool,
}

/// Fuzz harness executing randomized sequences of contract entrypoints
/// against all four hostile token contracts with per-call injected behaviors.
#[test]
fn test_fuzz_hostile_tokens_degrade_safely_oracle() {
    let seeds = [
        0xDEAD_BEEF_0001,
        0xDEAD_BEEF_0002,
        0xDEAD_BEEF_0003,
        0xCAFE_BABE_0001,
    ];
    for seed in seeds {
        run_hostile_token_fuzz_session(seed, 100);
    }
}

fn run_hostile_token_fuzz_session(seed: u64, steps: usize) {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();

    let governor = Address::generate(&env);
    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let client = Client::new(&env, &contract_id);

    // Register all 4 hostile token implementations
    let rev_id = env.register(RevertingToken, ());
    let panic_id = env.register(PanickingToken, ());
    let dbl_id = env.register(DoubleChargingToken, ());
    let lie_id = env.register(LyingBalanceToken, ());

    let token_addrs = [
        rev_id.clone(),
        panic_id.clone(),
        dbl_id.clone(),
        lie_id.clone(),
    ];
    let rev_client = RevertingTokenClient::new(&env, &rev_id);
    let panic_client = PanickingTokenClient::new(&env, &panic_id);
    let dbl_client = DoubleChargingTokenClient::new(&env, &dbl_id);
    let lie_client = LyingBalanceTokenClient::new(&env, &lie_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let vault = Address::generate(&env);

    // Initial funding for all tokens
    let initial_fund = 10_000_000_000_000i128;
    rev_client.mint(&sender, &initial_fund);
    panic_client.mint(&sender, &initial_fund);
    dbl_client.mint(&sender, &initial_fund);
    lie_client.mint(&sender, &initial_fund);

    let mut rng = Rng::new(seed);
    let mut tracked_streams: Vec<TrackedStream> = Vec::new();
    let mut charged_fees = [0i128; 4];
    let mut withdrawn_fees = [0i128; 4];
    let mut fee_bps = 0u32;

    for step in 0..steps {
        let ctx = format!("seed {seed:#x} step {step}");

        // Injected Hostile Behaviors per-call
        let hostile_injection = rng.below(6);
        match hostile_injection {
            0 => {
                // Revert on transfer / transfer_from toggle
                rev_client.set_revert_transfer(&(rng.below(2) == 1));
                rev_client.set_revert_transfer_from(&(rng.below(2) == 1));
            }
            1 => {
                // Panic on transfer / transfer_from toggle
                panic_client.set_panic_transfer(&(rng.below(2) == 1));
                panic_client.set_panic_transfer_from(&(rng.below(2) == 1));
            }
            2 => {
                // Arm reentrancy or extra drain
                dbl_client.set_drain_extra(&(rng.below(2) == 1));
                if !tracked_streams.is_empty() {
                    let s_idx = rng.below(tracked_streams.len() as u64) as usize;
                    if tracked_streams[s_idx].live && tracked_streams[s_idx].token_idx == 2 {
                        let id = tracked_streams[s_idx].id;
                        dbl_client.arm_reentrancy(&contract_id, &id, &1000);
                    }
                }
            }
            3 => {
                // Manipulate lying balance mode (0=truth, 1=zero, 2=max, 3=negative)
                let mode = rng.below(4) as u32;
                lie_client.set_lie_mode(&mode);
            }
            _ => {
                // Normal or reset behaviors
                rev_client.set_revert_transfer(&false);
                rev_client.set_revert_transfer_from(&false);
                panic_client.set_panic_transfer(&false);
                panic_client.set_panic_transfer_from(&false);
                dbl_client.set_drain_extra(&false);
                lie_client.set_lie_mode(&0);
            }
        }

        // Random action selection across fund paths
        let action = rng.below(7);
        match action {
            0 => {
                // create_stream
                let t_idx = rng.below(4) as usize;
                let deposit = 100 + rng.below(100_000) as i128;
                let duration = 10 + rng.below(200);
                let start_in = rng.below(5);
                let cancelable = rng.below(2) == 0;
                let now = env.ledger().timestamp();

                let res = client.mock_all_auths().try_create_stream(
                    &sender,
                    &recipient,
                    &token_addrs[t_idx],
                    &deposit,
                    &(now + start_in),
                    &(now + start_in + duration),
                    &cancelable,
                );

                if let Ok(Ok(new_id)) = res {
                    let fee = crate::treasury::fee_amount(deposit, fee_bps).unwrap_or(0);
                    charged_fees[t_idx] += fee;
                    tracked_streams.push(TrackedStream {
                        id: new_id,
                        token_idx: t_idx,
                        deposit,
                        withdrawn: 0,
                        start: now + start_in,
                        end: now + start_in + duration,
                        cancelable,
                        live: true,
                    });
                }
            }
            1 => {
                // advance time
                env.ledger()
                    .with_mut(|li| li.timestamp += 1 + rng.below(30));
            }
            2 => {
                // withdraw
                if !tracked_streams.is_empty() {
                    let s_idx = rng.below(tracked_streams.len() as u64) as usize;
                    if tracked_streams[s_idx].live {
                        let id = tracked_streams[s_idx].id;
                        let now = env.ledger().timestamp();
                        let avail = client.mock_all_auths().available(&id).unwrap_or(0);
                        if avail > 0 {
                            let w_res = client.mock_all_auths().try_withdraw(&id, &avail);
                            if w_res.is_ok() && w_res.unwrap().is_ok() {
                                tracked_streams[s_idx].withdrawn += avail;
                                if tracked_streams[s_idx].withdrawn
                                    == tracked_streams[s_idx].deposit
                                {
                                    tracked_streams[s_idx].live = false;
                                }
                            }
                        }
                    }
                }
            }
            3 => {
                // withdraw_max
                if !tracked_streams.is_empty() {
                    let s_idx = rng.below(tracked_streams.len() as u64) as usize;
                    if tracked_streams[s_idx].live {
                        let id = tracked_streams[s_idx].id;
                        let wm_res = client.mock_all_auths().try_withdraw_max(&id);
                        if let Ok(Ok(amount)) = wm_res {
                            tracked_streams[s_idx].withdrawn += amount;
                            if tracked_streams[s_idx].withdrawn == tracked_streams[s_idx].deposit {
                                tracked_streams[s_idx].live = false;
                            }
                        }
                    }
                }
            }
            4 => {
                // cancel_stream
                if !tracked_streams.is_empty() {
                    let s_idx = rng.below(tracked_streams.len() as u64) as usize;
                    if tracked_streams[s_idx].live {
                        let id = tracked_streams[s_idx].id;
                        let avail = client.mock_all_auths().available(&id).unwrap_or(0);
                        let c_res = client.mock_all_auths().try_cancel_stream(&sender, &id);
                        if c_res.is_ok() && c_res.unwrap().is_ok() {
                            tracked_streams[s_idx].withdrawn += avail;
                            tracked_streams[s_idx].live = false;
                        }
                    }
                }
            }
            5 => {
                // top_up
                if !tracked_streams.is_empty() {
                    let s_idx = rng.below(tracked_streams.len() as u64) as usize;
                    if tracked_streams[s_idx].live {
                        let id = tracked_streams[s_idx].id;
                        let top_amount = 50 + rng.below(1000) as i128;
                        let t_res = client.mock_all_auths().try_top_up(&id, &top_amount);
                        if t_res.is_ok() && t_res.unwrap().is_ok() {
                            tracked_streams[s_idx].deposit += top_amount;
                        }
                    }
                }
            }
            _ => {
                // withdraw_treasury
                let t_idx = rng.below(4) as usize;
                let collectible = charged_fees[t_idx] - withdrawn_fees[t_idx];
                if collectible > 0 {
                    let wt_res = client.mock_all_auths().try_withdraw_treasury(
                        &governor,
                        &token_addrs[t_idx],
                        &vault,
                        &collectible,
                    );
                    if wt_res.is_ok() && wt_res.unwrap().is_ok() {
                        withdrawn_fees[t_idx] += collectible;
                    }
                }
            }
        }

        // --- ORACLE: INVARIANT VERIFICATION AFTER EVERY STEP ---
        for ti in 0..4 {
            let actual_token_bal = match ti {
                0 => rev_client.balance(&contract_id),
                1 => panic_client.balance(&contract_id),
                2 => dbl_client.balance(&contract_id),
                3 => lie_client.actual_balance(&contract_id),
                _ => 0,
            };

            let expected_outstanding: i128 = tracked_streams
                .iter()
                .filter(|s| s.token_idx == ti && s.live)
                .map(|s| s.deposit - s.withdrawn)
                .sum();

            let collectible_fees = charged_fees[ti] - withdrawn_fees[ti];
            let total_obligations = expected_outstanding + collectible_fees;

            // Invariant: The contract must never hold less balance than internal obligations.
            // Under any hostile token behavior (reverting, panicking, lying, or double-charging),
            // internal accounting must degrade safely and not leave the contract underfunded.
            assert!(
                actual_token_bal >= total_obligations,
                "{ctx}: BALANCE DIVERGENCE DETECTED for token {ti}! Actual: {actual_token_bal}, Obligations: {total_obligations} (Outstanding: {expected_outstanding}, Collectible Fees: {collectible_fees})"
            );

            // Stored stream status invariant: withdrawn <= deposit
            for s in tracked_streams.iter().filter(|s| s.token_idx == ti) {
                if let Ok(onchain_s) = client.get_stream(&s.id) {
                    assert!(
                        onchain_s.withdrawn <= onchain_s.deposit,
                        "{ctx}: stream {} withdrawn exceeds deposit ({} > {})",
                        s.id,
                        onchain_s.withdrawn,
                        onchain_s.deposit
                    );
                }
            }
        }
    }
}
