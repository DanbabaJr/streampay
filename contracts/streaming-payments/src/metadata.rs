//! Hash-linked metadata attestations.
//!
//! A party to a stream can attach a 32-byte content hash plus a short tag (for
//! example the SHA-256 of an invoice PDF the stream is paying). The contract
//! records *who claimed which hash, when* — it does not store the document and
//! it cannot verify that the document hashes to the value (that is the
//! verifier's job; see `docs/VERIFYING_ATTESTATIONS.md`).
//!
//! Attestations are append-only: a second attestation never overwrites a first
//! one, and every attach emits an event. Storage is size-bounded on three axes
//! (a fixed 32-byte hash, a [`MAX_TAG_LEN`]-byte tag, and at most
//! [`MAX_ATTESTATIONS_PER_STREAM`] entries per stream) so per-stream state cost
//! is capped.

use soroban_sdk::{contracttype, Address, BytesN, Env, String, Vec};

use crate::errors::StreamError;
use crate::stream::{DataKey, Stream, MAX_PAGE_SIZE, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

/// Maximum tag length in bytes (UTF-8). Tags are short human labels, not
/// payloads; the actual content stays off-chain.
pub const MAX_TAG_LEN: u32 = 32;

/// Maximum number of attestations recorded per stream. Bounds the storage cost
/// of a stream's attestation list; attaching does not overwrite or replace, so
/// a cap is the only way to bound growth.
pub const MAX_ATTESTATIONS_PER_STREAM: u32 = 32;

/// One hash-linked attestation on a stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attestation {
    /// Position in the stream's append-only list, starting at 0.
    pub index: u32,
    /// The party (sender or recipient) that attached this attestation.
    pub attester: Address,
    /// 32-byte content hash, e.g. SHA-256 of the referenced document.
    pub content_hash: BytesN<32>,
    /// Short caller-chosen tag (at most [`MAX_TAG_LEN`] bytes).
    pub tag: String,
    /// Ledger timestamp at which the attestation was recorded.
    pub timestamp: u64,
}

/// A pointer to one attestation, used by the per-party index.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationRef {
    pub stream_id: u64,
    pub index: u32,
}

/// Appends a validated attestation to a stream's list and indexes it under both
/// parties. Returns the new attestation's index.
///
/// The caller (`attach_metadata`) has already authorized `attester` and checked
/// that it is a party to the stream.
pub fn append(
    env: &Env,
    stream: &Stream,
    attester: &Address,
    content_hash: &BytesN<32>,
    tag: &String,
    timestamp: u64,
) -> Result<u32, StreamError> {
    let key = DataKey::Attestations(stream.id);
    let mut list: Vec<Attestation> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if list.len() >= MAX_ATTESTATIONS_PER_STREAM {
        return Err(surface::reject(Branch::AttachMetadataLimitReached));
    }

    let index = list.len();
    list.push_back(Attestation {
        index,
        attester: attester.clone(),
        content_hash: content_hash.clone(),
        tag: tag.clone(),
        timestamp,
    });
    env.storage().persistent().set(&key, &list);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    // Indexed by *both* parties, regardless of who attached it, so either side
    // can enumerate every attestation on their streams from their own address.
    let reference = AttestationRef {
        stream_id: stream.id,
        index,
    };
    push_party_ref(env, &stream.sender, &reference);
    push_party_ref(env, &stream.recipient, &reference);

    Ok(index)
}

fn push_party_ref(env: &Env, party: &Address, reference: &AttestationRef) {
    let key = DataKey::PartyAttestations(party.clone());
    let mut refs: Vec<AttestationRef> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    refs.push_back(reference.clone());
    env.storage().persistent().set(&key, &refs);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Number of attestations recorded for a stream (0 for an unknown stream).
pub fn attestation_count(env: &Env, stream_id: u64) -> u32 {
    let list: Option<Vec<Attestation>> = env
        .storage()
        .persistent()
        .get(&DataKey::Attestations(stream_id));
    list.map(|l| l.len()).unwrap_or(0)
}

/// One page of a stream's attestations, in attach order.
///
/// `limit` is clamped to [`MAX_PAGE_SIZE`]; an offset past the end (or an
/// unknown stream) yields an empty page rather than an error. Reading extends
/// the list's TTL so an actively-verified stream stays hot.
pub fn page_attestations(env: &Env, stream_id: u64, offset: u32, limit: u32) -> Vec<Attestation> {
    let key = DataKey::Attestations(stream_id);
    let storage = env.storage().persistent();
    let Some(list): Option<Vec<Attestation>> = storage.get(&key) else {
        return Vec::new(env);
    };
    storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let start = offset.min(list.len());
    let end = start
        .saturating_add(limit.min(MAX_PAGE_SIZE))
        .min(list.len());
    let mut page = Vec::new(env);
    let mut i = start;
    while i < end {
        if let Some(item) = list.get(i) {
            page.push_back(item);
        }
        i += 1;
    }
    page
}

/// One page of the attestation references recorded under a party's address.
pub fn page_party_attestations(
    env: &Env,
    party: &Address,
    offset: u32,
    limit: u32,
) -> Vec<AttestationRef> {
    let key = DataKey::PartyAttestations(party.clone());
    let storage = env.storage().persistent();
    let Some(refs): Option<Vec<AttestationRef>> = storage.get(&key) else {
        return Vec::new(env);
    };
    storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let start = offset.min(refs.len());
    let end = start
        .saturating_add(limit.min(MAX_PAGE_SIZE))
        .min(refs.len());
    let mut page = Vec::new(env);
    let mut i = start;
    while i < end {
        if let Some(item) = refs.get(i) {
            page.push_back(item);
        }
        i += 1;
    }
    page
}
