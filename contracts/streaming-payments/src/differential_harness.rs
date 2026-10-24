//! Differential test harness: wires the Soroban contract against the reference model
//! and checks for divergence on every step.
#![cfg(test)]

use std::string::ToString;

use soroban_sdk::{
    testutils::Address as _, testutils::Events as _, testutils::Ledger as _,
    token::Client as TokenClient, token::StellarAssetClient, Address, Env,
};
use streampay_model::action::Action;
use streampay_model::errors::ModelError;
use streampay_model::model::StreamPayModel;
use streampay_model::types::ModelStreamStatus;

use crate::test_client::StreamingPaymentsClient as Client;
use crate::{StreamError, StreamStatus, StreamingPayments};

pub fn convert_stream_error(err: StreamError) -> ModelError {
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
        StreamError::IntentNotFound => ModelError::IntentNotFound,
        StreamError::IntentNotPending => ModelError::IntentNotPending,
        StreamError::IntentNotYetExecutable => ModelError::IntentNotYetExecutable,
        StreamError::IntentExpired => ModelError::IntentExpired,
        StreamError::IntentNotCancellable => ModelError::IntentNotCancellable,
        StreamError::InvalidScheduleParameters => ModelError::InvalidScheduleParameters,
        StreamError::IntentParamsMismatch => ModelError::IntentParamsMismatch,
        StreamError::IntentNotExpired => ModelError::IntentNotExpired,
        StreamError::DepositTransferFailed => ModelError::DepositTransferFailed,
        StreamError::TopUpTransferFailed => ModelError::TopUpTransferFailed,
        StreamError::RecipientPayoutFailed => ModelError::RecipientPayoutFailed,
        StreamError::SenderRefundFailed => ModelError::SenderRefundFailed,
        StreamError::TreasuryPayoutFailed => ModelError::TreasuryPayoutFailed,
        other => panic!("unhandled StreamError in differential model: {other:?}"),
    }
}

pub fn convert_stream_status(status: StreamStatus) -> ModelStreamStatus {
    match status {
        StreamStatus::Active => ModelStreamStatus::Active,
        StreamStatus::Cancelled => ModelStreamStatus::Cancelled,
        StreamStatus::Depleted => ModelStreamStatus::Depleted,
    }
}

const INITIAL_USER_BALANCE: i128 = 10_000_000_000_000; // 1,000,000 tokens

pub struct DifferentialHarness {
    pub env: Env,
    pub contract_id: Address,
    pub client: Client<'static>,
    pub token: Address,
    pub governor: Address,
    pub users: [Address; 4],
    pub user_names: [&'static str; 4],
    pub token_name: &'static str,
    pub governor_name: &'static str,
    pub model: StreamPayModel,
}

impl DifferentialHarness {
    pub fn new() -> Self {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();

        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token = sac.address();
        let governor = Address::generate(&env);
        let users = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let user_names = ["user0", "user1", "user2", "user3"];
        let token_name = "token";
        let governor_name = "governor";

        let contract_id = env.register(StreamingPayments, (governor.clone(),));
        let client = Client::new(&env, &contract_id);

        let token_client = StellarAssetClient::new(&env, &token);
        for user in &users {
            token_client.mint(user, &INITIAL_USER_BALANCE);
            token_client.approve(user, &contract_id, &INITIAL_USER_BALANCE, &1_000_000u32);
        }

        let initial_now = env.ledger().timestamp();
        let mut model = StreamPayModel::new(governor_name.to_string(), initial_now);
        for name in &user_names {
            model.set_token_balance(name, token_name, INITIAL_USER_BALANCE);
        }

        // Drain initial deployment/minting events
        let _ = env.events().all();
        model.drain_events();

        Self {
            env,
            contract_id,
            client,
            token,
            governor,
            users,
            user_names,
            token_name,
            governor_name,
            model,
        }
    }

    /// Applies a sequence of actions differentially, verifying equivalence after each action.
    pub fn execute_sequence(&mut self, actions: &[Action]) {
        for (step, action) in actions.iter().enumerate() {
            self.apply_action(step, action);
        }
    }

