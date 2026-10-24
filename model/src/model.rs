//! Standalone reference specification model of the StreamPay protocol.
//!
//! Plain Rust functions with no [`soroban_sdk::Env`] dependencies.
//! A reviewer can approve this model directly as the protocol specification.

use std::collections::BTreeMap;

use crate::errors::ModelError;
use crate::events::ModelEvent;
use crate::math::{self, cancel_amounts, elapsed_seconds, fee_amount, validate_capacity};
use crate::types::{
    ModelFeeScan, ModelStream, ModelStreamStatus, ModelTreasury, ModelTreasuryStatus,
    MAX_DURATION_SECONDS, MAX_FEE_BPS, MAX_PAGE_SIZE,
};

/// Optional mutations that can intentionally break model rules to prove
/// the differential harness catches divergence.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelMutations {
    pub break_accrual_add_one: bool,
    pub break_fee_math_add_one: bool,
    pub break_cancel_sender_refund_sub_one: bool,
}

/// The StreamPay standalone protocol model.
#[derive(Clone, Debug)]
pub struct StreamPayModel {
    pub now: u64,
    pub governor: String,
    pub pending_governor: Option<String>,
    pub fee_bps: u32,
    pub next_stream_id: u64,
    pub streams: BTreeMap<u64, ModelStream>,
    pub stream_fees: BTreeMap<u64, (String, i128)>,
    pub treasuries: BTreeMap<String, ModelTreasury>,
    pub sender_streams: BTreeMap<String, Vec<u64>>,
    pub recipient_streams: BTreeMap<String, Vec<u64>>,
    pub token_balances: BTreeMap<(String, String), i128>,
    pub contract_balances: BTreeMap<String, i128>,
    pub events: Vec<ModelEvent>,
    pub mutations: ModelMutations,
}

impl StreamPayModel {
    /// Creates a new protocol model instance.
    pub fn new(governor: String, initial_now: u64) -> Self {
        Self {
            now: initial_now,
            governor,
            pending_governor: None,
            fee_bps: 0,
            next_stream_id: 1,
            streams: BTreeMap::new(),
            stream_fees: BTreeMap::new(),
            treasuries: BTreeMap::new(),
            sender_streams: BTreeMap::new(),
            recipient_streams: BTreeMap::new(),
            token_balances: BTreeMap::new(),
            contract_balances: BTreeMap::new(),
            events: Vec::new(),
            mutations: ModelMutations::default(),
        }
    }

    /// Sets or adjusts a user's initial token balance.
    pub fn set_token_balance(&mut self, user: &str, token: &str, amount: i128) {
        self.token_balances
            .insert((user.to_string(), token.to_string()), amount);
    }

    /// Advances the model's ledger timestamp by `seconds`.
    pub fn advance_time(&mut self, seconds: u64) {
        self.now = self.now.saturating_add(seconds);
    }

    /// Internal streamed_at that respects intentional test mutations.
    fn streamed_at_internal(
        &self,
        deposit: i128,
        duration: u64,
        elapsed: u64,
    ) -> Result<i128, ModelError> {
        let mut res = math::streamed_at(deposit, duration, elapsed)?;
        if self.mutations.break_accrual_add_one && res > 0 {
            res = res.saturating_add(1);
        }
        Ok(res)
    }

    /// Available unwithdrawn balance for `stream` at current ledger time.
    pub fn available_amount(&self, stream: &ModelStream) -> Result<i128, ModelError> {
        if stream.status == ModelStreamStatus::Cancelled {
            return Ok(0);
        }
        let elapsed = elapsed_seconds(self.now, stream.start_time, stream.end_time);
        let streamed = self.streamed_at_internal(stream.deposit, stream.duration(), elapsed)?;
        streamed
            .checked_sub(stream.withdrawn)
            .ok_or(ModelError::MathOverflow)
    }

