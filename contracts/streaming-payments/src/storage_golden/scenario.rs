//! The one canonical scenario, shared by the fixture generator and the
//! upgrade-replay harness.
//!
//! Every call site is an explicit contract invocation and every ledger
//! time is an absolute constant, so the persisted footprint (stream ids
//! 1..=6, intent ids 1..=4, one instance, one of each policy record) is
//! fully deterministic. The only environment-dependent bytes are the
//! generated addresses, which appear inside blobs but never in filenames,
//! manifest kinds, or assertions.
//!
//! The footprint pins, in one deploy:
//! * `Stream` in all three statuses (Active, Cancelled, Depleted), with
//!   and without a protocol fee, and with a top-up bumping `deposit`.
//! * Both stream index kinds (two recipients, one sender) and the sender's
//!   intent index.
//! * `ScheduledIntent` in all four statuses.
//! * Treasury: charged and partially drained, `StreamFee` records present
//!   and absent (zero-fee streams).
//! * Governance: governor + pending nominee, policy admin after a
//!   completed handoff (with a cancelled handoff along the way), a removed
//!   asset, a live queued change, per-token and global stream policies, a
//!   frozen-then-unfrozen contract, a completed v1→v2 migration, and a
//!   pending upgrade proposal.
//! * One captured instance of every `#[contractevent]` the contract emits.
//!
//! The timeline is monotonic and every step respects the contract's own
//! validation rules (start times never in the past, `execute_after`/
//! `expires_at` windows, recipient-vs-sender cancellation, the migration
//! freeze requirement, upgrade timelocks), so a rule change that would make
//! this footprint unwritable fails the scenario instead of silently
//! reshaping the corpus.

use std::cell::RefCell;
use std::collections::BTreeMap;

use std::fs;
use std::string::String;
use std::vec::Vec;

use soroban_sdk::xdr;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    vec, Address, Bytes, BytesN, Env,
};

use crate::stream::MIN_UPGRADE_DELAY_SECONDS;
use crate::test_client::StreamingPaymentsClient as Client;
use crate::{StreamInput, StreamPolicy, StreamingPayments};

use super::{baseline_wasm_path, events_from};

/// Base absolute ledger time for the whole scenario.
const T0: u64 = 1_700_000_000;
const DAY: u64 = 86_400;
/// 1000 tokens at 7 decimals — the fixture deposit size for token 1.
const DEPOSIT: i128 = 10_000_000_000;
/// Per-intent deposit and keeper fee (token 2).
const INTENT_DEPOSIT: i128 = DEPOSIT / 10;
const INTENT_FEE: i128 = INTENT_DEPOSIT / 50;
/// The batch-created stream's deposit.
const BATCH_DEPOSIT: i128 = 100_000_000;
/// Allowance/mint size: the scenario never spends more than a third of it.
const MINT: i128 = 100 * DEPOSIT;

/// What the scenario created, by id. The replay harness asserts these
/// survive a wasm upgrade unchanged.
pub(crate) struct ScenarioOut {
    pub(crate) env: Env,
    pub(crate) contract: Address,
    pub(crate) token1: Address,
    pub(crate) token2: Address,
    pub(crate) sender: Address,
    pub(crate) recipient: Address,
    pub(crate) other_recipient: Address,
    pub(crate) governor: Address,
    /// Pending governor nominee left in storage at the final snapshot.
    pub(crate) governor2: Address,
    /// Policy admin after the completed handoff.
    pub(crate) new_admin: Address,
    /// Streams: 1 Active+topped-up (zero fee), 2 Cancelled by the sender
    /// (zero fee), 3 Depleted (fee-charged), 4 and 5 created by executed
    /// intents, 6 created by the batch entrypoint (fee-charged).
    pub(crate) s1: u64,
    pub(crate) s2: u64,
    pub(crate) s3: u64,
    pub(crate) s4: u64,
    pub(crate) s5: u64,
    pub(crate) s6: u64,
    /// Intents: 1 Executed, 2 Pending (recurring, one of two done),
    /// 3 Cancelled, 4 Expired.
    pub(crate) i1: u64,
    pub(crate) i2: u64,
    pub(crate) i3: u64,
    pub(crate) i4: u64,
    /// Events captured per invocation, keyed by the snake-case event name
    /// (first topic). First occurrence of each name only.
    pub(crate) events: BTreeMap<String, xdr::ContractEvent>,
    /// Ledger snapshot taken with `ContractFrozen=true` right after the
    /// completed migration — pins the frozen-state instance layout.
    pub(crate) snapshot_a: soroban_ledger_snapshot::LedgerSnapshot,
    /// Final snapshot: unfrozen plus a pending governor nominee and a live
    /// upgrade proposal.
    pub(crate) snapshot_b: soroban_ledger_snapshot::LedgerSnapshot,
}