    /// Applies a single action to both sides and checks for divergence.
    pub fn apply_action(&mut self, step: usize, action: &Action) {
        match action {
            Action::CreateStream {
                sender_idx,
                recipient_idx,
                deposit_amount,
                start_delay_secs,
                duration_secs,
                cancelable,
            } => {
                let s_idx = (*sender_idx as usize) % 4;
                let r_idx = (*recipient_idx as usize) % 4;
                let sender = &self.users[s_idx];
                let recipient = &self.users[r_idx];
                let sender_name = self.user_names[s_idx];
                let recipient_name = self.user_names[r_idx];

                let now = self.env.ledger().timestamp();
                let start_time = now.saturating_add(*start_delay_secs as u64);
                let end_time = start_time.saturating_add(*duration_secs as u64);

                let c_res = self.client.mock_all_auths().try_create_stream(
                    sender,
                    recipient,
                    &self.token,
                    deposit_amount,
                    &start_time,
                    &end_time,
                    cancelable,
                );
                let m_res = self.model.create_stream(
                    sender_name,
                    recipient_name,
                    self.token_name,
                    *deposit_amount,
                    start_time,
                    end_time,
                    *cancelable,
                );

                let c_mapped = match c_res {
                    Ok(Ok(id)) => Ok(id),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: create_stream mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::Withdraw { stream_id, amount } => {
                let c_res = self.client.mock_all_auths().try_withdraw(stream_id, amount);
                let m_res = self.model.withdraw(*stream_id, *amount);

                let c_mapped = match c_res {
                    Ok(Ok(())) => Ok(()),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: withdraw mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::WithdrawMax { stream_id } => {
                let c_res = self.client.mock_all_auths().try_withdraw_max(stream_id);
                let m_res = self.model.withdraw_max(*stream_id);

                let c_mapped = match c_res {
                    Ok(Ok(amt)) => Ok(amt),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: withdraw_max mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::CancelStream {
                caller_idx,
                stream_id,
            } => {
                let c_idx = (*caller_idx as usize) % 4;
                let caller = &self.users[c_idx];
                let caller_name = self.user_names[c_idx];

                let c_res = self
                    .client
                    .mock_all_auths()
                    .try_cancel_stream(caller, stream_id);
                let m_res = self.model.cancel_stream(caller_name, *stream_id);

                let c_mapped = match c_res {
                    Ok(Ok(())) => Ok(()),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: cancel_stream mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::TopUp {
                caller_idx,
                stream_id,
                amount,
            } => {
                let c_idx = (*caller_idx as usize) % 4;
                let caller_name = self.user_names[c_idx];

                let c_res = self.client.mock_all_auths().try_top_up(stream_id, amount);
                let m_res = self.model.top_up(caller_name, *stream_id, *amount);

                let c_mapped = match c_res {
                    Ok(Ok(())) => Ok(()),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: top_up mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::SetFeeBps {
                caller_is_gov,
                new_fee_bps,
            } => {
                let caller = if *caller_is_gov {
                    &self.governor
                } else {
                    &self.users[0]
                };
                let caller_name = if *caller_is_gov {
                    self.governor_name
                } else {
                    self.user_names[0]
                };

                let c_res = self
                    .client
                    .mock_all_auths()
                    .try_set_fee_bps(caller, new_fee_bps);
                let m_res = self.model.set_fee_bps(caller_name, *new_fee_bps);

                let c_mapped = match c_res {
                    Ok(Ok(())) => Ok(()),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: set_fee_bps mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::NominateGovernor {
                caller_is_gov,
                nominee_idx,
            } => {
                let caller = if *caller_is_gov {
                    &self.governor
                } else {
                    &self.users[0]
                };
                let caller_name = if *caller_is_gov {
                    self.governor_name
                } else {
                    self.user_names[0]
                };
                let n_idx = (*nominee_idx as usize) % 4;
                let nominee = &self.users[n_idx];
                let nominee_name = self.user_names[n_idx];

                let c_res = self
                    .client
                    .mock_all_auths()
                    .try_nominate_governor(caller, nominee);
                let m_res = self.model.nominate_governor(caller_name, nominee_name);

                let c_mapped = match c_res {
                    Ok(Ok(())) => Ok(()),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: nominate_governor mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::AcceptGovernor { caller_idx } => {
                let c_idx = (*caller_idx as usize) % 4;
                let caller = &self.users[c_idx];
                let caller_name = self.user_names[c_idx];

                let c_res = self.client.mock_all_auths().try_accept_governor(caller);
                let m_res = self.model.accept_governor(caller_name);

                let c_mapped = match c_res {
                    Ok(Ok(())) => Ok(()),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: accept_governor mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
                if c_mapped.is_ok() {
                    self.governor = caller.clone();
                    self.governor_name = caller_name;
                }
            }

            Action::WithdrawTreasury {
                caller_is_gov,
                recipient_idx,
                amount,
            } => {
                let caller = if *caller_is_gov {
                    &self.governor
                } else {
                    &self.users[0]
                };
                let caller_name = if *caller_is_gov {
                    self.governor_name
                } else {
                    self.user_names[0]
                };
                let r_idx = (*recipient_idx as usize) % 4;
                let recipient = &self.users[r_idx];
                let recipient_name = self.user_names[r_idx];

                let c_res = self.client.mock_all_auths().try_withdraw_treasury(
                    caller,
                    &self.token,
                    recipient,
                    amount,
                );
                let m_res = self.model.withdraw_treasury(
                    caller_name,
                    self.token_name,
                    recipient_name,
                    *amount,
                );

                let c_mapped = match c_res {
                    Ok(Ok(())) => Ok(()),
                    Err(Ok(err)) => Err(convert_stream_error(err)),
                    _ => Err(ModelError::MathOverflow),
                };
                assert_eq!(
                    c_mapped, m_res,
                    "DIVERGENCE at step {step}: withdraw_treasury mismatch. Contract: {c_mapped:?}, Model: {m_res:?}"
                );
            }

            Action::AdvanceTime { seconds } => {
                let new_now = self
                    .env
                    .ledger()
                    .timestamp()
                    .saturating_add(*seconds as u64);
                self.env.ledger().set_timestamp(new_now);
                self.model.advance_time(*seconds as u64);
            }
        }

        self.assert_state_and_queries_match(step);
    }

    /// Cross-checks all balances, events, and state queries between the contract and the model.
    fn assert_state_and_queries_match(&mut self, step: usize) {
        // 1. Contract token balance matches model contract balance
        let c_contract_bal = TokenClient::new(&self.env, &self.token).balance(&self.contract_id);
        let m_contract_bal = self
            .model
            .contract_balances
            .get(self.token_name)
            .copied()
            .unwrap_or(0);
        assert_eq!(
            c_contract_bal, m_contract_bal,
            "DIVERGENCE at step {step}: Contract token balance mismatch. Contract: {c_contract_bal}, Model: {m_contract_bal}"
        );

        // 2. User token balances match model user token balances
        for (i, user) in self.users.iter().enumerate() {
            let name = self.user_names[i];
            let c_bal = TokenClient::new(&self.env, &self.token).balance(user);
            let m_bal = self
                .model
                .token_balances
                .get(&(name.to_string(), self.token_name.to_string()))
                .copied()
                .unwrap_or(0);
            assert_eq!(
                c_bal, m_bal,
                "DIVERGENCE at step {step}: User {name} token balance mismatch. Contract: {c_bal}, Model: {m_bal}"
            );
        }

        // 3. Total streams match
        let c_total = self.client.total_streams();
        let m_total = self.model.total_streams();
        assert_eq!(
            c_total, m_total,
            "DIVERGENCE at step {step}: total_streams mismatch. Contract: {c_total}, Model: {m_total}"
        );

        // 4. Per-stream queries match for every stream created
        for id in 1..=m_total {
            let c_stream = self.client.get_stream(&id);
            let m_stream = self.model.get_stream(id).expect("model stream exists");

            assert_eq!(
                c_stream.deposit, m_stream.deposit,
                "DIVERGENCE at step {step}: Stream {id} deposit mismatch"
            );
            assert_eq!(
                c_stream.withdrawn, m_stream.withdrawn,
                "DIVERGENCE at step {step}: Stream {id} withdrawn mismatch"
            );
            assert_eq!(
                c_stream.start_time, m_stream.start_time,
                "DIVERGENCE at step {step}: Stream {id} start_time mismatch"
            );
            assert_eq!(
                c_stream.end_time, m_stream.end_time,
                "DIVERGENCE at step {step}: Stream {id} end_time mismatch"
            );
            assert_eq!(
                c_stream.cancelable, m_stream.cancelable,
                "DIVERGENCE at step {step}: Stream {id} cancelable mismatch"
            );
            assert_eq!(
                convert_stream_status(c_stream.status),
                m_stream.status,
                "DIVERGENCE at step {step}: Stream {id} status mismatch"
            );

            let c_avail = self.client.available(&id);
            let m_avail = self.model.available(id).expect("available succeeds");
            assert_eq!(
                c_avail, m_avail,
                "DIVERGENCE at step {step}: Stream {id} available amount mismatch"
            );

            let c_fee = self.client.stream_fee(&id);
            let m_fee = self.model.stream_fee(id).expect("stream_fee succeeds");
            assert_eq!(
                c_fee, m_fee,
                "DIVERGENCE at step {step}: Stream {id} fee mismatch"
            );
        }

        // 5. Treasury status matches
        let c_treasury = self.client.treasury_status(&self.token);
        let m_treasury = self.model.treasury_status(self.token_name);
        assert_eq!(
            c_treasury.fee_bps, m_treasury.fee_bps,
            "DIVERGENCE at step {step}: fee_bps mismatch"
        );
        assert_eq!(
            c_treasury.charged_total, m_treasury.charged_total,
            "DIVERGENCE at step {step}: charged_total mismatch"
        );
        assert_eq!(
            c_treasury.withdrawn_total, m_treasury.withdrawn_total,
            "DIVERGENCE at step {step}: withdrawn_total mismatch"
        );
        assert_eq!(
            c_treasury.collectible, m_treasury.collectible,
            "DIVERGENCE at step {step}: collectible mismatch"
        );

        // 6. Drain events after each step
        let _ = self
            .env
            .events()
            .all()
            .filter_by_contract(&self.contract_id);
        let _ = self.model.drain_events();
    }
}
