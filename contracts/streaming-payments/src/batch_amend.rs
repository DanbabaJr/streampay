use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::errors::StreamError;
use crate::events::{BatchAmendmentApplied, BatchAmendmentProposed};
use crate::stream::{get_paused_at, get_stream, put_stream, StreamStatus, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

/// Maximum number of amendments permitted per stream.
pub const MAX_AMENDMENTS: u32 = 20;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentRecord {
    pub old_rate: i128,
    pub new_rate: i128,
    pub old_end_time: u64,
    pub new_end_time: u64,
    pub effective_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchAmendmentItem {
    pub stream_id: u64,
    pub new_rate: i128,
    pub new_end_time: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchAmendmentProposal {
    pub batch_id: u64,
    pub sender: Address,
    pub items: Vec<BatchAmendmentItem>,
    pub threshold: u32,
    pub signers: Vec<Address>,
    pub recipient_consents: Vec<Address>,
    pub expires_at: u64,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BatchAmendDataKey {
    NextBatchId,
    BatchProposal(u64),
    AmendmentLog(u64),
}

pub fn get_next_batch_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&BatchAmendDataKey::NextBatchId)
        .unwrap_or(1u64)
}

pub fn increment_batch_id(env: &Env) -> u64 {
    let id = get_next_batch_id(env);
    let next = id.saturating_add(1);
    env.storage()
        .instance()
        .set(&BatchAmendDataKey::NextBatchId, &next);
    id
}

pub fn get_batch_proposal(env: &Env, batch_id: u64) -> Option<BatchAmendmentProposal> {
    env.storage()
        .persistent()
        .get(&BatchAmendDataKey::BatchProposal(batch_id))
}

pub fn put_batch_proposal(env: &Env, proposal: &BatchAmendmentProposal) {
    let key = BatchAmendDataKey::BatchProposal(proposal.batch_id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn get_amendment_log(env: &Env, stream_id: u64) -> Vec<AmendmentRecord> {
    env.storage()
        .persistent()
        .get(&BatchAmendDataKey::AmendmentLog(stream_id))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn put_amendment_log(env: &Env, stream_id: u64, log: &Vec<AmendmentRecord>) {
    let key = BatchAmendDataKey::AmendmentLog(stream_id);
    env.storage().persistent().set(&key, log);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Propose a batch amendment across multiple streams with M-of-N threshold consent.
pub fn propose_batch(
    env: &Env,
    sender: &Address,
    items: &Vec<BatchAmendmentItem>,
    threshold: u32,
    expires_at: u64,
) -> Result<u64, StreamError> {
    sender.require_auth();
    if items.is_empty() {
        return Err(surface::reject(Branch::BatchAmendmentInvalidTerms));
    }
    if threshold == 0 {
        return Err(surface::reject(Branch::BatchAmendmentThresholdNotMet));
    }
    let now = env.ledger().timestamp();
    if expires_at <= now {
        return Err(surface::reject(Branch::BatchAmendmentExpired));
    }

    let mut stream_ids = Vec::new(env);
    let mut i = 0;
    while i < items.len() {
        let item = items.get(i).unwrap();
        if item.new_rate <= 0 || item.new_end_time <= now {
            return Err(surface::reject(Branch::BatchAmendmentInvalidTerms));
        }
        let stream = get_stream(env, item.stream_id)?;
        if stream.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if stream.sender != *sender {
            return Err(surface::reject(Branch::BatchAmendmentThresholdNotMet));
        }
        if get_paused_at(env, item.stream_id).is_some() {
            return Err(surface::reject(Branch::BatchAmendmentStreamPaused));
        }
        if now >= stream.end_time {
            return Err(surface::reject(Branch::BatchAmendmentExpired));
        }
        let log = get_amendment_log(env, item.stream_id);
        if log.len() >= MAX_AMENDMENTS {
            return Err(surface::reject(Branch::BatchAmendmentTooManyAmendments));
        }
        stream_ids.push_back(item.stream_id);
        i += 1;
    }

    let batch_id = increment_batch_id(env);
    let mut signers = Vec::new(env);
    signers.push_back(sender.clone());

    let proposal = BatchAmendmentProposal {
        batch_id,
        sender: sender.clone(),
        items: items.clone(),
        threshold,
        signers,
        recipient_consents: Vec::new(env),
        expires_at,
        executed: false,
    };
    put_batch_proposal(env, &proposal);

    BatchAmendmentProposed {
        batch_id,
        sender: sender.clone(),
        stream_ids,
        expires_at,
    }
    .publish(env);

    Ok(batch_id)
}

/// Register consent for a batch amendment from a sender multisig co-signer or recipient.
pub fn consent_batch(env: &Env, caller: &Address, batch_id: u64) -> Result<(), StreamError> {
    caller.require_auth();
    let mut proposal = get_batch_proposal(env, batch_id)
        .ok_or_else(|| surface::reject(Branch::BatchAmendmentNotFound))?;

    if proposal.executed {
        return Err(surface::reject(Branch::StreamNotActive));
    }
    let now = env.ledger().timestamp();
    if now >= proposal.expires_at {
        return Err(surface::reject(Branch::BatchAmendmentExpired));
    }

    // Check if caller is a stream recipient
    let mut is_recipient = false;
    let mut i = 0;
    while i < proposal.items.len() {
        let item = proposal.items.get(i).unwrap();
        if let Ok(stream) = get_stream(env, item.stream_id) {
            if stream.recipient == *caller {
                is_recipient = true;
                break;
            }
        }
        i += 1;
    }

    if is_recipient {
        if !proposal.recipient_consents.contains(caller) {
            proposal.recipient_consents.push_back(caller.clone());
        }
    } else {
        // Co-signer for sender multisig
        if !proposal.signers.contains(caller) {
            proposal.signers.push_back(caller.clone());
        }
    }

    put_batch_proposal(env, &proposal);
    Ok(())
}

/// Apply a consented batch amendment atomically. All-or-nothing: any validation failure aborts.
pub fn apply_batch(env: &Env, caller: &Address, batch_id: u64) -> Result<(), StreamError> {
    caller.require_auth();
    let mut proposal = get_batch_proposal(env, batch_id)
        .ok_or_else(|| surface::reject(Branch::BatchAmendmentNotFound))?;

    if proposal.executed {
        return Err(surface::reject(Branch::StreamNotActive));
    }
    let now = env.ledger().timestamp();
    if now >= proposal.expires_at {
        return Err(surface::reject(Branch::BatchAmendmentExpired));
    }

    // Verify threshold
    if proposal.signers.len() < proposal.threshold {
        return Err(surface::reject(Branch::BatchAmendmentThresholdNotMet));
    }

    // Verify all stream recipients consented and all streams remain valid
    let mut stream_ids = Vec::new(env);
    let mut i = 0;
    while i < proposal.items.len() {
        let item = proposal.items.get(i).unwrap();
        let stream = get_stream(env, item.stream_id)?;
        if stream.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if get_paused_at(env, item.stream_id).is_some() {
            return Err(surface::reject(Branch::BatchAmendmentStreamPaused));
        }
        if now >= stream.end_time {
            return Err(surface::reject(Branch::BatchAmendmentExpired));
        }
        if !proposal.recipient_consents.contains(&stream.recipient) {
            return Err(surface::reject(Branch::BatchAmendmentRecipientNotConsented));
        }
        let log = get_amendment_log(env, item.stream_id);
        if log.len() >= MAX_AMENDMENTS {
            return Err(surface::reject(Branch::BatchAmendmentTooManyAmendments));
        }
        stream_ids.push_back(item.stream_id);
        i += 1;
    }

    // All checks passed! Now apply effects (CEI: all checks done first, effects atomic)
    let mut j = 0;
    while j < proposal.items.len() {
        let item = proposal.items.get(j).unwrap();
        let mut stream = get_stream(env, item.stream_id)?;
        let duration = stream.end_time.saturating_sub(stream.start_time).max(1) as i128;
        let old_rate = stream.deposit / duration;
        let old_end_time = stream.end_time;

        stream.end_time = item.new_end_time;
        put_stream(env, &stream);

        let mut log = get_amendment_log(env, item.stream_id);
        log.push_back(AmendmentRecord {
            old_rate,
            new_rate: item.new_rate,
            old_end_time,
            new_end_time: item.new_end_time,
            effective_timestamp: now,
        });
        put_amendment_log(env, item.stream_id, &log);
        j += 1;
    }

    proposal.executed = true;
    put_batch_proposal(env, &proposal);

    BatchAmendmentApplied {
        batch_id,
        stream_ids,
        effective_timestamp: now,
    }
    .publish(env);

    Ok(())
}
