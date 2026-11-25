//! Stateful, multi-asset differential campaign: contract vs reference model.
//!
//! Each fuzz input decodes to a sequence of [`Op`]s. Every op is applied to the
//! Soroban contract *and* to `streampay_model::StreamPayModel`, and after every
//! op the full observable state of both is compared: every user's balance in
//! every asset, the contract's balance in every asset, every stream's fields,
//! `available`, its fee, and every asset's treasury. The first difference
//! panics with a `DIVERGENCE` message — that panic is the crash criterion.
//!
//! What this adds over the per-call `differential` target:
//!
//! - **State.** Sequences, not single calls, so bugs that need a history (a
//!   top-up after a partial withdraw after a fee change) are reachable.
//! - **Many concurrent streams.** Ops address streams round-robin through a
//!   cursor rather than by raw id, so long sequences spread over every live
//!   stream instead of piling onto stream 1.
//! - **Several assets.** Three Stellar Asset Contracts, each with its own
//!   treasury, so cross-asset accounting is exercised.
//! - **The wasm.** [`Backend::Wasm`] registers the release wasm artifact
//!   instead of the natively compiled contract, so the bytes that ship are the
//!   bytes under test (see the `campaign_wasm` target).

use arbitrary::{Arbitrary, Unstructured};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};
use streampay_contract::{
    test_client::StreamingPaymentsClient as Client, StreamError, StreamStatus, StreamingPayments,
};
use streampay_model::{ModelError, ModelStreamStatus, StreamPayModel};

/// Users who can send, receive, cancel and be nominated.
pub const USERS: usize = 4;
/// Distinct Stellar Asset Contracts in play.
pub const ASSETS: usize = 3;
/// Ops decoded from one input. Bounds the cost of a single execution.
pub const MAX_OPS: usize = 256;
/// Streams created per input. Every one is re-checked after every op, so this
/// bounds the per-step oracle cost too.
pub const MAX_STREAMS: u64 = 64;

const INITIAL_BALANCE: i128 = 10_000_000_000_000;

/// One step of a campaign sequence.
///
/// Streams are named by `pick`, resolved through a round-robin cursor (see
/// [`Campaign::resolve`]); `pick == u8::MAX` deliberately names a stream that
/// does not exist, so the not-found paths stay covered.
#[derive(Arbitrary, Clone, Debug)]
pub enum Op {
    Create {
        asset: u8,
        sender: u8,
        recipient: u8,
        deposit: Amount,
        start_delay_secs: u16,
        duration_secs: u32,
        cancelable: bool,
    },
    Withdraw { pick: u8, amount: Amount },
    WithdrawMax { pick: u8 },
    Cancel { pick: u8, caller: u8 },
    TopUp { pick: u8, caller: u8, amount: Amount },
    /// `WithdrawMax` on the next `count` streams in round-robin order: the
    /// many-streams-at-once traffic a payroll run produces.
    Sweep { count: u8 },
    SetFee { by_governor: bool, bps: u16 },
    Nominate { by_governor: bool, nominee: u8 },
    Accept { caller: u8 },
    WithdrawTreasury { by_governor: bool, asset: u8, recipient: u8, amount: Amount },
    Advance { secs: u32 },
}

/// An amount biased towards the interesting places.
///
/// Mostly realistic values, with the boundaries — zero, negatives, and values
/// that overflow fee and accrual math — reachable in one byte.
#[derive(Arbitrary, Clone, Copy, Debug)]
pub enum Amount {
    Small(u16),
    Typical(u32),
    Large(u64),
    Raw(i128),
    Zero,
    Negative(u16),
    Max,
}

impl Amount {
    pub fn value(self) -> i128 {
        match self {
            Amount::Small(v) => v as i128,
            Amount::Typical(v) => v as i128,
            Amount::Large(v) => v as i128,
            Amount::Raw(v) => v,
            Amount::Zero => 0,
            Amount::Negative(v) => -(v as i128) - 1,
            Amount::Max => i128::MAX,
        }
    }
}

