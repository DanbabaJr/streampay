use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::errors::StreamError;
use crate::events::{PolicyViolation, SenderPolicyRevoked, SenderPolicySet};
use crate::stream::{TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderPolicy {
    pub version: u32,
    pub allowed_tokens: Option<Vec<Address>>,
    pub max_deposit_per_stream: Option<i128>,
    pub max_rate_per_second: Option<i128>,
    pub max_duration_seconds: Option<u64>,
    pub max_outflow_per_epoch: Option<i128>,
    pub epoch_duration_seconds: u64,
    pub current_epoch_outflow: i128,
    pub epoch_start_time: u64,
    pub recipient_whitelist: Option<Vec<Address>>,
    pub max_per_recipient_cap: Option<i128>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SenderPolicyDataKey {
    Policy(Address),
    HasPolicies,
}

pub fn has_any_policies(env: &Env) -> bool {
    env.storage().instance().has(&SenderPolicyDataKey::HasPolicies)
}

pub fn get_sender_policy(env: &Env, sender: &Address) -> Option<SenderPolicy> {
    env.storage()
        .persistent()
        .get(&SenderPolicyDataKey::Policy(sender.clone()))
}

pub fn set_sender_policy(
    env: &Env,
    sender: &Address,
    mut policy: SenderPolicy,
) -> Result<(), StreamError> {
    sender.require_auth();

    let current = get_sender_policy(env, sender);
    let next_version = current.map(|p| p.version.saturating_add(1)).unwrap_or(1);
    policy.version = next_version;

    // Validate bounds
    if let Some(deposit) = policy.max_deposit_per_stream {
        if deposit <= 0 {
            return Err(surface::reject(Branch::SenderPolicyInvalidBounds));
        }
    }
    if let Some(rate) = policy.max_rate_per_second {
        if rate <= 0 {
            return Err(surface::reject(Branch::SenderPolicyInvalidBounds));
        }
    }

    let key = SenderPolicyDataKey::Policy(sender.clone());
    env.storage().persistent().set(&key, &policy);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    env.storage().instance().set(&SenderPolicyDataKey::HasPolicies, &true);

    SenderPolicySet {
        sender: sender.clone(),
        version: next_version,
    }
    .publish(env);

    Ok(())
}

pub fn revoke_sender_policy(env: &Env, sender: &Address) -> Result<(), StreamError> {
    sender.require_auth();
    let current = get_sender_policy(env, sender)
        .ok_or_else(|| surface::reject(Branch::SenderPolicyNotFound))?;

    let key = SenderPolicyDataKey::Policy(sender.clone());
    env.storage().persistent().remove(&key);

    SenderPolicyRevoked {
        sender: sender.clone(),
        version: current.version,
    }
    .publish(env);

    Ok(())
}

/// Enforces smart-wallet sender spending policy composed with governance policy floors and allowlist.
/// Strict-bound composition: the stricter bound always wins; sender policy cannot loosen governance.
pub fn validate_and_record_spend(
    env: &Env,
    sender: &Address,
    recipient: &Address,
    token: &Address,
    deposit: i128,
    rate_per_second: i128,
    duration: u64,
) -> Result<(), StreamError> {
    if !has_any_policies(env) {
        return Ok(());
    }
    let mut policy = match get_sender_policy(env, sender) {
        Some(p) => p,
        None => return Ok(()), // No sender policy configured; governance rules bind alone
    };

    // 1. Asset restriction: must be allowed by sender policy AND governance allowlist
    if let Some(ref allowed) = policy.allowed_tokens {
        if !allowed.contains(token) {
            PolicyViolation {
                sender: sender.clone(),
                stream_id: 0,
                violation_code: 1, // TokenNotAllowed
            }
            .publish(env);
            return Err(surface::reject(Branch::SenderPolicyViolated));
        }
    }

    // 2. Deposit cap (stricter than governance)
    if let Some(max_dep) = policy.max_deposit_per_stream {
        if deposit > max_dep {
            PolicyViolation {
                sender: sender.clone(),
                stream_id: 0,
                violation_code: 2, // DepositCapExceeded
            }
            .publish(env);
            return Err(surface::reject(Branch::SenderPolicyViolated));
        }
    }

    // 3. Rate ceiling (stricter than governance)
    if let Some(max_rate) = policy.max_rate_per_second {
        if rate_per_second > max_rate {
            PolicyViolation {
                sender: sender.clone(),
                stream_id: 0,
                violation_code: 3, // RateCeilingExceeded
            }
            .publish(env);
            return Err(surface::reject(Branch::SenderPolicyViolated));
        }
    }

    // 4. Duration ceiling (stricter than governance)
    if let Some(max_dur) = policy.max_duration_seconds {
        if duration > max_dur {
            PolicyViolation {
                sender: sender.clone(),
                stream_id: 0,
                violation_code: 4, // DurationCeilingExceeded
            }
            .publish(env);
            return Err(surface::reject(Branch::SenderPolicyViolated));
        }
    }

    // 5. Recipient whitelist
    if let Some(ref whitelist) = policy.recipient_whitelist {
        if !whitelist.contains(recipient) {
            PolicyViolation {
                sender: sender.clone(),
                stream_id: 0,
                violation_code: 5, // RecipientNotWhitelisted
            }
            .publish(env);
            return Err(surface::reject(Branch::SenderPolicyViolated));
        }
    }

    // 6. Outflow per epoch tracking
    if let Some(max_outflow) = policy.max_outflow_per_epoch {
        let now = env.ledger().timestamp();
        if policy.epoch_duration_seconds > 0
            && now >= policy.epoch_start_time.saturating_add(policy.epoch_duration_seconds)
        {
            policy.epoch_start_time = now;
            policy.current_epoch_outflow = 0;
        }

        let new_outflow = policy.current_epoch_outflow.saturating_add(deposit);
        if new_outflow > max_outflow {
            PolicyViolation {
                sender: sender.clone(),
                stream_id: 0,
                violation_code: 6, // EpochOutflowExceeded
            }
            .publish(env);
            return Err(surface::reject(Branch::SenderPolicyViolated));
        }
        policy.current_epoch_outflow = new_outflow;

        let key = SenderPolicyDataKey::Policy(sender.clone());
        env.storage().persistent().set(&key, &policy);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }

    Ok(())
}
