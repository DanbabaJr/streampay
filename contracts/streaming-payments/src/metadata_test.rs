//! Tests for hash-linked metadata attestations (`attach_metadata`).
//!
//! Covers both-party attribution, the double-attestation policy (append, never
//! overwrite), size guards (tag length and per-stream cap), authorization,
//! events, the per-stream list, and the per-party index — in both directions.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Event as _, IntoVal, String as SdkString,
};

use crate::test::{Fixture, DAY};
use crate::{
    Attestation, AttestationRef, MetadataAttached, StreamError, MAX_ATTESTATIONS_PER_STREAM,
    MAX_TAG_LEN,
};

fn hash(env: &soroban_sdk::Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn tag(env: &soroban_sdk::Env, s: &str) -> SdkString {
    SdkString::from_str(env, s)
}

/// A tag of exactly `len` bytes (`"a"`,`"aa"`… not needed — repeated `'a'`).
fn tag_of_len(env: &soroban_sdk::Env, len: usize) -> SdkString {
    let s: std::string::String = "a".repeat(len);
    SdkString::from_str(env, &s)
}

// --- happy path & both-party attribution ------------------------------------

#[test]
fn sender_attaches_metadata_and_reads_it_back() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let content = hash(&f.env, 0xAB);
    let label = tag(&f.env, "invoice-0042");
    let now = f.env.ledger().timestamp();

    let index = f
        .client
        .mock_all_auths()
        .attach_metadata(&f.sender, &id, &content, &label);
    assert_eq!(index, 0);
    assert_eq!(f.client.attestation_count(&id), 1);

    let list = f.client.stream_attestations(&id, &0, &10);
    assert_eq!(list.len(), 1);
    let a = list.get(0).unwrap();
    assert_eq!(
        a,
        Attestation {
            index: 0,
            attester: f.sender.clone(),
            content_hash: content.clone(),
            tag: label.clone(),
            timestamp: now,
        }
    );
}

#[test]
fn recipient_can_attest_and_attribution_is_preserved() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, true);
    let content = hash(&f.env, 0x01);
    let label = tag(&f.env, "payslip");

    let index = f
        .client
        .mock_all_auths()
        .attach_metadata(&f.recipient, &id, &content, &label);
    assert_eq!(index, 0);
    let a = f.client.stream_attestations(&id, &0, &10).get(0).unwrap();
    assert_eq!(a.attester, f.recipient);
}

// --- append-only double attestation -----------------------------------------

#[test]
fn double_attestation_appends_and_never_overwrites() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);

    let first_hash = hash(&f.env, 0x11);
    let second_hash = hash(&f.env, 0x22);

    let i0 =
        f.client
            .mock_all_auths()
            .attach_metadata(&f.sender, &id, &first_hash, &tag(&f.env, "v1"));
    let i1 = f.client.mock_all_auths().attach_metadata(
        &f.recipient,
        &id,
        &second_hash,
        &tag(&f.env, "v2"),
    );

    assert_eq!((i0, i1), (0, 1));
    assert_eq!(f.client.attestation_count(&id), 2);

    let list = f.client.stream_attestations(&id, &0, &10);
    // Both entries survive, in order; the first is byte-identical to what was
    // stored (nothing was overwritten).
    assert_eq!(list.get(0).unwrap().content_hash, first_hash);
    assert_eq!(list.get(0).unwrap().tag, tag(&f.env, "v1"));
    assert_eq!(list.get(0).unwrap().attester, f.sender);
    assert_eq!(list.get(1).unwrap().content_hash, second_hash);
    assert_eq!(list.get(1).unwrap().tag, tag(&f.env, "v2"));
    assert_eq!(list.get(1).unwrap().attester, f.recipient);
}

#[test]
fn identical_hash_can_be_attested_twice() {
    // Re-attesting the same hash is allowed and simply appends a second entry;
    // the policy forbids overwriting, not duplication.
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let content = hash(&f.env, 0x33);
    let label = tag(&f.env, "dup");

    let i0 = f
        .client
        .mock_all_auths()
        .attach_metadata(&f.sender, &id, &content, &label);
    let i1 = f
        .client
        .mock_all_auths()
        .attach_metadata(&f.recipient, &id, &content, &label);
    assert_eq!((i0, i1), (0, 1));
    assert_eq!(f.client.attestation_count(&id), 2);
}

// --- size guards ------------------------------------------------------------

#[test]
fn oversized_tag_is_rejected() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let content = hash(&f.env, 0x44);
    let too_long = tag_of_len(&f.env, (MAX_TAG_LEN + 1) as usize);

    let err = f
        .client
        .mock_all_auths()
        .try_attach_metadata(&f.sender, &id, &content, &too_long)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MetadataTagTooLong);
    // Nothing was stored by the rejected attempt.
    assert_eq!(f.client.attestation_count(&id), 0);
}

#[test]
fn max_length_and_empty_tags_are_accepted() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let content = hash(&f.env, 0x55);

    let at_limit = tag_of_len(&f.env, MAX_TAG_LEN as usize);
    f.client
        .mock_all_auths()
        .attach_metadata(&f.sender, &id, &content, &at_limit);
    f.client
        .mock_all_auths()
        .attach_metadata(&f.sender, &id, &content, &tag(&f.env, ""));

    let list = f.client.stream_attestations(&id, &0, &10);
    assert_eq!(list.get(0).unwrap().tag.len(), MAX_TAG_LEN);
    assert_eq!(list.get(1).unwrap().tag.len(), 0);
}