/// Decode a fuzz input into at most [`MAX_OPS`] ops.
pub fn decode(data: &[u8]) -> Vec<Op> {
    let mut u = Unstructured::new(data);
    let mut ops = Vec::new();
    while ops.len() < MAX_OPS {
        match Op::arbitrary(&mut u) {
            Ok(op) => ops.push(op),
            Err(_) => break,
        }
        if u.is_empty() {
            break;
        }
    }
    ops
}

/// Which build of the contract to run.
pub enum Backend<'a> {
    /// The natively compiled contract: fast, and instrumented for coverage.
    Native,
    /// The release wasm, run in the Soroban VM: the bytes that ship.
    Wasm(&'a [u8]),
}

pub struct Campaign {
    env: Env,
    contract_id: Address,
    client: Client<'static>,
    assets: [Address; ASSETS],
    users: [Address; USERS],
    governor: Address,
    governor_name: String,
    model: StreamPayModel,
    cursor: u64,
}

const USER_NAMES: [&str; USERS] = ["user0", "user1", "user2", "user3"];
const ASSET_NAMES: [&str; ASSETS] = ["asset0", "asset1", "asset2"];

impl Campaign {
    pub fn new(backend: Backend<'_>) -> Self {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        // Fuzz inputs routinely exhaust the default budget long before they
        // reach anything interesting; the budget is not what is under test.
        env.cost_estimate().budget().reset_unlimited();

        let governor = Address::generate(&env);
        let contract_id = match backend {
            Backend::Native => env.register(StreamingPayments, (governor.clone(),)),
            Backend::Wasm(wasm) => env.register(wasm, (governor.clone(),)),
        };
        let client = Client::new(&env, &contract_id);

        let users: [Address; USERS] = core::array::from_fn(|_| Address::generate(&env));
        let assets: [Address; ASSETS] = core::array::from_fn(|_| {
            env.register_stellar_asset_contract_v2(Address::generate(&env))
                .address()
        });

        let mut model = StreamPayModel::new("governor".to_string(), env.ledger().timestamp());
        for asset in 0..ASSETS {
            let sac = StellarAssetClient::new(&env, &assets[asset]);
            for user in 0..USERS {
                sac.mint(&users[user], &INITIAL_BALANCE);
                sac.approve(&users[user], &contract_id, &INITIAL_BALANCE, &1_000_000u32);
                model.set_token_balance(USER_NAMES[user], ASSET_NAMES[asset], INITIAL_BALANCE);
            }
        }
        model.drain_events();

        Self {
            env,
            contract_id,
            client,
            assets,
            users,
            governor,
            governor_name: "governor".to_string(),
            model,
            cursor: 0,
        }
    }

    /// Run `ops`, checking both sides agree after every one. Panics on the
    /// first divergence.
    pub fn run(&mut self, ops: &[Op]) {
        for (step, op) in ops.iter().enumerate() {
            self.apply(step, op);
            self.check(step, op);
        }
    }

    /// The stream id `pick` names: the next stream in round-robin order from
    /// the cursor, which then advances — or, for `u8::MAX`, one that does not
    /// exist. Before any stream exists every pick names stream 1, which is
    /// itself a not-found case worth exercising.
    fn resolve(&mut self, pick: u8) -> u64 {
        let total = self.model.total_streams();
        if pick == u8::MAX || total == 0 {
            return total + 1;
        }
        let id = (self.cursor + pick as u64) % total + 1;
        self.cursor = self.cursor.wrapping_add(1);
        id
    }

    /// Known divergence KD-1 (see `docs/FUZZ_CAMPAIGN.md`): the reference model
    /// does not reject a pull larger than what the sender holds or has
    /// approved — its balance just goes negative — while the contract returns
    /// `DepositTransferFailed` / `TopUpTransferFailed`. Until the model is
    /// fixed, ops that would pull within 2% (the fee headroom) of either limit
    /// are skipped, so this one cause does not swallow every other crash.
    /// `STREAMPAY_FUZZ_STRICT=1` turns the suppression off.
    fn exceeds_funds(&self, user: usize, asset: usize, amount: i128) -> bool {
        if strict() || amount <= 0 {
            return false;
        }
        let held = self
            .model
            .token_balances
            .get(&(USER_NAMES[user].to_string(), ASSET_NAMES[asset].to_string()))
            .copied()
            .unwrap_or(0);
        let approved = TokenClient::new(&self.env, &self.assets[asset])
            .allowance(&self.users[user], &self.contract_id);
        let limit = held.min(approved);
        amount >= limit - limit / 50
    }