/// Deploy the contract under test. `baseline_wasm` = Some deploys the
/// committed release-line bytecode through the deterministic testutils
/// deployer (the replay path); `None` uses the native `env.register`
/// constructor path (the generator path). Both bind the same constructor
/// argument (governor) and produce the same callable surface, and both
/// return the deployer's uploaded wasm hash when one was uploaded.
fn deploy(env: &Env, governor: &Address, baseline_wasm: Option<&Vec<u8>>) -> (Address, BytesN<32>) {
    match baseline_wasm {
        None => (
            env.register(StreamingPayments, (governor.clone(),)),
            upload_upgrade_target(env),
        ),
        Some(bytes) => {
            let hash = env
                .deployer()
                .upload_contract_wasm(Bytes::from_slice(env, bytes));
            let deployer = Address::generate(env);
            let salt = BytesN::from_array(env, &[0u8; 32]);
            let contract = env.deployer().with_address(deployer, salt).deploy_contract(
                soroban_sdk::ContractExecutable::Wasm(hash.clone()),
                (governor.clone(),),
            );
            (contract, hash)
        }
    }
}

/// A wasm hash the host accepts as an upgrade target (`execute_upgrade`
/// verifies the code exists on-ledger). On the generator path this is only
/// ever used as the value of the golden `ContractUpgraded` payload, so the
/// committed baseline artifact is the natural, deterministic choice.
fn upload_upgrade_target(env: &Env) -> BytesN<32> {
    let path = baseline_wasm_path();
    let bytes = fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "the fixture generator needs {} as a valid upgrade target: {e}",
            path.display()
        )
    });
    env.deployer()
        .upload_contract_wasm(Bytes::from_slice(env, &bytes))
}

fn set_time(env: &Env, t: u64) {
    env.ledger().with_mut(|li| {
        li.timestamp = t;
    });
}

fn mint_and_approve(env: &Env, token: &Address, contract: &Address, sender: &Address) {
    let sac = StellarAssetClient::new(env, token);
    sac.mint(sender, &MINT);
    sac.approve(sender, contract, &MINT, &1_000_000u32);
}