    /// Creates a payment stream and pulls `deposit + fee` from sender.
    #[allow(clippy::too_many_arguments)]
    pub fn create_stream(
        &mut self,
        sender: &str,
        recipient: &str,
        token: &str,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    ) -> Result<u64, ModelError> {
        if deposit_amount <= 0 {
            return Err(ModelError::ZeroAmount);
        }
        if start_time < self.now {
            return Err(ModelError::StartTimeInPast);
        }
        if end_time <= start_time {
            return Err(ModelError::InvalidTimeRange);
        }
        let duration = end_time - start_time;
        if duration > MAX_DURATION_SECONDS {
            return Err(ModelError::DurationTooLong);
        }
        validate_capacity(deposit_amount, duration)?;

        let mut fee = fee_amount(deposit_amount, self.fee_bps)?;
        if self.mutations.break_fee_math_add_one && fee > 0 {
            fee = fee.saturating_add(1);
        }

        let pull_amount = deposit_amount
            .checked_add(fee)
            .ok_or(ModelError::MathOverflow)?;

        // Deduct from sender balance and credit to contract balance
        let sender_bal = self
            .token_balances
            .entry((sender.to_string(), token.to_string()))
            .or_insert(0);
        *sender_bal = sender_bal
            .checked_sub(pull_amount)
            .ok_or(ModelError::MathOverflow)?;

        let contract_bal = self.contract_balances.entry(token.to_string()).or_insert(0);
        *contract_bal = contract_bal
            .checked_add(pull_amount)
            .ok_or(ModelError::MathOverflow)?;

        let id = self.next_stream_id;
        self.next_stream_id += 1;

        let s = ModelStream {
            id,
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            token: token.to_string(),
            deposit: deposit_amount,
            withdrawn: 0,
            start_time,
            end_time,
            cancelable,
            status: ModelStreamStatus::Active,
        };
        self.streams.insert(id, s);
        self.sender_streams
            .entry(sender.to_string())
            .or_default()
            .push(id);
        self.recipient_streams
            .entry(recipient.to_string())
            .or_default()
            .push(id);

        if fee > 0 {
            let t = self.treasuries.entry(token.to_string()).or_default();
            t.charged_total = t
                .charged_total
                .checked_add(fee)
                .ok_or(ModelError::MathOverflow)?;
            self.stream_fees.insert(id, (token.to_string(), fee));
        }

        self.events.push(ModelEvent::StreamCreated {
            stream_id: id,
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            token: token.to_string(),
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
        });

        if fee > 0 {
            self.events.push(ModelEvent::FeeCharged {
                stream_id: id,
                token: token.to_string(),
                payer: sender.to_string(),
                amount: fee,
                fee_bps: self.fee_bps,
            });
        }

        Ok(id)
    }

    /// Recipient withdraws up to `amount` of accrued unwithdrawn balance.
    pub fn withdraw(&mut self, stream_id: u64, amount: i128) -> Result<(), ModelError> {
        if amount <= 0 {
            return Err(ModelError::ZeroAmount);
        }
        let available = {
            let s = self
                .streams
                .get(&stream_id)
                .ok_or(ModelError::StreamNotFound)?;
            if s.status != ModelStreamStatus::Active {
                return Err(ModelError::StreamNotActive);
            }
            self.available_amount(s)?
        };
        if amount > available {
            return Err(ModelError::AmountExceedsAvailable);
        }

        let s = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound)?;

        s.withdrawn = s
            .withdrawn
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;
        if s.withdrawn == s.deposit {
            s.status = ModelStreamStatus::Depleted;
        }

        let token = s.token.clone();
        let recipient = s.recipient.clone();
        let withdrawn_total = s.withdrawn;

        let contract_bal = self.contract_balances.entry(token.clone()).or_insert(0);
        *contract_bal = contract_bal
            .checked_sub(amount)
            .ok_or(ModelError::MathOverflow)?;

