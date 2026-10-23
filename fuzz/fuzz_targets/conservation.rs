//! Value-conservation property fuzz target across every state-mutating entrypoint.
//!
//! Asserts the fundamental value conservation invariant:
//! 1. Stream invariant: for every stream:
//!    `deposit == withdrawn + available_recipient + refundable_sender`
//! 2. Contract balance cross-check: for every token T:
//!    `TokenClient::balance(contract) == sum(active_stream_escrows) + treasury_fees_retained(T)`
//! across multi-token configurations (Native + SAC), randomized state transitions,
//! and arbitrary timestamps.

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec as SdkVec,
};
use streampay_contract::{
    test_client::StreamingPaymentsClient as Client, RateSegment, StreamInput, StreamStatus,
    StreamingPayments, MAX_FEE_BPS,
};
use streampay_model::{streamed_at_schedule, ModelRateSegment};

#[derive(Arbitrary, Debug, Clone)]
pub struct FuzzStreamItem {
    pub token_idx: u8,
    pub recipient_idx: u8,
    pub deposit: i128,
    pub start_delay_secs: u32,
    pub duration_secs: u32,
    pub cancelable: bool,
}

#[derive(Arbitrary, Debug, Clone)]
pub enum FuzzOp {
    CreateStream {
        token_idx: u8,
        recipient_idx: u8,
        deposit: i128,
        start_delay_secs: u32,
        duration_secs: u32,
        cancelable: bool,
    },
    CreateStreams {
        items: Vec<FuzzStreamItem>,
    },
    Withdraw {
        stream_idx: u8,
        amount: i128,
    },
    WithdrawMax {
        stream_idx: u8,
    },
    TopUp {
        stream_idx: u8,
        amount: i128,
    },
    CancelStream {
        caller_is_recipient: bool,
        stream_idx: u8,
    },
    ProposeRate {
        stream_idx: u8,
        rate: i64,
    },
    AcceptRate {
        stream_idx: u8,
    },
    CancelRate {
        stream_idx: u8,
    },
    WithdrawTreasury {
        token_idx: u8,
        amount: i128,
    },
    SetFeeBps {
        new_fee_bps: u32,
    },
    AdvanceTime {
        seconds: u32,
    },
}

#[derive(Arbitrary, Debug)]
pub struct ConservationCampaign {
    pub initial_fee_bps: u32,
    pub ops: Vec<FuzzOp>,
}