    fn governor_or_user0(&self, by_governor: bool) -> (Address, String) {
        if by_governor {
            (self.governor.clone(), self.governor_name.clone())
        } else {
            (self.users[0].clone(), USER_NAMES[0].to_string())
        }
    }

    fn apply(&mut self, step: usize, op: &Op) {
        match *op {
            Op::Create { asset, sender, recipient, deposit, start_delay_secs, duration_secs, cancelable } => {
                if self.model.total_streams() >= MAX_STREAMS {
                    return;
                }
                let (a, s, r) = (asset as usize % ASSETS, sender as usize % USERS, recipient as usize % USERS);
                if self.exceeds_funds(s, a, deposit.value()) {
                    return;
                }
                let now = self.env.ledger().timestamp();
                let start = now.saturating_add(start_delay_secs as u64);
                let end = start.saturating_add(duration_secs as u64);
                let c = self.client.try_create_stream(
                    &self.users[s], &self.users[r], &self.assets[a], &deposit.value(), &start, &end, &cancelable,
                );
                let m = self.model.create_stream(
                    USER_NAMES[s], USER_NAMES[r], ASSET_NAMES[a], deposit.value(), start, end, cancelable,
                );
                agree(step, "create_stream", map(c), m);
            }
            Op::Withdraw { pick, amount } => {
                let id = self.resolve(pick);
                let c = self.client.try_withdraw(&id, &amount.value());
                let m = self.model.withdraw(id, amount.value());
                agree(step, "withdraw", map(c), m);
            }
            Op::WithdrawMax { pick } => {
                let id = self.resolve(pick);
                self.withdraw_max(step, id);
            }
            Op::Sweep { count } => {
                for _ in 0..(count % 16) {
                    let id = self.resolve(0);
                    self.withdraw_max(step, id);
                }
            }
            Op::Cancel { pick, caller } => {
                let id = self.resolve(pick);
                let u = caller as usize % USERS;
                let c = self.client.try_cancel_stream(&self.users[u], &id);
                let m = self.model.cancel_stream(USER_NAMES[u], id);
                agree(step, "cancel_stream", map(c), m);
            }
            Op::TopUp { pick, caller: _, amount } => {
                let id = self.resolve(pick);
                // `top_up` takes no caller: the contract authorises the stream's
                // sender and pulls from them. Under `mock_all_auths` that always
                // passes, so the model is told the sender is calling. (Handing
                // it another user, as the #16 harness does, makes the model
                // reject what the contract cannot: an artifact of mocked auth,
                // not a divergence. Auth itself is outside what a mocked-auth
                // campaign can test — see docs/FUZZ_CAMPAIGN.md.)
                let sender = self.model.get_stream(id).ok().map(|s| (s.sender, s.token));
                if let Some((sender, token)) = &sender {
                    let u = USER_NAMES.iter().position(|n| n == sender).unwrap_or(0);
                    let a = ASSET_NAMES.iter().position(|n| n == token).unwrap_or(0);
                    if self.exceeds_funds(u, a, amount.value()) {
                        return;
                    }
                }
                let caller_name = sender.map(|(s, _)| s).unwrap_or_else(|| USER_NAMES[0].to_string());
                let c = self.client.try_top_up(&id, &amount.value());
                let m = self.model.top_up(&caller_name, id, amount.value());
                agree(step, "top_up", map(c), m);
            }
            Op::SetFee { by_governor, bps } => {
                let (caller, name) = self.governor_or_user0(by_governor);
                let bps = bps as u32 % 200;
                let c = self.client.try_set_fee_bps(&caller, &bps);
                let m = self.model.set_fee_bps(&name, bps);
                agree(step, "set_fee_bps", map(c), m);
            }
            Op::Nominate { by_governor, nominee } => {
                let (caller, name) = self.governor_or_user0(by_governor);
                let n = nominee as usize % USERS;
                let c = self.client.try_nominate_governor(&caller, &self.users[n]);
                let m = self.model.nominate_governor(&name, USER_NAMES[n]);
                agree(step, "nominate_governor", map(c), m);
            }
            Op::Accept { caller } => {
                let u = caller as usize % USERS;
                let c = map(self.client.try_accept_governor(&self.users[u]));
                let m = self.model.accept_governor(USER_NAMES[u]);
                agree(step, "accept_governor", c.clone(), m);
                if c.is_ok() {
                    self.governor = self.users[u].clone();
                    self.governor_name = USER_NAMES[u].to_string();
                }
            }
            Op::WithdrawTreasury { by_governor, asset, recipient, amount } => {
                let (caller, name) = self.governor_or_user0(by_governor);
                let (a, r) = (asset as usize % ASSETS, recipient as usize % USERS);
                let c = self.client.try_withdraw_treasury(&caller, &self.assets[a], &self.users[r], &amount.value());
                let m = self.model.withdraw_treasury(&name, ASSET_NAMES[a], USER_NAMES[r], amount.value());
                agree(step, "withdraw_treasury", map(c), m);
            }
            Op::Advance { secs } => {
                let now = self.env.ledger().timestamp().saturating_add(secs as u64);
                self.env.ledger().set_timestamp(now);
                self.model.advance_time(secs as u64);
            }
        }
    }

