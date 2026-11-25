#![cfg(test)]

extern crate std;

use soroban_sdk::{
    contractclient,
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

use crate::{math, Recipient, Vault, VaultConfig, VaultError};

// ---------------------------------------------------------------- constants

const DAY: u64 = 86_400;
/// 1_000 tokens with 7 decimals.
const TOKENS: i128 = 10_000_000_000;

// ----------------------------------------------------------------- client --
//
// `#[contractimpl]` generates an exported client only when the impl is in a
// different crate.  For in-crate tests we declare the interface as a trait
// and derive a client from it — exactly the same pattern as test_client.rs
// in the streaming-payments contract.

#[contractclient(name = "VaultClient")]
#[allow(dead_code)]
pub trait VaultApi {
    fn initialize(
        env: Env,
        owner: Address,
        token: Address,
        start_time: u64,
        end_time: u64,
    ) -> Result<(), VaultError>;
    fn fund(env: Env, funder: Address, amount: i128) -> Result<(), VaultError>;
    fn add_recipient(env: Env, recipient: Address, weight: u32) -> Result<(), VaultError>;
    fn remove_recipient(env: Env, recipient: Address) -> Result<(), VaultError>;
    fn withdraw(env: Env, recipient: Address) -> Result<i128, VaultError>;
    fn vault_status(env: Env) -> Result<VaultConfig, VaultError>;
    fn recipient_status(env: Env, recipient: Address) -> Result<Recipient, VaultError>;
    fn available(env: Env, recipient: Address) -> Result<i128, VaultError>;
}

// --------------------------------------------------------------- fixture --

struct F {
    env: Env,
    token: Address,
    client: VaultClient<'static>,
    owner: Address,
}

impl F {
    fn new(duration_days: u64) -> Self {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();

        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token = sac.address();
        let owner = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&owner, &(100 * TOKENS));

        let vault_id = env.register(Vault, ());

        // Pre-approve so transfer_from in fund() can pull tokens.
        StellarAssetClient::new(&env, &token).approve(
            &owner,
            &vault_id,
            &(100 * TOKENS),
            &1_000_000u32,
        );

        let client = VaultClient::new(&env, &vault_id);
        let now = env.ledger().timestamp();
        client
            .mock_all_auths()
            .initialize(&owner, &token, &now, &(now + duration_days * DAY));

        F {
            env,
            token,
            client,
            owner,
        }
    }

    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn advance(&self, secs: u64) {
        self.env.ledger().with_mut(|l| l.timestamp += secs);
    }

    fn balance(&self, addr: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(addr)
    }

    fn vault_balance(&self) -> i128 {
        self.balance(&self.client.address)
    }

    fn fund(&self, amount: i128) {
        self.client.mock_all_auths().fund(&self.owner, &amount);
    }

    fn add(&self, r: &Address, w: u32) {
        self.client.mock_all_auths().add_recipient(r, &w);
    }

    fn remove(&self, r: &Address) {
        self.client.mock_all_auths().remove_recipient(r);
    }

    fn withdraw_for(&self, r: &Address) -> i128 {
        self.client.mock_all_auths().withdraw(r)
    }

    fn available(&self, r: &Address) -> i128 {
        self.client.mock_all_auths().available(r)
    }
}

// ============================================================= pure math ===

#[test]
fn owed_at_zero_elapsed_is_zero() {
    assert_eq!(math::owed_at(1_000, 100, 0).unwrap(), 0);
}

#[test]
fn owed_at_linear_at_half_duration() {
    assert_eq!(math::owed_at(1_000, 100, 50).unwrap(), 500);
}

#[test]
fn owed_at_capped_at_deposit() {
    assert_eq!(math::owed_at(1_000, 100, 200).unwrap(), 1_000);
}

#[test]
fn owed_at_floors_fractional_accrual() {
    // 1 second of 3 on a 100-unit deposit: floor(100/3) = 33
    assert_eq!(math::owed_at(100, 3, 1).unwrap(), 33);
}

#[test]
fn owed_at_overflow_is_error() {
    assert!(math::owed_at(i128::MAX, 1, u64::MAX).is_err());
}

// ========================================= initialization & funding ========

#[test]
fn initialize_sets_config() {
    let f = F::new(30);
    let cfg = f.client.mock_all_auths().vault_status();
    assert_eq!(cfg.pool_balance, 0);
    assert_eq!(cfg.total_weight, 0);
    assert_eq!(cfg.recipient_count, 0);
}

#[test]
fn fund_increases_pool_balance() {
    let f = F::new(30);
    f.fund(TOKENS);
    let cfg = f.client.mock_all_auths().vault_status();
    assert_eq!(cfg.pool_balance, TOKENS);
    assert_eq!(f.vault_balance(), TOKENS);
}

#[test]
fn fund_rejects_zero_amount() {
    let f = F::new(30);
    let err = f
        .client
        .mock_all_auths()
        .try_fund(&f.owner, &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::ZeroValue);
}

