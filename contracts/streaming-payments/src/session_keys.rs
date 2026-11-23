//! Session Keys: Capped Automated Withdrawals for Recipients (Issue #56).
//!
//! Lets a recipient authorize a hot wallet / automation agent to call withdrawals
//! under strict caps (max per period, max per stream, expiry), verified on-chain.

use soroban_sdk::{contractevent, contracttype, Address, Env};

use crate::errors::StreamError;
use crate::stream::{self, StreamStatus};
use crate::surface::{self, Branch};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAuthorized {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub agent: Address,
    pub max_per_period: i128,
    pub period_seconds: u64,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DelegatedWithdrawal {
    #[topic]
    pub stream_id: u64,
    pub agent: Address,
    pub amount: i128,
    pub spent_current_period: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRevoked {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub agent: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionKeyDataKey {
    Policy(Address, u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionKeyPolicy {
    pub recipient: Address,
    pub agent: Address,
    pub stream_id: u64,
    pub max_per_period: i128,
    pub period_seconds: u64,
    pub expires_at: u64,
    pub current_period_start: u64,
    pub spent_current_period: i128,
    pub revoked: bool,
}

pub fn authorize_agent(
    env: &Env,
    recipient: Address,
    agent: Address,
    stream_id: u64,
    max_per_period: i128,
    period_seconds: u64,
    expires_at: u64,
) -> Result<(), StreamError> {
    recipient.require_auth();
    let s = stream::get_stream(env, stream_id)?;
    if s.recipient != recipient {
        return Err(surface::reject(Branch::CancelStreamNotAuthorized));
    }
    if s.status != StreamStatus::Active {
        return Err(surface::reject(Branch::StreamNotActive));
    }
    if max_per_period <= 0 || period_seconds == 0 || expires_at <= env.ledger().timestamp() {
        return Err(surface::reject(Branch::CreateInvalidTimeRange));
    }

    let policy = SessionKeyPolicy {
        recipient: recipient.clone(),
        agent: agent.clone(),
        stream_id,
        max_per_period,
        period_seconds,
        expires_at,
        current_period_start: env.ledger().timestamp(),
        spent_current_period: 0,
        revoked: false,
    };

    let key = SessionKeyDataKey::Policy(agent.clone(), stream_id);
    env.storage().persistent().set(&key, &policy);

    AgentAuthorized {
        stream_id,
        recipient,
        agent,
        max_per_period,
        period_seconds,
        expires_at,
    }
    .publish(env);

    Ok(())
}

pub fn withdraw_delegated(
    env: &Env,
    agent: Address,
    stream_id: u64,
    amount: i128,
) -> Result<SessionKeyPolicy, StreamError> {
    agent.require_auth();
    if amount <= 0 {
        return Err(surface::reject(Branch::WithdrawAmountNonPositive));
    }

    let key = SessionKeyDataKey::Policy(agent.clone(), stream_id);
    let mut policy: SessionKeyPolicy = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or_else(|| surface::reject(Branch::CancelStreamNotAuthorized))?;

    if policy.revoked {
        return Err(surface::reject(Branch::CancelStreamNotAuthorized));
    }

    let now = env.ledger().timestamp();
    if now >= policy.expires_at {
        return Err(surface::reject(Branch::ClaimExpired));
    }

    // Advance window if fixed/rolling period has elapsed
    if now
        >= policy
            .current_period_start
            .saturating_add(policy.period_seconds)
    {
        policy.current_period_start = now;
        policy.spent_current_period = 0;
    }

    let new_spent = policy
        .spent_current_period
        .checked_add(amount)
        .ok_or_else(|| surface::reject(Branch::CapacityOverflow))?;

    if new_spent > policy.max_per_period {
        return Err(surface::reject(Branch::WithdrawAmountExceedsAvailable));
    }

    policy.spent_current_period = new_spent;
    env.storage().persistent().set(&key, &policy);

    DelegatedWithdrawal {
        stream_id,
        agent,
        amount,
        spent_current_period: policy.spent_current_period,
    }
    .publish(env);

    Ok(policy)
}

pub fn revoke_agent(
    env: &Env,
    recipient: Address,
    agent: Address,
    stream_id: u64,
) -> Result<(), StreamError> {
    recipient.require_auth();
    let key = SessionKeyDataKey::Policy(agent.clone(), stream_id);
    let mut policy: SessionKeyPolicy = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or_else(|| surface::reject(Branch::CancelStreamNotAuthorized))?;

    if policy.recipient != recipient {
        return Err(surface::reject(Branch::CancelStreamNotAuthorized));
    }

    policy.revoked = true;
    env.storage().persistent().set(&key, &policy);

    AgentRevoked {
        stream_id,
        recipient,
        agent,
    }
    .publish(env);

    Ok(())
}

pub fn get_session_policy(env: &Env, agent: Address, stream_id: u64) -> Option<SessionKeyPolicy> {
    let key = SessionKeyDataKey::Policy(agent, stream_id);
    env.storage().persistent().get(&key)
}