    fn withdraw_max(&mut self, step: usize, id: u64) {
        let c = self.client.try_withdraw_max(&id);
        let m = self.model.withdraw_max(id);
        agree(step, "withdraw_max", map(c), m);
    }

    /// Every observable the two sides share, compared.
    fn check(&mut self, step: usize, op: &Op) {
        for a in 0..ASSETS {
            let token = TokenClient::new(&self.env, &self.assets[a]);
            let name = ASSET_NAMES[a];

            let c_held = token.balance(&self.contract_id);
            let m_held = self.model.contract_balances.get(name).copied().unwrap_or(0);
            diverge_if(step, op, c_held != m_held, || format!("{name} contract balance: contract={c_held} model={m_held}"));

            for u in 0..USERS {
                let c_bal = token.balance(&self.users[u]);
                let m_bal = self
                    .model
                    .token_balances
                    .get(&(USER_NAMES[u].to_string(), name.to_string()))
                    .copied()
                    .unwrap_or(0);
                diverge_if(step, op, c_bal != m_bal, || {
                    format!("{} {name} balance: contract={c_bal} model={m_bal}", USER_NAMES[u])
                });
            }

            let c_t = self.client.treasury_status(&self.assets[a]);
            let m_t = self.model.treasury_status(name);
            diverge_if(
                step,
                op,
                (c_t.fee_bps, c_t.charged_total, c_t.withdrawn_total, c_t.collectible)
                    != (m_t.fee_bps, m_t.charged_total, m_t.withdrawn_total, m_t.collectible),
                || format!("{name} treasury: contract={c_t:?} model={m_t:?}"),
            );
        }

        let total = self.model.total_streams();
        let c_total = self.client.total_streams();
        diverge_if(step, op, c_total != total, || format!("total_streams: contract={c_total} model={total}"));

        for id in 1..=total {
            let c = self.client.get_stream(&id);
            let m = self.model.get_stream(id).expect("model stream exists");
            diverge_if(
                step,
                op,
                (c.deposit, c.withdrawn, c.start_time, c.end_time, c.cancelable, status(c.status))
                    != (m.deposit, m.withdrawn, m.start_time, m.end_time, m.cancelable, m.status),
                || format!("stream {id}: contract={c:?} model={m:?}"),
            );
            let (c_avail, m_avail) = (self.client.available(&id), self.model.available(id).expect("available"));
            diverge_if(step, op, c_avail != m_avail, || format!("stream {id} available: contract={c_avail} model={m_avail}"));
            let (c_fee, m_fee) = (self.client.stream_fee(&id), self.model.stream_fee(id).expect("stream_fee"));
            diverge_if(step, op, c_fee != m_fee, || format!("stream {id} fee: contract={c_fee} model={m_fee}"));
        }

        self.model.drain_events();
    }
}

