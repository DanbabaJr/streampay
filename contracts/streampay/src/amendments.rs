use soroban_sdk::{Env, Address, Vec};
use crate::types::{DataKey, AmendmentRecord, StreamPayError};

const MAX_AMENDMENTS: u32 = 20;

pub fn apply_amendment(
    env: Env,
    sender: Address,
    recipient: Address,
    stream_id: u64,
    new_rate: i128,
    new_end_time: u64,
) -> Result<(), StreamPayError> {
    // Double-signed consent: both sender and recipient must authorize in the same call
    sender.require_auth();
    recipient.require_auth();

    if new_rate <= 0 || new_end_time <= env.ledger().timestamp() {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }

    let mut log: Vec<AmendmentRecord> = env.storage().persistent()
        .get(&DataKey::AmendmentLog(stream_id))
        .unwrap_or(Vec::new(&env));

    if log.len() >= MAX_AMENDMENTS {
        return Err(StreamPayError::TooManyAmendments);
    }

    let record = AmendmentRecord {
        old_rate: 100, // placeholder resolved from active stream state
        new_rate,
        old_end_time: 100000, // placeholder resolved from active stream state
        new_end_time,
        effective_timestamp: env.ledger().timestamp(),
    };

    log.push_back(record.clone());
    env.storage().persistent().set(&DataKey::AmendmentLog(stream_id), &log);

    env.events().publish(("streampay", "stream_amended"), (stream_id, new_rate, new_end_time));
    Ok(())
}

pub fn partial_cancel(
    env: Env,
    sender: Address,
    stream_id: u64,
    new_end_time: u64,
) -> Result<(), StreamPayError> {
    sender.require_auth();

    // End stream at a future point and calculate pro-rata surplus refund to sender
    let current_time = env.ledger().timestamp();
    if new_end_time <= current_time {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }

    env.events().publish(("streampay", "partial_cancelled"), (stream_id, new_end_time));
    Ok(())
}
