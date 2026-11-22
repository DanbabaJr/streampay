//! Privacy Option: Commit-Reveal Claim Amounts (Issue #65).
//!
//! Lets a recipient hide individual claim amounts from real-time observers:
//! 1. Recipient calls `commit_claim` with a commitment hash = SHA256(stream_id, recipient, amount, salt)
//!    and a safety deposit.
//! 2. During the reveal window, recipient calls `reveal_claim` which settles the withdrawal and
//!    marks the commitment as revealed.
//! 3. Safety valve: if the reveal deadline passes without a reveal, `expire_reveal` allows the
//!    sender to reclaim the unrevealed deposit so funds are never stuck.

use soroban_sdk::{contractevent, contracttype, Address, Bytes, BytesN, Env};

use crate::errors::StreamError;
use crate::stream::{self, StreamStatus};
use crate::surface::{self, Branch};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimCommitted {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub commitment_hash: BytesN<32>,
    pub reveal_deadline: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimRevealed {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub commitment_hash: BytesN<32>,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimExpired {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub commitment_hash: BytesN<32>,
    pub deposit: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrivacyDataKey {
    Commitment(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimCommitment {
    pub stream_id: u64,
    pub recipient: Address,
    pub commitment_hash: BytesN<32>,
    pub deposit: i128,
    pub committed_at: u64,
    pub reveal_deadline: u64,
    pub revealed: bool,
}

pub fn compute_commitment_hash(
    env: &Env,
    stream_id: u64,
    recipient: &Address,
    amount: i128,
    salt: &BytesN<32>,
) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.append(&recipient.to_string().to_bytes());
    buf.extend_from_slice(&stream_id.to_be_bytes());
    buf.extend_from_slice(&amount.to_be_bytes());
    buf.append(&salt.to_bytes());
    env.crypto().sha256(&buf).to_bytes()
}

pub fn commit_claim(
    env: &Env,
    stream_id: u64,
    recipient: Address,
    commitment_hash: BytesN<32>,
    deposit: i128,
    reveal_deadline: u64,
) -> Result<(), StreamError> {
    recipient.require_auth();
    let s = stream::get_stream(env, stream_id)?;
    if s.recipient != recipient {
        return Err(surface::reject(Branch::CancelStreamNotAuthorized));
    }
    if s.status != StreamStatus::Active {
        return Err(surface::reject(Branch::StreamNotActive));
    }
    if reveal_deadline <= env.ledger().timestamp() {
        return Err(surface::reject(Branch::CreateInvalidTimeRange));
    }

    let key = PrivacyDataKey::Commitment(commitment_hash.clone());
    if env.storage().persistent().has(&key) {
        return Err(surface::reject(Branch::RaiseDisputeAlreadyActive));
    }

    let record = ClaimCommitment {
        stream_id,
        recipient: recipient.clone(),
        commitment_hash: commitment_hash.clone(),
        deposit,
        committed_at: env.ledger().timestamp(),
        reveal_deadline,
        revealed: false,
    };

    env.storage().persistent().set(&key, &record);

    ClaimCommitted {
        stream_id,
        recipient,
        commitment_hash,
        reveal_deadline,
    }
    .publish(env);

    Ok(())
}

pub fn reveal_claim(
    env: &Env,
    stream_id: u64,
    recipient: Address,
    amount: i128,
    salt: BytesN<32>,
) -> Result<ClaimCommitment, StreamError> {
    recipient.require_auth();
    if amount <= 0 {
        return Err(surface::reject(Branch::WithdrawAmountNonPositive));
    }

    let s = stream::get_stream(env, stream_id)?;
    if s.recipient != recipient {
        return Err(surface::reject(Branch::CancelStreamNotAuthorized));
    }

    let commitment_hash = compute_commitment_hash(env, stream_id, &recipient, amount, &salt);
    let key = PrivacyDataKey::Commitment(commitment_hash.clone());

    let mut record: ClaimCommitment = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or_else(|| surface::reject(Branch::ConditionNotFound))?;

    if record.revealed {
        return Err(surface::reject(Branch::ConditionNotFound));
    }

    if env.ledger().timestamp() > record.reveal_deadline {
        return Err(surface::reject(Branch::ClaimExpired));
    }

    record.revealed = true;
    env.storage().persistent().set(&key, &record);

    ClaimRevealed {
        stream_id,
        recipient,
        commitment_hash,
        amount,
    }
    .publish(env);

    Ok(record)
}

pub fn expire_reveal(
    env: &Env,
    stream_id: u64,
    commitment_hash: BytesN<32>,
    sender: Address,
) -> Result<i128, StreamError> {
    sender.require_auth();
    let s = stream::get_stream(env, stream_id)?;
    if s.sender != sender {
        return Err(surface::reject(Branch::CancelStreamNotAuthorized));
    }

    let key = PrivacyDataKey::Commitment(commitment_hash.clone());
    let record: ClaimCommitment = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or_else(|| surface::reject(Branch::ConditionNotFound))?;

    if record.revealed {
        return Err(surface::reject(Branch::ConditionNotFound));
    }

    if env.ledger().timestamp() <= record.reveal_deadline {
        return Err(surface::reject(Branch::ExpireDisputeTooEarly));
    }

    // Unresolved reveal safety valve: remove commitment and return refundable deposit
    env.storage().persistent().remove(&key);

    ClaimExpired {
        stream_id,
        sender,
        commitment_hash,
        deposit: record.deposit,
    }
    .publish(env);

    Ok(record.deposit)
}

pub fn get_commitment(env: &Env, commitment_hash: BytesN<32>) -> Option<ClaimCommitment> {
    let key = PrivacyDataKey::Commitment(commitment_hash);
    env.storage().persistent().get(&key)
}