/// Runs the full scenario. `baseline_wasm`: see [`deploy`].
///
/// The final `execute_upgrade` runs only on the generator path: the replay
/// harness needs the scenario to hand it a live `PendingUpgrade` proposal
/// and an instance still running the baseline bytecode.
pub(crate) fn run(baseline_wasm: Option<Vec<u8>>) -> ScenarioOut {
    let replay = baseline_wasm.is_some();
    let env = Env::default();
    env.mock_all_auths();
    set_time(&env, T0);

    let sac1 = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token1 = sac1.address().clone();
    let sac2 = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token2 = sac2.address().clone();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let governor = Address::generate(&env);
    let (contract, upgrade_target) = deploy(&env, &governor, baseline_wasm.as_ref());
    let client = Client::new(&env, &contract);

    mint_and_approve(&env, &token1, &contract, &sender);
    mint_and_approve(&env, &token2, &contract, &sender);

    let other_recipient = Address::generate(&env);
    let keeper = Address::generate(&env);
    let policy_admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let events: RefCell<BTreeMap<String, xdr::ContractEvent>> = RefCell::new(BTreeMap::new());
    macro_rules! capture {
        () => {{
            let all = env.events().all();
            let mut map = events.borrow_mut();
            for e in events_from(&env, &all, &contract) {
                let name = event_name(&e);
                map.entry(name).or_insert(e);
            }
        }};
    }
    macro_rules! step {
        ($body:expr) => {{
            $body;
            capture!();
        }};
    }
    macro_rules! stepv {
        ($body:expr) => {{
            let out = $body;
            capture!();
            out
        }};
    }

    // -- T0: two zero-fee streams (fees are off until the governor turns
    //    them on), then the fee layer, then a fee-charged stream.
    let s1 = stepv!(client.create_stream(
        &sender,
        &recipient,
        &token1,
        &DEPOSIT,
        &T0,
        &(T0 + 31 * DAY),
        &true,
    ));
    let s2 = stepv!(client.create_stream(
        &sender,
        &recipient,
        &token1,
        &(DEPOSIT / 2),
        &(T0 + DAY),
        &(T0 + 33 * DAY),
        &false,
    ));
    step!(client.set_fee_bps(&governor, &100));
    let s3 = stepv!(client.create_stream(
        &sender,
        &recipient,
        &token1,
        &(DEPOSIT / 2),
        &(T0 + DAY),
        &(T0 + 6 * DAY),
        &true,
    ));

    // -- T0: four scheduled intents on token 2, covering one-shot,
    //    recurring, to-cancel and to-expire.
    let i1 = stepv!(client.schedule_stream(
        &sender,
        &recipient,
        &token2,
        &INTENT_DEPOSIT,
        &(T0 + DAY),
        &(T0 + 11 * DAY),
        &true,
        &0u64,
        &1u32,
        &INTENT_FEE,
        &(T0 + DAY),
        &(T0 + 30 * DAY),
    ));
    let i2 = stepv!(client.schedule_stream(
        &sender,
        &recipient,
        &token2,
        &INTENT_DEPOSIT,
        &(T0 + 2 * DAY),
        &(T0 + 12 * DAY),
        &true,
        &DAY,
        &2u32,
        &INTENT_FEE,
        &(T0 + 2 * DAY),
        &(T0 + 60 * DAY),
    ));
    let i3 = stepv!(client.schedule_stream(
        &sender,
        &recipient,
        &token2,
        &INTENT_DEPOSIT,
        &(T0 + 5 * DAY),
        &(T0 + 15 * DAY),
        &true,
        &0u64,
        &1u32,
        &INTENT_FEE,
        &(T0 + 5 * DAY),
        &(T0 + 40 * DAY),
    ));
    let i4 = stepv!(client.schedule_stream(
        &sender,
        &recipient,
        &token2,
        &INTENT_DEPOSIT,
        &(T0 + DAY),
        &(T0 + 2 * DAY),
        &true,
        &0u64,
        &1u32,
        &INTENT_FEE,
        &(T0 + DAY),
        &(T0 + 2 * DAY),
    ));

    // -- T0+DAY: cancel the intent whose execution window has not opened.
    set_time(&env, T0 + DAY);
    step!(client.cancel_scheduled(&sender, &i3));

    // -- T0+2DAY: the fourth intent's window closes unexecuted; anyone may
    //    reclaim its escrow.
    set_time(&env, T0 + 2 * DAY);
    step!(client.reclaim_expired(&i4));

    // -- T0+3DAY: execute both live intents (i2 keeps one occurrence
    //    pending), take a partial withdrawal, and let the sender cancel the
    //    stream its recipient may not.
    set_time(&env, T0 + 3 * DAY);
    let s4 = stepv!(client.execute_scheduled(&i1, &keeper));
    let s5 = stepv!(client.execute_scheduled(&i2, &keeper));
    let partial = client.available(&s1) / 3;
    step!(client.withdraw(&s1, &partial));
    step!(client.cancel_stream(&sender, &s2));

    // -- T0+7DAY: stream 3 has passed its end time, so `withdraw_max`
    //    drains it to Depleted; the batch entrypoint adds a fee-charged
    //    stream for a second recipient. Only then is the policy module
    //    switched on.
    set_time(&env, T0 + 7 * DAY);
    step!(client.withdraw_max(&s3));
    let batch_ids = stepv!(client.create_streams(
        &sender,
        &vec![
            &env,
            StreamInput {
                recipient: other_recipient.clone(),
                token: token1.clone(),
                deposit_amount: BATCH_DEPOSIT,
                start_time: T0 + 7 * DAY,
                end_time: T0 + 67 * DAY,
                cancelable: true,
            },
        ]
    ));
    let s6 = batch_ids.get(0).unwrap();

    step!(client.policy_init(&policy_admin));
    step!(client.policy_set_timelock_delay(&(10 * DAY)));
    // token 1 is removed once the timelock matures; token 2 stays queued
    // forever so a live `QueuedAssetChange` is part of the footprint.
    step!(client.policy_propose_asset(&token1, &false));
    step!(client.policy_propose_asset(&token2, &false));

    // -- T0+11DAY: a top-up grows an accrued stream's deposit, and the
    //    policy handoff is proposed, cancelled, re-proposed and accepted.
    set_time(&env, T0 + 11 * DAY);
    step!(client.top_up(&s1, &(DEPOSIT / 5)));
    step!(client.policy_propose_handoff(&new_admin));
    step!(client.policy_cancel_handoff());
    step!(client.policy_propose_handoff(&new_admin));
    step!(client.policy_accept_handoff());

    // -- T0+18DAY: the timelock has matured, so the removal executes; the
    //    governor publishes stream-policy floors and drains half of the
    //    treasury; the upgrade proposal is proposed, cancelled and proposed
    //    again (leaving one live).
    set_time(&env, T0 + 18 * DAY);
    step!(client.policy_execute_asset(&token1));
    let token_policy = StreamPolicy {
        min_rate: 100,
        max_rate: 1_000_000,
        min_duration: DAY,
        max_duration: 365 * DAY,
        min_deposit: 1_000,
    };
    step!(client.set_stream_policy(&governor, &Some(token2.clone()), &token_policy));
    let global_policy = StreamPolicy {
        min_rate: 1,
        max_rate: 0,
        min_duration: 1,
        max_duration: 0,
        min_deposit: 1,
    };
    step!(client.set_stream_policy(&governor, &None, &global_policy));
    let collectible = client.treasury_status(&token1).collectible;
    step!(client.withdraw_treasury(&governor, &token1, &recipient, &(collectible / 2),));
    step!(client.propose_upgrade(&governor, &upgrade_target, &MIN_UPGRADE_DELAY_SECONDS));
    step!(client.cancel_upgrade(&governor));
    step!(client.propose_upgrade(&governor, &upgrade_target, &MIN_UPGRADE_DELAY_SECONDS));

    // -- T0+19DAY: freeze, migrate v1→v2 to completion, snapshot the
    //    frozen instance, then unfreeze and leave a governor nominee and a
    //    live upgrade proposal for the final snapshot.
    set_time(&env, T0 + 19 * DAY);
    step!(client.set_frozen(&governor, &true));
    step!(client.migrate_storage(&governor, &0u64, &50u32));

    let snapshot_a = env.to_ledger_snapshot();

    step!(client.set_frozen(&governor, &false));
    step!(client.nominate_governor(&governor, &governor2));
    let snapshot_b = env.to_ledger_snapshot();

    if !replay {
        // Pause/resume (#24) postdates the baseline build, so it runs on the
        // generator path only. Both legs land at the same timestamp, after
        // both snapshots: resume shifts the window by zero, so no persisted
        // record changes and the pause key is already removed again — the
        // step only contributes the two golden events.
        step!(client.pause_stream(&sender, &s1));
        step!(client.resume_stream(&sender, &s1));
        // The proposal's timelock has already matured at this timestamp.
        step!(client.execute_upgrade(&governor));
    }

    ScenarioOut {
        env,
        contract,
        token1,
        token2,
        sender,
        recipient,
        other_recipient,
        governor,
        governor2,
        new_admin,
        s1,
        s2,
        s3,
        s4,
        s5,
        s6,
        i1,
        i2,
        i3,
        i4,
        events: events.into_inner(),
        snapshot_a,
        snapshot_b,
    }
}

/// The event name is the first topic: `Symbol(snake_case(struct_name))`,
/// per the `#[contractevent]` encoding (see docs/STORAGE_LAYOUT.md).
fn event_name(e: &xdr::ContractEvent) -> String {
    match &e.body {
        xdr::ContractEventBody::V0(b) => match &b.topics.as_slice()[0] {
            xdr::ScVal::Symbol(s) => s.to_utf8_string_lossy(),
            other => panic!("event topic 0 is not a symbol: {other:?}"),
        },
    }
}
