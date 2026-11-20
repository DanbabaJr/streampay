//! Receivables financing — borrow against future stream accrual.
//!
//! Recipient collateralizes the unaccrued future value of an active stream
//! to draw an advance from a liquidity pool or lender, without touching the
//! sender's deposit or the linear vesting schedule.
//!
//! Repayment intercepts a configurable slice of each withdrawal until the
//! advance plus fee is settled. If cancelled, any accrued funds due to the
//! recipient are applied to settle the advance, while the sender's unaccrued
//! remainder is fully refunded.

use soroban_sdk::{contracttype, Address, Env};

use crate::errors::StreamError;
use crate::events::{AdvanceDrawn, AdvanceLiquidated, AdvanceRepaid};
use crate::stream::{get_stream, DataKey, StreamStatus, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

pub const BPS_DENOMINATOR: u32 = 10_000;
pub const DEFAULT_MAX_LTV_BPS: u32 = 7_500; // 75% max LTV

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Governance receivables configuration stored in instance storage."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceivablesConfig {
    pub max_ltv_bps: u32,
    pub fee_bps: u32,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " An active advance against future stream accrual."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Advance {
    pub stream_id: u64,
    pub recipient: Address,
    pub lender: Address,
    pub principal: i128,
    pub fee: i128,
    pub total_owed: i128,
    pub repaid: i128,
    pub repayment_bps: u32,
}

/// Sets or updates the global receivables configuration.
/// Must be authorized by the governor.
pub fn set_receivables_config(
    env: &Env,
    max_ltv_bps: u32,
    fee_bps: u32,
) -> Result<(), StreamError> {
    if max_ltv_bps == 0 || max_ltv_bps > BPS_DENOMINATOR {
        return Err(surface::reject(Branch::InvalidLtvBps));
    }
    if fee_bps > BPS_DENOMINATOR {
        return Err(surface::reject(Branch::InvalidLtvBps));
    }
    let config = ReceivablesConfig {
        max_ltv_bps,
        fee_bps,
    };
    env.storage()
        .instance()
        .set(&DataKey::ReceivablesConfig, &config);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Ok(())
}

/// Returns the current receivables configuration.
pub fn get_receivables_config(env: &Env) -> ReceivablesConfig {
    env.storage()
        .instance()
        .get(&DataKey::ReceivablesConfig)
        .unwrap_or(ReceivablesConfig {
            max_ltv_bps: DEFAULT_MAX_LTV_BPS,
            fee_bps: 0,
        })
}

/// Returns the active advance on a stream, if any.
pub fn get_advance(env: &Env, stream_id: u64) -> Option<Advance> {
    env.storage().persistent().get(&DataKey::Advance(stream_id))
}

/// Draws an advance against the unaccrued future value of stream `stream_id`.
pub fn draw_advance(
    env: &Env,
    stream_id: u64,
    lender: Address,
    amount: i128,
    repayment_bps: u32,
) -> Result<(), StreamError> {
    let s = get_stream(env, stream_id)?;

    s.recipient.require_auth();
    lender.require_auth();

    if s.status != StreamStatus::Active {
        return Err(surface::reject(Branch::StreamNotEligibleForAdvance));
    }
    if crate::stream::get_paused_at(env, stream_id).is_some() {
        return Err(surface::reject(Branch::StreamNotEligibleForAdvance));
    }
    if get_advance(env, stream_id).is_some() {
        return Err(surface::reject(Branch::AdvanceAlreadyActive));
    }
    if amount <= 0 {
        return Err(surface::reject(Branch::AdvanceAmountNonPositive));
    }
    if repayment_bps == 0 || repayment_bps > BPS_DENOMINATOR {
        return Err(surface::reject(Branch::InvalidLtvBps));
    }

    let config = get_receivables_config(env);
    let streamed = crate::stream::streamed_amount(env, &s)?;
    let remaining_streamable = s.deposit.saturating_sub(streamed);

    let max_advance = (remaining_streamable * config.max_ltv_bps as i128) / BPS_DENOMINATOR as i128;
    if amount > max_advance {
        return Err(surface::reject(Branch::AdvanceExceedsMaxLtv));
    }

    let fee = (amount * config.fee_bps as i128) / BPS_DENOMINATOR as i128;
    let total_owed = amount
        .checked_add(fee)
        .ok_or_else(|| surface::reject(Branch::PayoutOverflow))?;

    let advance = Advance {
        stream_id,
        recipient: s.recipient.clone(),
        lender: lender.clone(),
        principal: amount,
        fee,
        total_owed,
        repaid: 0,
        repayment_bps,
    };

    let key = DataKey::Advance(stream_id);
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent Advance({stream_id})"));
    env.storage().persistent().set(&key, &advance);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    #[cfg(test)]
    crate::cei_trace::record("transfer advance principal");
    let token_client = soroban_sdk::token::TokenClient::new(env, &s.token);
    token_client.transfer(&lender, &s.recipient, &amount);

    #[cfg(test)]
    crate::cei_trace::record("event AdvanceDrawn");
    AdvanceDrawn {
        stream_id,
        recipient: s.recipient,
        lender,
        amount,
        fee,
        repayment_bps,
    }
    .publish(env);

    Ok(())
}

/// Allows manually repaying an active advance.
pub fn repay_advance(
    env: &Env,
    caller: Address,
    stream_id: u64,
    amount: i128,
) -> Result<(), StreamError> {
    caller.require_auth();

    if amount <= 0 {
        return Err(surface::reject(Branch::AdvanceRepaymentNonPositive));
    }

    let mut advance =
        get_advance(env, stream_id).ok_or_else(|| surface::reject(Branch::AdvanceNotFound))?;

    let remaining_owed = advance.total_owed.saturating_sub(advance.repaid);
    if amount > remaining_owed {
        return Err(surface::reject(Branch::AdvanceRepaymentExceedsBalance));
    }

    advance.repaid = advance
        .repaid
        .checked_add(amount)
        .ok_or_else(|| surface::reject(Branch::PayoutOverflow))?;

    let key = DataKey::Advance(stream_id);
    if advance.repaid >= advance.total_owed {
        #[cfg(test)]
        crate::cei_trace::record(&std::format!("remove persistent Advance({stream_id})"));
        env.storage().persistent().remove(&key);
    } else {
        #[cfg(test)]
        crate::cei_trace::record(&std::format!("write persistent Advance({stream_id})"));
        env.storage().persistent().set(&key, &advance);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }

    let s = get_stream(env, stream_id)?;

    #[cfg(test)]
    crate::cei_trace::record("transfer advance repayment");
    let token_client = soroban_sdk::token::TokenClient::new(env, &s.token);
    token_client.transfer(&caller, &advance.lender, &amount);

    #[cfg(test)]
    crate::cei_trace::record("event AdvanceRepaid");
    AdvanceRepaid {
        stream_id,
        recipient: advance.recipient,
        lender: advance.lender,
        amount,
        remaining_owed: remaining_owed - amount,
    }
    .publish(env);

    Ok(())
}

/// Intercepts repayment from a gross withdrawal amount.
/// Returns `(net_to_recipient, intercept_to_lender, Option<lender_address>)`.
pub fn intercept_repayment(
    env: &Env,
    stream_id: u64,
    gross_withdraw: i128,
) -> (i128, i128, Option<Address>) {
    let Some(mut advance) = get_advance(env, stream_id) else {
        return (gross_withdraw, 0, None);
    };

    let remaining_owed = advance.total_owed.saturating_sub(advance.repaid);
    if remaining_owed == 0 {
        return (gross_withdraw, 0, None);
    }

    let slice = (gross_withdraw * advance.repayment_bps as i128) / BPS_DENOMINATOR as i128;
    let intercept = core::cmp::min(slice, remaining_owed);
    let net_recipient = gross_withdraw.saturating_sub(intercept);

    advance.repaid = advance.repaid.saturating_add(intercept);

    let key = DataKey::Advance(stream_id);
    if advance.repaid >= advance.total_owed {
        #[cfg(test)]
        crate::cei_trace::record(&std::format!("remove persistent Advance({stream_id})"));
        env.storage().persistent().remove(&key);
    } else {
        #[cfg(test)]
        crate::cei_trace::record(&std::format!("write persistent Advance({stream_id})"));
        env.storage().persistent().set(&key, &advance);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }

    if intercept > 0 {
        #[cfg(test)]
        crate::cei_trace::record("event AdvanceRepaid");
        AdvanceRepaid {
            stream_id,
            recipient: advance.recipient.clone(),
            lender: advance.lender.clone(),
            amount: intercept,
            remaining_owed: remaining_owed - intercept,
        }
        .publish(env);
    }

    (net_recipient, intercept, Some(advance.lender))
}

/// Liquidates/settles an active advance upon stream cancellation.
/// Any accrued value due to the recipient is applied to settle the advance;
/// the sender's unaccrued deposit remains completely untouched.
pub fn liquidate_on_cancellation(
    env: &Env,
    stream_id: u64,
    accrued_recipient: i128,
) -> (i128, i128, Option<Address>) {
    let Some(advance) = get_advance(env, stream_id) else {
        return (accrued_recipient, 0, None);
    };

    let remaining_owed = advance.total_owed.saturating_sub(advance.repaid);
    let intercept = core::cmp::min(accrued_recipient, remaining_owed);
    let net_recipient = accrued_recipient.saturating_sub(intercept);
    let remaining_unpaid = remaining_owed.saturating_sub(intercept);

    let key = DataKey::Advance(stream_id);
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("remove persistent Advance({stream_id})"));
    env.storage().persistent().remove(&key);

    #[cfg(test)]
    crate::cei_trace::record("event AdvanceLiquidated");
    AdvanceLiquidated {
        stream_id,
        recipient: advance.recipient.clone(),
        lender: advance.lender.clone(),
        amount: intercept,
        remaining_unpaid,
    }
    .publish(env);

    (net_recipient, intercept, Some(advance.lender))
}