        let recipient_bal = self
            .token_balances
            .entry((recipient.clone(), token))
            .or_insert(0);
        *recipient_bal = recipient_bal
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;

        self.events.push(ModelEvent::Withdrawn {
            stream_id,
            recipient,
            amount,
            withdrawn_total,
        });

        Ok(())
    }

    /// Recipient atomically withdraws all accrued-but-unwithdrawn funds.
    pub fn withdraw_max(&mut self, stream_id: u64) -> Result<i128, ModelError> {
        let amount = {
            let s = self
                .streams
                .get(&stream_id)
                .ok_or(ModelError::StreamNotFound)?;
            if s.status != ModelStreamStatus::Active {
                return Err(ModelError::StreamNotActive);
            }
            self.available_amount(s)?
        };
        if amount <= 0 {
            return Err(ModelError::NothingToWithdraw);
        }

        let s = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound)?;

        s.withdrawn = s
            .withdrawn
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;
        if s.withdrawn == s.deposit {
            s.status = ModelStreamStatus::Depleted;
        }

        let token = s.token.clone();
        let recipient = s.recipient.clone();
        let withdrawn_total = s.withdrawn;

        let contract_bal = self.contract_balances.entry(token.clone()).or_insert(0);
        *contract_bal = contract_bal
            .checked_sub(amount)
            .ok_or(ModelError::MathOverflow)?;

        let recipient_bal = self
            .token_balances
            .entry((recipient.clone(), token))
            .or_insert(0);
        *recipient_bal = recipient_bal
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;

        self.events.push(ModelEvent::Withdrawn {
            stream_id,
            recipient,
            amount,
            withdrawn_total,
        });

        Ok(amount)
    }

    /// Cancels an active stream with a pro-rata split.
    pub fn cancel_stream(&mut self, caller: &str, stream_id: u64) -> Result<(), ModelError> {
        let (recipient_amount, mut sender_amount) = {
            let s = self
                .streams
                .get(&stream_id)
                .ok_or(ModelError::StreamNotFound)?;
            if s.status != ModelStreamStatus::Active {
                return Err(ModelError::StreamNotActive);
            }
            if caller != s.sender {
                if caller == s.recipient {
                    if !s.cancelable {
                        return Err(ModelError::StreamNotCancellable);
                    }
                } else {
                    return Err(ModelError::NotAuthorized);
                }
            }

            cancel_amounts(self.now, s)?
        };

        if self.mutations.break_cancel_sender_refund_sub_one && sender_amount > 0 {
            sender_amount = sender_amount.saturating_sub(1);
        }

        let s = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound)?;

        s.status = ModelStreamStatus::Cancelled;
        s.withdrawn = s
            .withdrawn
            .checked_add(recipient_amount)
            .ok_or(ModelError::MathOverflow)?;

        let token = s.token.clone();
        let recipient = s.recipient.clone();
        let sender = s.sender.clone();

        self.events.push(ModelEvent::StreamCancelled {
            stream_id,
            cancelled_by: caller.to_string(),
            recipient_amount,
            sender_amount,
        });

        if recipient_amount > 0 {
            let contract_bal = self.contract_balances.entry(token.clone()).or_insert(0);
            *contract_bal = contract_bal
                .checked_sub(recipient_amount)
                .ok_or(ModelError::MathOverflow)?;

            let recipient_bal = self
                .token_balances
                .entry((recipient, token.clone()))
                .or_insert(0);
            *recipient_bal = recipient_bal
                .checked_add(recipient_amount)
                .ok_or(ModelError::MathOverflow)?;
        }

        if sender_amount > 0 {
            let contract_bal = self.contract_balances.entry(token.clone()).or_insert(0);
            *contract_bal = contract_bal
                .checked_sub(sender_amount)
                .ok_or(ModelError::MathOverflow)?;

            let sender_bal = self.token_balances.entry((sender, token)).or_insert(0);
            *sender_bal = sender_bal
                .checked_add(sender_amount)
                .ok_or(ModelError::MathOverflow)?;
        }

        Ok(())
    }

    /// Adds funds to an active stream without extending end_time.
    pub fn top_up(&mut self, caller: &str, stream_id: u64, amount: i128) -> Result<(), ModelError> {
        if amount <= 0 {
            return Err(ModelError::ZeroAmount);
        }
        let s = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound)?;
        if s.status != ModelStreamStatus::Active {
            return Err(ModelError::StreamNotActive);
        }
        if caller != s.sender {
            return Err(ModelError::NotAuthorized);
        }

        let new_deposit = s
            .deposit
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;
        validate_capacity(new_deposit, s.duration())?;

        let token = s.token.clone();
        let sender = s.sender.clone();

        let sender_bal = self
            .token_balances
            .entry((sender.clone(), token.clone()))
            .or_insert(0);
        *sender_bal = sender_bal
            .checked_sub(amount)
            .ok_or(ModelError::MathOverflow)?;

        let contract_bal = self.contract_balances.entry(token).or_insert(0);
        *contract_bal = contract_bal
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;

        s.deposit = new_deposit;

        self.events.push(ModelEvent::StreamToppedUp {
            stream_id,
            sender,
            amount,
            new_deposit,
        });

        Ok(())
    }

    /// Sets the protocol fee rate in basis points (governor-only).
    pub fn set_fee_bps(&mut self, caller: &str, new_fee_bps: u32) -> Result<(), ModelError> {
        if caller != self.governor {
            return Err(ModelError::NotGovernor);
        }
        if new_fee_bps > MAX_FEE_BPS {
            return Err(ModelError::FeeRateTooHigh);
        }
        self.fee_bps = new_fee_bps;
        Ok(())
    }

    /// Step 1 of 2-step governor rotation (governor-only).
    pub fn nominate_governor(
        &mut self,
        caller: &str,
        new_governor: &str,
    ) -> Result<(), ModelError> {
        if caller != self.governor {
            return Err(ModelError::NotGovernor);
        }
        self.pending_governor = Some(new_governor.to_string());
        Ok(())
    }

    /// Step 2 of 2-step governor rotation (nominee-only).
    pub fn accept_governor(&mut self, caller: &str) -> Result<(), ModelError> {
        let pending = self
            .pending_governor
            .as_ref()
            .ok_or(ModelError::NoPendingGovernor)?;
        if pending != caller {
            return Err(ModelError::NotGovernor);
        }
        self.governor = caller.to_string();
        self.pending_governor = None;
        Ok(())
    }

    /// Governor withdraws accumulated protocol fees for a token.
    pub fn withdraw_treasury(
        &mut self,
        caller: &str,
        token: &str,
        recipient: &str,
        amount: i128,
    ) -> Result<(), ModelError> {
        if caller != self.governor {
            return Err(ModelError::NotGovernor);
        }
        if amount <= 0 {
            return Err(ModelError::ZeroAmount);
        }
        let t = self.treasuries.entry(token.to_string()).or_default();
        let collectible = t
            .charged_total
            .checked_sub(t.withdrawn_total)
            .ok_or(ModelError::MathOverflow)?;
        if amount > collectible {
            return Err(ModelError::InsufficientTreasuryBalance);
        }

        t.withdrawn_total = t
            .withdrawn_total
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;
        let withdrawn_total = t.withdrawn_total;

        let contract_bal = self.contract_balances.entry(token.to_string()).or_insert(0);
        *contract_bal = contract_bal
            .checked_sub(amount)
            .ok_or(ModelError::MathOverflow)?;

        let recipient_bal = self
            .token_balances
            .entry((recipient.to_string(), token.to_string()))
            .or_insert(0);
        *recipient_bal = recipient_bal
            .checked_add(amount)
            .ok_or(ModelError::MathOverflow)?;

        self.events.push(ModelEvent::FeeWithdrawn {
            token: token.to_string(),
            governor: caller.to_string(),
            recipient: recipient.to_string(),
            amount,
            withdrawn_total,
        });

        Ok(())
    }

    /// Returns a copy of a stream's state.
    pub fn get_stream(&self, stream_id: u64) -> Result<ModelStream, ModelError> {
        self.streams
            .get(&stream_id)
            .cloned()
            .ok_or(ModelError::StreamNotFound)
    }

    /// Returns the available amount for a stream.
    pub fn available(&self, stream_id: u64) -> Result<i128, ModelError> {
        let s = self
            .streams
            .get(&stream_id)
            .ok_or(ModelError::StreamNotFound)?;
        self.available_amount(s)
    }

    /// Paginated discovery view for recipient streams.
    pub fn recipient_streams(&self, recipient: &str, offset: u32, limit: u32) -> Vec<u64> {
        let empty = Vec::new();
        let ids = self.recipient_streams.get(recipient).unwrap_or(&empty);
        let start = (offset as usize).min(ids.len());
        let end = start
            .saturating_add((limit.min(MAX_PAGE_SIZE)) as usize)
            .min(ids.len());
        ids[start..end].to_vec()
    }

    /// Paginated discovery view for sender streams.
    pub fn sender_streams(&self, sender: &str, offset: u32, limit: u32) -> Vec<u64> {
        let empty = Vec::new();
        let ids = self.sender_streams.get(sender).unwrap_or(&empty);
        let start = (offset as usize).min(ids.len());
        let end = start
            .saturating_add((limit.min(MAX_PAGE_SIZE)) as usize)
            .min(ids.len());
        ids[start..end].to_vec()
    }

    /// Returns the treasury snapshot for `token`.
    pub fn treasury_status(&self, token: &str) -> ModelTreasuryStatus {
        let default_t = ModelTreasury::default();
        let t = self.treasuries.get(token).unwrap_or(&default_t);
        let collectible = t.charged_total.saturating_sub(t.withdrawn_total);
        ModelTreasuryStatus {
            token: token.to_string(),
            governor: self.governor.clone(),
            pending_governor: self.pending_governor.clone(),
            fee_bps: self.fee_bps,
            max_fee_bps: MAX_FEE_BPS,
            charged_total: t.charged_total,
            withdrawn_total: t.withdrawn_total,
            collectible,
        }
    }

    /// Returns the protocol fee charged for `stream_id`.
    pub fn stream_fee(&self, stream_id: u64) -> Result<i128, ModelError> {
        if !self.streams.contains_key(&stream_id) {
            return Err(ModelError::StreamNotFound);
        }
        Ok(self
            .stream_fees
            .get(&stream_id)
            .map(|(_, amt)| *amt)
            .unwrap_or(0))
    }

    /// Verifies the fee scan across stream ids.
    pub fn verify_treasury(&self, token: &str, start_id: u64, count: u32) -> ModelFeeScan {
        let count = count.min(MAX_PAGE_SIZE);
        let total = self.next_stream_id;
        let mut fees_in_range: i128 = 0;
        let mut next_start_id = start_id;
        let mut scanned = 0;
        while scanned < count && next_start_id < total {
            if let Some((t, amount)) = self.stream_fees.get(&next_start_id) {
                if t == token {
                    fees_in_range = fees_in_range.saturating_add(*amount);
                }
            }
            next_start_id = next_start_id.saturating_add(1);
            scanned += 1;
        }
        ModelFeeScan {
            token: token.to_string(),
            fees_in_range,
            next_start_id,
            done: next_start_id >= total,
        }
    }

    /// Total number of streams created.
    pub fn total_streams(&self) -> u64 {
        self.next_stream_id.saturating_sub(1)
    }

    /// Drains all emitted events since last read.
    pub fn drain_events(&mut self) -> Vec<ModelEvent> {
        std::mem::take(&mut self.events)
    }
}