#[test]
fn per_stream_limit_is_enforced() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let content = hash(&f.env, 0x66);

    for i in 0..MAX_ATTESTATIONS_PER_STREAM {
        let index =
            f.client
                .mock_all_auths()
                .attach_metadata(&f.sender, &id, &content, &tag(&f.env, "x"));
        assert_eq!(index, i);
    }
    assert_eq!(f.client.attestation_count(&id), MAX_ATTESTATIONS_PER_STREAM);

    let err = f
        .client
        .mock_all_auths()
        .try_attach_metadata(&f.sender, &id, &content, &tag(&f.env, "x"))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MetadataLimitReached);
    assert_eq!(f.client.attestation_count(&id), MAX_ATTESTATIONS_PER_STREAM);
}

// --- authorization & existence ----------------------------------------------

#[test]
fn non_party_cannot_attach() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let stranger = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_attach_metadata(&stranger, &id, &hash(&f.env, 0x77), &tag(&f.env, "x"))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
    assert_eq!(f.client.attestation_count(&id), 0);
}

#[test]
fn attaching_to_unknown_stream_reverts() {
    let f = Fixture::setup();
    let err = f
        .client
        .mock_all_auths()
        .try_attach_metadata(&f.sender, &999, &hash(&f.env, 0x88), &tag(&f.env, "x"))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotFound);
}

#[test]
fn attach_requires_attester_authorization() {
    // An attacker "signs" the call but names the real sender as attester; the
    // sender's authorization was never granted.
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let content = hash(&f.env, 0x99);
    let label = tag(&f.env, "x");
    let attacker = Address::generate(&f.env);

    f.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "attach_metadata",
            args: (f.sender.clone(), id, content.clone(), label.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_attach_metadata(&f.sender, &id, &content, &label)
        .is_err());
    assert_eq!(f.client.attestation_count(&id), 0);
}

#[test]
fn attach_is_allowed_on_a_cancelled_stream() {
    // Attestation is historical bookkeeping: a party may still attach metadata
    // after the stream reaches a terminal state.
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, true);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let index = f.client.mock_all_auths().attach_metadata(
        &f.sender,
        &id,
        &hash(&f.env, 0xAA),
        &tag(&f.env, "final"),
    );
    assert_eq!(index, 0);
}

// --- pagination & counts ----------------------------------------------------

#[test]
fn stream_attestations_paginate_in_attach_order() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    for i in 0..5u8 {
        f.client.mock_all_auths().attach_metadata(
            &f.sender,
            &id,
            &hash(&f.env, i),
            &tag_of_len(&f.env, i as usize),
        );
    }

    let page = f.client.stream_attestations(&id, &1, &2);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().index, 1);
    assert_eq!(page.get(1).unwrap().index, 2);

    // zero limit → empty page, no error.
    assert!(f.client.stream_attestations(&id, &0, &0).is_empty());
    // offset past the end → empty page.
    assert!(f.client.stream_attestations(&id, &99, &10).is_empty());
    // oversized limit clamps to MAX_PAGE_SIZE (only 5 exist).
    assert_eq!(f.client.stream_attestations(&id, &0, &u32::MAX).len(), 5);
}

#[test]
fn attestation_count_is_zero_for_unknown_stream() {
    let f = Fixture::setup();
    assert_eq!(f.client.attestation_count(&999), 0);
}

// --- per-party index (both parties) -----------------------------------------

#[test]
fn party_index_records_attestations_for_both_parties() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);

    // Sender attaches one; recipient attaches another.
    f.client.mock_all_auths().attach_metadata(
        &f.sender,
        &id,
        &hash(&f.env, 0xA1),
        &tag(&f.env, "s"),
    );
    f.client.mock_all_auths().attach_metadata(
        &f.recipient,
        &id,
        &hash(&f.env, 0xB2),
        &tag(&f.env, "r"),
    );

    let expected = soroban_sdk::Vec::from_slice(
        &f.env,
        &[
            AttestationRef {
                stream_id: id,
                index: 0,
            },
            AttestationRef {
                stream_id: id,
                index: 1,
            },
        ],
    );
    // Both parties see every attestation on the stream, regardless of who
    // attached it.
    assert_eq!(f.client.party_attestations(&f.sender, &0, &10), expected);
    assert_eq!(f.client.party_attestations(&f.recipient, &0, &10), expected);
}

#[test]
fn party_index_paginates_and_is_empty_for_unknown_address() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    for _ in 0..3 {
        f.client.mock_all_auths().attach_metadata(
            &f.sender,
            &id,
            &hash(&f.env, 0xC3),
            &tag(&f.env, "x"),
        );
    }

    let page = f.client.party_attestations(&f.sender, &1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().index, 1);

    let other = Address::generate(&f.env);
    assert!(f.client.party_attestations(&other, &0, &10).is_empty());
}

// --- events -----------------------------------------------------------------

#[test]
fn metadata_attached_event_has_expected_payload() {
    let f = Fixture::setup();
    let id = f.create_stream(1_000_000, DAY, 10 * DAY, false);
    let content = hash(&f.env, 0xD4);
    let label = tag(&f.env, "invoice-9");

    // Drain the StreamCreated event so the next read covers only the attach.
    let _ = f.env.events().all();

    let index = f
        .client
        .mock_all_auths()
        .attach_metadata(&f.sender, &id, &content, &label);
    let expected = MetadataAttached {
        stream_id: id,
        index,
        attester: f.sender.clone(),
        content_hash: content.clone(),
        tag: label.clone(),
        timestamp: f.env.ledger().timestamp(),
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [expected.to_xdr(&f.env, &f.client.address)],
    );
}