#[test]
fn fund_transfer_failure_returns_typed_error() {
    let f = F::new(30);
    let broke_funder = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_fund(&broke_funder, &TOKENS)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::FundTransferFailed);
}

#[test]
fn double_initialize_reverts() {
    let f = F::new(30);
    let now = f.now();
    let err = f
        .client
        .mock_all_auths()
        .try_initialize(&f.owner, &f.token, &now, &(now + 10 * DAY))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::AlreadyInitialized);
}

// ============================================= single recipient accrual ====

#[test]
fn single_recipient_accrues_full_deposit_over_duration() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r = Address::generate(&f.env);
    f.add(&r, 1);

    // After half the duration, half should be available.
    f.advance(5 * DAY);
    let avail = f.available(&r);
    assert_eq!(avail, TOKENS / 2);

    // Withdraw half.
    let paid = f.withdraw_for(&r);
    assert_eq!(paid, TOKENS / 2);
    assert_eq!(f.balance(&r), TOKENS / 2);

    // After the full duration, the remaining half is available.
    f.advance(5 * DAY);
    assert_eq!(f.available(&r), TOKENS / 2);
    f.withdraw_for(&r);
    assert_eq!(f.balance(&r), TOKENS);
}

#[test]
fn nothing_available_before_any_time_passes() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r = Address::generate(&f.env);
    f.add(&r, 1);
    // add_recipient rebalances at the current timestamp; no time has passed.
    assert_eq!(f.available(&r), 0);
}

#[test]
fn withdraw_nothing_reverts() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r = Address::generate(&f.env);
    f.add(&r, 1);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&r)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::NothingToWithdraw);
}

// =============================================== two-recipient splitting ===

#[test]
fn two_equal_weight_recipients_split_evenly() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    f.add(&r1, 1);
    f.add(&r2, 1);

    f.advance(10 * DAY);
    let a1 = f.available(&r1);
    let a2 = f.available(&r2);

    // Equal weights → approximately equal shares; combined ≤ TOKENS.
    assert!(
        a1 + a2 <= TOKENS,
        "combined accrual exceeds deposit: {} + {} > {}",
        a1,
        a2,
        TOKENS
    );
    assert!(
        (a1 - a2).abs() <= 2,
        "shares differ beyond rounding: {} vs {}",
        a1,
        a2
    );
}

#[test]
fn two_unequal_weights_split_proportionally() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    f.add(&r1, 1); // weight 1: gets 1/4 of pool
    f.add(&r2, 3); // weight 3: gets 3/4 of pool

    f.advance(10 * DAY);
    let a1 = f.available(&r1);
    let a2 = f.available(&r2);

    assert!(
        (a1 - TOKENS / 4).abs() <= 2,
        "r1: {} expected ~{}",
        a1,
        TOKENS / 4
    );
    assert!(
        (a2 - TOKENS * 3 / 4).abs() <= 2,
        "r2: {} expected ~{}",
        a2,
        TOKENS * 3 / 4
    );
    assert!(a1 + a2 <= TOKENS);
}

// ================================================ join during active stream

#[test]
fn late_joiner_does_not_steal_from_earlier_recipient() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    f.add(&r1, 1);

    // Half the vault duration passes — r1 earns half the pool.
    f.advance(5 * DAY);

    // r2 joins.  Rebalance settles r1's accrual (locks TOKENS/2), then
    // splits the remaining TOKENS/2 equally over the second 5 days.
    f.add(&r2, 1);

    f.advance(5 * DAY);
    let a1 = f.available(&r1);
    let a2 = f.available(&r2);

    assert!(
        a1 + a2 <= TOKENS,
        "over-commitment: {} + {} > {}",
        a1,
        a2,
        TOKENS
    );
    assert!(a1 > a2, "early recipient should earn more than late joiner");

    let w1 = f.withdraw_for(&r1);
    let w2 = f.withdraw_for(&r2);
    assert_eq!(f.vault_balance(), TOKENS - w1 - w2);
}

// =========================================== leave during active stream ====

#[test]
fn remove_recipient_pays_out_accrued_amount() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    f.add(&r1, 1);
    f.add(&r2, 1);

    f.advance(5 * DAY); // half duration, equal split

    // r1 is removed; receives ~TOKENS/4 (half of their half-pool share).
    f.remove(&r1);
    let r1_balance = f.balance(&r1);
    assert!(
        (r1_balance - TOKENS / 4).abs() <= 2,
        "r1 paid {} expected ~{}",
        r1_balance,
        TOKENS / 4
    );

    // r2 continues streaming over the second half.
    f.advance(5 * DAY);
    assert!(f.available(&r2) > 0);
    f.withdraw_for(&r2);

    // Conservation: all tokens accounted for.
    let total_out = r1_balance + f.balance(&r2);
    let vault_remaining = f.vault_balance();
    assert_eq!(
        total_out + vault_remaining,
        TOKENS,
        "tokens not conserved: out={} vault={}",
        total_out,
        vault_remaining
    );
}