fn strict() -> bool {
    std::env::var_os("STREAMPAY_FUZZ_STRICT").is_some()
}

fn status(s: StreamStatus) -> ModelStreamStatus {
    match s {
        StreamStatus::Active => ModelStreamStatus::Active,
        StreamStatus::Cancelled => ModelStreamStatus::Cancelled,
        StreamStatus::Depleted => ModelStreamStatus::Depleted,
    }
}

/// The contract's error, in the model's vocabulary.
///
/// Identical to the mapping in the #16 harness. A variant the model has no
/// name for is itself a divergence and panics.
pub fn model_error(err: StreamError) -> ModelError {
    match err {
        StreamError::StreamNotFound => ModelError::StreamNotFound,
        StreamError::NotStreamSender => ModelError::NotStreamSender,
        StreamError::NotStreamRecipient => ModelError::NotStreamRecipient,
        StreamError::StreamNotCancellable => ModelError::StreamNotCancellable,
        StreamError::StreamNotActive => ModelError::StreamNotActive,
        StreamError::StartTimeInPast => ModelError::StartTimeInPast,
        StreamError::InvalidTimeRange => ModelError::InvalidTimeRange,
        StreamError::DurationTooLong => ModelError::DurationTooLong,
        StreamError::ZeroAmount => ModelError::ZeroAmount,
        StreamError::AmountExceedsAvailable => ModelError::AmountExceedsAvailable,
        StreamError::MathOverflow => ModelError::MathOverflow,
        StreamError::NotAuthorized => ModelError::NotAuthorized,
        StreamError::NothingToWithdraw => ModelError::NothingToWithdraw,
        StreamError::FeeRateTooHigh => ModelError::FeeRateTooHigh,
        StreamError::NotGovernor => ModelError::NotGovernor,
        StreamError::NoPendingGovernor => ModelError::NoPendingGovernor,
        StreamError::InsufficientTreasuryBalance => ModelError::InsufficientTreasuryBalance,
        StreamError::DepositTransferFailed => ModelError::DepositTransferFailed,
        StreamError::TopUpTransferFailed => ModelError::TopUpTransferFailed,
        StreamError::RecipientPayoutFailed => ModelError::RecipientPayoutFailed,
        StreamError::SenderRefundFailed => ModelError::SenderRefundFailed,
        StreamError::TreasuryPayoutFailed => ModelError::TreasuryPayoutFailed,
        other => panic!("DIVERGENCE: contract returned {other:?}, which the model cannot express"),
    }
}

/// A contract `try_` result, in the model's terms. A host-level failure (an
/// invocation error rather than a `StreamError`) maps as the #16 harness maps
/// it, so the two oracles agree on what counts as a divergence.
fn map<T, C, I>(r: Result<Result<T, C>, Result<StreamError, I>>) -> Result<T, ModelError> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Err(Ok(e)) => Err(model_error(e)),
        _ => Err(ModelError::MathOverflow),
    }
}

fn agree<T: PartialEq + core::fmt::Debug>(step: usize, what: &str, c: Result<T, ModelError>, m: Result<T, ModelError>) {
    if c != m {
        panic!("DIVERGENCE at step {step}: {what}: contract={c:?} model={m:?}");
    }
}

fn diverge_if(step: usize, op: &Op, diverged: bool, detail: impl FnOnce() -> String) {
    if diverged {
        panic!("DIVERGENCE at step {step} after {op:?}: {}", detail());
    }
}

/// The op sequence an input decodes to, one per line — what triage attaches
/// to an issue so a reader can follow a crasher without running it.
pub fn trace(data: &[u8]) -> String {
    decode(data)
        .iter()
        .enumerate()
        .map(|(i, op)| format!("{i:>4}: {op:?}\n"))
        .collect()
}