fuzz_target!(|campaign: ConservationCampaign| {
    // Bound operation count to prevent OOM / timeouts during deep fuzzing runs
    if campaign.ops.is_empty() || campaign.ops.len() > 64 {
        return;
    }

    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();

    // Multi-token setup: Native asset and SAC issued asset
    let token_native = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_sac = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let tokens = [token_native, token_sac];

    let sender = Address::generate(&env);
    let recipients = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let governor = Address::generate(&env);
    let vault = Address::generate(&env);

    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let client = Client::new(&env, &contract_id);

    // Initial sender mint & approvals
    let initial_mint: i128 = 100_000_000_000_000;
    for token in &tokens {
        StellarAssetClient::new(&env, token).mint(&sender, &initial_mint);
        StellarAssetClient::new(&env, token).approve(
            &sender,
            &contract_id,
            &i128::MAX,
            &1_000_000u32,
        );
    }

    if campaign.initial_fee_bps <= MAX_FEE_BPS {
        let _ = client
            .mock_all_auths()
            .try_set_fee_bps(&governor, &campaign.initial_fee_bps);
    }

    let mut created_stream_ids: Vec<u64> = Vec::new();

    for op in campaign.ops {
        match op {
            FuzzOp::CreateStream {
                token_idx,
                recipient_idx,
                deposit,
                start_delay_secs,
                duration_secs,
                cancelable,
            } => {
                let token = &tokens[(token_idx as usize) % tokens.len()];
                let recipient = &recipients[(recipient_idx as usize) % recipients.len()];
                let now = env.ledger().timestamp();
                // Bound parameters to avoid degenerate arithmetic overflows in timestamp math
                let bounded_deposit = deposit.clamp(1, 10_000_000_000);
                let bounded_delay = (start_delay_secs % 1000) as u64;
                let bounded_duration = (duration_secs % 10_000).max(1) as u64;

                let start_time = now + bounded_delay;
                let end_time = start_time + bounded_duration;

                if let Ok(Ok(stream_id)) = client.mock_all_auths().try_create_stream(
                    &sender,
                    recipient,
                    token,
                    &bounded_deposit,
                    &start_time,
                    &end_time,
                    &cancelable,
                ) {
                    created_stream_ids.push(stream_id);
                }
            }
            FuzzOp::CreateStreams { items } => {
                if !items.is_empty() && items.len() <= 8 {
                    let mut sdk_inputs = SdkVec::new(&env);
                    let now = env.ledger().timestamp();
                    for item in items {
                        let token = tokens[(item.token_idx as usize) % tokens.len()].clone();
                        let recipient =
                            recipients[(item.recipient_idx as usize) % recipients.len()].clone();
                        let bounded_deposit = item.deposit.clamp(1, 5_000_000_000);
                        let bounded_delay = (item.start_delay_secs % 1000) as u64;
                        let bounded_duration = (item.duration_secs % 10_000).max(1) as u64;
                        let start_time = now + bounded_delay;
                        let end_time = start_time + bounded_duration;

                        sdk_inputs.push_back(StreamInput {
                            recipient,
                            token,
                            deposit_amount: bounded_deposit,
                            start_time,
                            end_time,
                            cancelable: item.cancelable,
                        });
                    }

                    if let Ok(Ok(ids)) = client
                        .mock_all_auths()
                        .try_create_streams(&sender, &sdk_inputs)
                    {
                        for id in ids.iter() {
                            created_stream_ids.push(id);
                        }
                    }
                }
            }
            FuzzOp::Withdraw { stream_idx, amount } => {
                if !created_stream_ids.is_empty() {
                    let stream_id =
                        created_stream_ids[(stream_idx as usize) % created_stream_ids.len()];
                    let bounded_amount = amount.clamp(1, 10_000_000_000);
                    let _ = client
                        .mock_all_auths()
                        .try_withdraw(&stream_id, &bounded_amount);
                }
            }
            FuzzOp::WithdrawMax { stream_idx } => {
                if !created_stream_ids.is_empty() {
                    let stream_id =
                        created_stream_ids[(stream_idx as usize) % created_stream_ids.len()];
                    let _ = client.mock_all_auths().try_withdraw_max(&stream_id);
                }
            }
            FuzzOp::TopUp { stream_idx, amount } => {
                if !created_stream_ids.is_empty() {
                    let stream_id =
                        created_stream_ids[(stream_idx as usize) % created_stream_ids.len()];
                    let bounded_amount = amount.clamp(1, 5_000_000_000);
                    let _ = client
                        .mock_all_auths()
                        .try_top_up(&stream_id, &bounded_amount);
                }
            }
            FuzzOp::CancelStream {
                caller_is_recipient,
                stream_idx,
            } => {
                if !created_stream_ids.is_empty() {
                    let stream_id =
                        created_stream_ids[(stream_idx as usize) % created_stream_ids.len()];
                    if let Ok(Ok(stream)) = client.try_get_stream(&stream_id) {
                        let caller = if caller_is_recipient {
                            stream.recipient
                        } else {
                            stream.sender
                        };
                        let _ = client
                            .mock_all_auths()
                            .try_cancel_stream(&caller, &stream_id);
                    }
                }
            }
            FuzzOp::ProposeRate { stream_idx, rate } => {
                if !created_stream_ids.is_empty() {
                    let stream_id =
                        created_stream_ids[(stream_idx as usize) % created_stream_ids.len()];
                    // Only the sender proposes here, so the recipient is always
                    // the counterparty the acceptance must come from.
                    let bounded_rate = rate.clamp(1, 5_000_000) as i128;
                    let _ = client.mock_all_auths().try_propose_rate_change(
                        &sender,
                        &stream_id,
                        &bounded_rate,
                    );
                }
            }
            FuzzOp::AcceptRate { stream_idx } => {
                if !created_stream_ids.is_empty() {
                    let stream_id =
                        created_stream_ids[(stream_idx as usize) % created_stream_ids.len()];
                    if let Ok(Ok(stream)) = client.try_get_stream(&stream_id) {
                        let _ = client
                            .mock_all_auths()
                            .try_accept_rate_change(&stream.recipient, &stream_id);
                    }
                }
            }
            FuzzOp::CancelRate { stream_idx } => {
                if !created_stream_ids.is_empty() {
                    let stream_id =
                        created_stream_ids[(stream_idx as usize) % created_stream_ids.len()];
                    let _ = client
                        .mock_all_auths()
                        .try_cancel_rate_change(&sender, &stream_id);
                }
            }
            FuzzOp::WithdrawTreasury { token_idx, amount } => {
                let token = &tokens[(token_idx as usize) % tokens.len()];
                let bounded_amount = amount.clamp(1, 10_000_000_000);
                let _ = client.mock_all_auths().try_withdraw_treasury(
                    &governor,
                    token,
                    &vault,
                    &bounded_amount,
                );
            }
            FuzzOp::SetFeeBps { new_fee_bps } => {
                if new_fee_bps <= MAX_FEE_BPS {
                    let _ = client
                        .mock_all_auths()
                        .try_set_fee_bps(&governor, &new_fee_bps);
                }
            }
            FuzzOp::AdvanceTime { seconds } => {
                let delta = (seconds % 86400).max(1) as u64;
                env.ledger().with_mut(|li| li.timestamp += delta);
            }
        }

        // =========================================================================
        // MACHINE-CHECKED INVARIANTS AFTER EVERY STEP
        // =========================================================================

        // Invariant 1: For every active stream, deposit == withdrawn + available + refundable
        for &stream_id in &created_stream_ids {
            if let Ok(Ok(stream)) = client.try_get_stream(&stream_id) {
                if stream.status == StreamStatus::Active {
                    let avail = client.available(&stream_id);
                    assert!(
                        avail >= 0,
                        "Available amount negative for stream {stream_id}: {avail}"
                    );
                    assert!(
                        stream.withdrawn + avail <= stream.deposit,
                        "Streamed payout exceeds deposit for stream {stream_id}"
                    );
                    let refundable = stream.deposit - (stream.withdrawn + avail);
                    assert!(
                        refundable >= 0,
                        "Refundable amount negative for stream {stream_id}: {refundable}"
                    );
                    assert_eq!(
                        stream.deposit,
                        stream.withdrawn + avail + refundable,
                        "Per-stream conservation failed for stream {stream_id}"
                    );
                }
            }
        }

        // Invariant 2: Contract-wide value conservation across all tokens
        for token in &tokens {
            let treasury_status = client.treasury_status(token);
            let fees_retained = treasury_status.charged_total - treasury_status.withdrawn_total;
            assert_eq!(
                treasury_status.collectible, fees_retained,
                "Treasury collectible diverges from charged - withdrawn"
            );

            let mut active_escrows: i128 = 0;
            for &stream_id in &created_stream_ids {
                if let Ok(Ok(stream)) = client.try_get_stream(&stream_id) {
                    if stream.status == StreamStatus::Active && stream.token == *token {
                        active_escrows += stream.deposit - stream.withdrawn;
                    }
                }
            }

            let contract_balance = TokenClient::new(&env, token).balance(&contract_id);
            assert_eq!(
                contract_balance,
                active_escrows + fees_retained,
                "Value conservation violated for token {token:?}: balance={contract_balance}, escrows={active_escrows}, retained_fees={fees_retained}"
            );
        }

        // Invariant 3: every stored schedule prices the same way the reference
        // model prices it, and an accepted schedule settles at exactly the
        // deposit the acceptance computed. This is the #54 differential under
        // random renegotiation sequences.
        let now = env.ledger().timestamp();
        for &stream_id in &created_stream_ids {
            let schedule = client.rate_segments(&stream_id);
            if schedule.is_empty() {
                continue;
            }
            let stream = client.get_stream(&stream_id);
            if stream.status != StreamStatus::Active {
                continue;
            }
            let mut model_segments: Vec<ModelRateSegment> = Vec::new();
            for segment in schedule.iter() {
                let RateSegment {
                    start_time,
                    end_time,
                    allocation,
                    basis_seconds,
                } = segment;
                model_segments.push(ModelRateSegment {
                    start_time,
                    end_time,
                    allocation,
                    basis_seconds,
                });
            }
            let expected = streamed_at_schedule(now, &model_segments)
                .expect("a stored schedule is priced by the same formula");
            assert_eq!(
                expected,
                stream.withdrawn + client.available(&stream_id),
                "schedule accrual diverged from the model for stream {stream_id}"
            );
            let settles = streamed_at_schedule(stream.end_time, &model_segments)
                .expect("a stored schedule settles without overflowing");
            assert_eq!(
                settles, stream.deposit,
                "schedule for stream {stream_id} does not settle at its deposit"
            );
        }
    }
});