// ===================================================== solvency invariant ==

#[test]
fn vault_never_over_commits() {
    // Multiple joins, withdrawals, and a removal; sum of payouts ≤ funded amount.
    let f = F::new(20);
    f.fund(TOKENS);
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    let r3 = Address::generate(&f.env);

    f.add(&r1, 2);
    f.advance(2 * DAY);
    f.add(&r2, 3);
    f.advance(3 * DAY);
    f.add(&r3, 1);
    f.advance(2 * DAY);
    f.withdraw_for(&r1);
    f.advance(3 * DAY);
    f.remove(&r2);
    f.advance(5 * DAY);

    f.withdraw_for(&r1);
    f.withdraw_for(&r3);

    let total_paid = f.balance(&r1) + f.balance(&r2) + f.balance(&r3);
    assert!(
        total_paid <= TOKENS,
        "over-paid: {} > {}",
        total_paid,
        TOKENS
    );

    let remainder = f.vault_balance();
    assert_eq!(
        total_paid + remainder,
        TOKENS,
        "tokens not conserved: paid={} vault={}",
        total_paid,
        remainder
    );
}

// ==================================== fair-degradation (underfunded pool) ==

#[test]
fn underfunded_pool_applies_pro_rata_haircut() {
    let f = F::new(10);
    f.fund(TOKENS / 2); // only half funded
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    f.add(&r1, 1);
    f.add(&r2, 1);

    f.advance(10 * DAY);
    let a1 = f.available(&r1);
    let a2 = f.available(&r2);

    // Each gets ~TOKENS/4 (half pool, equal weights).
    assert!((a1 - TOKENS / 4).abs() <= 2, "r1 got {}", a1);
    assert!((a2 - TOKENS / 4).abs() <= 2, "r2 got {}", a2);
    assert!(a1 + a2 <= TOKENS / 2, "combined exceeds funded amount");
}

#[test]
fn fund_then_rebalance_increases_accrual() {
    // Start empty, add a recipient, then fund + trigger a rebalance via a
    // second recipient joining.  r1 earns nothing in the unfunded window
    // and earns pro-rata from the rebalance point onwards.
    let f = F::new(10);
    let r1 = Address::generate(&f.env);
    f.add(&r1, 1);

    f.advance(5 * DAY);
    assert_eq!(f.available(&r1), 0); // zero deposit → zero accrual

    f.fund(TOKENS);
    let r2 = Address::generate(&f.env);
    f.add(&r2, 1); // triggers rebalance; r1 and r2 share remaining 5 days

    f.advance(5 * DAY);
    let a1 = f.available(&r1);
    assert!(a1 > 0, "r1 should accrue after fund + rebalance");
    // Equal weights over the remaining window: each gets ~TOKENS/2.
    assert!(a1 <= TOKENS / 2 + 2);
}

// ===================================================== duplicate recipient =

#[test]
fn add_duplicate_recipient_reverts() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r = Address::generate(&f.env);
    f.add(&r, 1);
    let err = f
        .client
        .mock_all_auths()
        .try_add_recipient(&r, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::RecipientAlreadyExists);
}

#[test]
fn add_zero_weight_reverts() {
    let f = F::new(10);
    f.fund(TOKENS);
    let r = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_add_recipient(&r, &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::ZeroValue);
}

#[test]
fn remove_unknown_recipient_reverts() {
    let f = F::new(10);
    let r = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_remove_recipient(&r)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::RecipientNotFound);
}

// ======================================================= vault closed ======

#[test]
fn add_recipient_after_horizon_reverts() {
    let f = F::new(1); // 1-day vault
    f.fund(TOKENS);
    let r = Address::generate(&f.env);
    f.advance(2 * DAY); // past horizon
    let err = f
        .client
        .mock_all_auths()
        .try_add_recipient(&r, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, VaultError::VaultClosed);
}

// ====================================================== token conservation ==

#[test]
fn full_lifecycle_conserves_tokens() {
    // Three recipients, several join/leave events, all withdraw at the end.
    let f = F::new(30);
    f.fund(3 * TOKENS);
    let r1 = Address::generate(&f.env);
    let r2 = Address::generate(&f.env);
    let r3 = Address::generate(&f.env);

    f.add(&r1, 3);
    f.advance(5 * DAY);
    f.add(&r2, 2);
    f.advance(10 * DAY);
    f.withdraw_for(&r1);
    f.advance(5 * DAY);
    f.add(&r3, 1);
    f.advance(10 * DAY);

    f.withdraw_for(&r1);
    f.withdraw_for(&r2);
    f.withdraw_for(&r3);

    let total_out = f.balance(&r1) + f.balance(&r2) + f.balance(&r3);
    let vault_rem = f.vault_balance();
    assert_eq!(
        total_out + vault_rem,
        3 * TOKENS,
        "tokens not conserved: out={} vault={}",
        total_out,
        vault_rem
    );
    assert!(total_out <= 3 * TOKENS);
}
