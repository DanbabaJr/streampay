use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::errors::StreamError;
use crate::events::{PowerAccrued, VoteCast};
use crate::stream::{TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

/// 180 days in seconds for voting power half-life decay.
pub const DEFAULT_DECAY_WINDOW_SECONDS: u64 = 180 * 24 * 60 * 60;
/// Whale cap: maximum power a single stream can yield.
pub const DEFAULT_MAX_POWER_PER_STREAM: u128 = 10_000_000_000;
/// Whale cap: maximum total power any participant can hold.
pub const DEFAULT_MAX_PARTICIPANT_POWER: u128 = 50_000_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettledStreamSummary {
    pub stream_id: u64,
    pub settled_value: i128,
    pub duration_seconds: u64,
    pub settled_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalTally {
    pub proposal_id: u64,
    pub for_power: u128,
    pub against_power: u128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VotingPowerCaps {
    pub max_power_per_stream: u128,
    pub max_participant_power: u128,
    pub decay_window_seconds: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VotingPowerDataKey {
    ParticipantSettled(Address),
    ProposalVote(u64, Address),
    ProposalTally(u64),
    Caps,
}

pub fn get_caps(env: &Env) -> VotingPowerCaps {
    env.storage()
        .instance()
        .get(&VotingPowerDataKey::Caps)
        .unwrap_or(VotingPowerCaps {
            max_power_per_stream: DEFAULT_MAX_POWER_PER_STREAM,
            max_participant_power: DEFAULT_MAX_PARTICIPANT_POWER,
            decay_window_seconds: DEFAULT_DECAY_WINDOW_SECONDS,
        })
}

pub fn set_caps(env: &Env, caps: &VotingPowerCaps) {
    env.storage().instance().set(&VotingPowerDataKey::Caps, caps);
}

pub fn get_participant_settled(env: &Env, participant: &Address) -> Vec<SettledStreamSummary> {
    env.storage()
        .persistent()
        .get(&VotingPowerDataKey::ParticipantSettled(participant.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn record_stream_settlement(
    env: &Env,
    participant: &Address,
    stream_id: u64,
    settled_value: i128,
    duration_seconds: u64,
    settled_at: u64,
) {
    // Zero settled value (e.g. immediate cancel) yields zero power and is not recorded
    if settled_value <= 0 || duration_seconds == 0 {
        return;
    }

    let mut history = get_participant_settled(env, participant);
    history.push_back(SettledStreamSummary {
        stream_id,
        settled_value,
        duration_seconds,
        settled_at,
    });

    let key = VotingPowerDataKey::ParticipantSettled(participant.clone());
    env.storage().persistent().set(&key, &history);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let power = calculate_stream_power(
        &get_caps(env),
        settled_value,
        duration_seconds,
        settled_at,
        env.ledger().timestamp(),
    );

    PowerAccrued {
        participant: participant.clone(),
        stream_id,
        power,
    }
    .publish(env);
}

pub fn calculate_stream_power(
    caps: &VotingPowerCaps,
    settled_value: i128,
    duration_seconds: u64,
    settled_at: u64,
    now: u64,
) -> u128 {
    if settled_value <= 0 || duration_seconds == 0 {
        return 0;
    }

    // Raw power = (settled_value * duration_seconds) / 10^7
    // Using checked math to prevent overflow
    let value_u128 = settled_value as u128;
    let duration_u128 = duration_seconds as u128;
    let raw = match value_u128.checked_mul(duration_u128) {
        Some(product) => product / 10_000_000,
        None => caps.max_power_per_stream,
    };
    let capped_stream = raw.min(caps.max_power_per_stream);

    // Recency decay: linear decay over decay_window_seconds
    let age = now.saturating_sub(settled_at);
    if age >= caps.decay_window_seconds {
        return 0;
    }

    let remaining_ratio = 10_000u128.saturating_sub(
        ((age as u128) * 10_000) / (caps.decay_window_seconds as u128),
    );

    (capped_stream * remaining_ratio) / 10_000
}

/// Compute total current voting power deterministically from participant's settled stream history.
pub fn compute_voting_power(env: &Env, participant: &Address) -> u128 {
    let history = get_participant_settled(env, participant);
    if history.is_empty() {
        return 0;
    }

    let caps = get_caps(env);
    let now = env.ledger().timestamp();
    let mut total_power: u128 = 0;

    let mut i = 0;
    while i < history.len() {
        let entry = history.get(i).unwrap();
        let p = calculate_stream_power(
            &caps,
            entry.settled_value,
            entry.duration_seconds,
            entry.settled_at,
            now,
        );
        total_power = total_power.saturating_add(p);
        i += 1;
    }

    total_power.min(caps.max_participant_power)
}

/// Cast a time-weighted vote on a governance proposal.
pub fn cast_vote(
    env: &Env,
    voter: &Address,
    proposal_id: u64,
    support: bool,
) -> Result<u128, StreamError> {
    voter.require_auth();

    if proposal_id == 0 {
        return Err(surface::reject(Branch::VotingPowerProposalNotFound));
    }

    // Check if already voted
    let vote_key = VotingPowerDataKey::ProposalVote(proposal_id, voter.clone());
    if env.storage().persistent().has(&vote_key) {
        return Err(surface::reject(Branch::VotingPowerAlreadyVoted));
    }

    let power = compute_voting_power(env, voter);
    if power == 0 {
        return Err(surface::reject(Branch::VotingPowerInsufficient));
    }

    // Record vote
    env.storage().persistent().set(&vote_key, &support);
    env.storage()
        .persistent()
        .extend_ttl(&vote_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    // Update tally
    let tally_key = VotingPowerDataKey::ProposalTally(proposal_id);
    let mut tally = env
        .storage()
        .persistent()
        .get(&tally_key)
        .unwrap_or(ProposalTally {
            proposal_id,
            for_power: 0,
            against_power: 0,
        });

    if support {
        tally.for_power = tally.for_power.saturating_add(power);
    } else {
        tally.against_power = tally.against_power.saturating_add(power);
    }

    env.storage().persistent().set(&tally_key, &tally);
    env.storage()
        .persistent()
        .extend_ttl(&tally_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    VoteCast {
        proposal_id,
        voter: voter.clone(),
        power,
        support,
    }
    .publish(env);

    Ok(power)
}

pub fn get_proposal_tally(env: &Env, proposal_id: u64) -> Option<ProposalTally> {
    env.storage()
        .persistent()
        .get(&VotingPowerDataKey::ProposalTally(proposal_id))
}
