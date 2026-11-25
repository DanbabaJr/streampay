//! Storage layout and event schema compatibility guard.
//!
//! The contract's source-derived interface surface (storage key shapes, event
//! payloads, and the StreamError code list) is hashed into a fingerprint that is
//! committed in `schema/fingerprint.json`. A change to any of those fails this
//! test until it is deliberately re-blessed.
//!
//! The Wasm binary is deliberately NOT part of the fingerprint: it is not
//! committed, its bytes depend on toolchain and on whether a build ran first,
//! so a comparison against it is not reproducible from git.
//!
//! Bless procedure (from the repo root):
//!   npm run schema:bless
//! Re-blessing a changed fingerprint is a wire-visible change and must be
//! explained in the PR that carries it.
#![cfg(test)]

extern crate std;
use std::format;
use std::string::String;
use std::vec::Vec as StdVec;

use soroban_sdk::{
    testutils::Address as _,
    xdr::{ToXdr, WriteXdr},
    Address, BytesN, Env, Event as _, Symbol, Vec,
};

use crate::{
    errors::StreamError,
    events::*,
    governance::{GovernanceAction, GovernanceDataKey},
    policy::{PolicyDataKey, StreamPolicy},
    sponsor::SponsorKey,
    stream::{DataKey, OwnershipRole, WithdrawOutcome},
    StreamingPayments,
};

fn hex_str(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Generates the canonical schema fingerprint representation.
pub fn generate_schema_representation(env: &Env) -> serde_json::Value {
    let governor = Address::generate(env);
    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    let token = Address::generate(env);
    let keeper = Address::generate(env);
    let admin = Address::generate(env);
    let bytes32 = BytesN::from_array(env, &[1u8; 32]);
    let signers = Vec::from_array(env, [sender.clone(), recipient.clone()]);

    // ── 1. Storage keys probe (covers all 4 key enums in the contract) ──────
    let mut storage_keys_json = std::vec![];

    // DataKey probe (25 variants)
    let datakey_cases: StdVec<(&str, &str, &str, DataKey)> = std::vec![
        (
            "NextStreamId",
            "NextStreamId",
            "instance",
            DataKey::NextStreamId
        ),
        ("Stream", "Stream(u64)", "persistent", DataKey::Stream(1)),
        (
            "RecipientStreams",
            "RecipientStreams(Address)",
            "persistent",
            DataKey::RecipientStreams(recipient.clone())
        ),
        (
            "SenderStreams",
            "SenderStreams(Address)",
            "persistent",
            DataKey::SenderStreams(sender.clone())
        ),
        (
            "NextIntentId",
            "NextIntentId",
            "instance",
            DataKey::NextIntentId
        ),
        ("Intent", "Intent(u64)", "persistent", DataKey::Intent(1)),
        (
            "SenderIntents",
            "SenderIntents(Address)",
            "persistent",
            DataKey::SenderIntents(sender.clone())
        ),
        ("Governor", "Governor", "instance", DataKey::Governor),
        (
            "PendingGovernor",
            "PendingGovernor",
            "instance",
            DataKey::PendingGovernor
        ),
        ("FeeBps", "FeeBps", "instance", DataKey::FeeBps),
        (
            "Treasury",
            "Treasury(Address)",
            "persistent",
            DataKey::Treasury(token.clone())
        ),
        (
            "StreamFee",
            "StreamFee(u64)",
            "persistent",
            DataKey::StreamFee(1)
        ),
        (
            "SchemaVersion",
            "SchemaVersion",
            "instance",
            DataKey::SchemaVersion
        ),
        (
            "ContractFrozen",
            "ContractFrozen",
            "instance",
            DataKey::ContractFrozen
        ),
        (
            "PendingUpgrade",
            "PendingUpgrade",
            "instance",
            DataKey::PendingUpgrade
        ),
        (
            "MigrationCursor",
            "MigrationCursor",
            "instance",
            DataKey::MigrationCursor
        ),
        (
            "OracleConfig",
            "OracleConfig",
            "instance",
            DataKey::OracleConfig
        ),
        (
            "OracleReport",
            "OracleReport(Address)",
            "persistent",
            DataKey::OracleReport(sender.clone())
        ),
        (
            "PendingOwnership",
            "PendingOwnership(u64)",
            "persistent",
            DataKey::PendingOwnership(1)
        ),
        (
            "PendingRateChange",
            "PendingRateChange(u64)",
            "persistent",
            DataKey::PendingRateChange(1)
        ),
        (
            "RateSegments",
            "RateSegments(u64)",
            "persistent",
            DataKey::RateSegments(1)
        ),
        (
            "PendingSenderTransfer",
            "PendingSenderTransfer(u64)",
            "persistent",
            DataKey::PendingSenderTransfer(1)
        ),
        (
            "SenderHistory",
            "SenderHistory(u64)",
            "persistent",
            DataKey::SenderHistory(1)
        ),
        (
            "RefundTarget",
            "RefundTarget(u64)",
            "persistent",
            DataKey::RefundTarget(1)
        ),
        (
            "StreamPause",
            "StreamPause(u64)",
            "persistent",
            DataKey::StreamPause(1)
        ),
    ];

    let sponsor_key_cases: StdVec<(&str, &str, &str, SponsorKey)> = std::vec![
        (
            "SponsorConfig",
            "SponsorConfig(Address)",
            "persistent",
            SponsorKey::SponsorConfig(sender.clone())
        ),
        (
            "OperatorKey",
            "OperatorKey(Address)",
            "persistent",
            SponsorKey::OperatorKey(sender.clone())
        ),
        (
            "SponsorPeriod",
            "SponsorPeriod(Address)",
            "persistent",
            SponsorKey::SponsorPeriod(sender.clone())
        ),
        (
            "BeneficiaryKey",
            "BeneficiaryKey(Address)",
            "persistent",
            SponsorKey::BeneficiaryKey(recipient.clone())
        ),
        (
            "BeneficiarySpend",
            "BeneficiarySpend(Address, Address)",
            "persistent",
            SponsorKey::BeneficiarySpend(sender.clone(), recipient.clone())
        ),
        (
            "ClaimNonce",
            "ClaimNonce(Address, Address, u64)",
            "persistent",
            SponsorKey::ClaimNonce(sender.clone(), recipient.clone(), 1)
        ),
    ];

    let policy_key_cases: StdVec<(&str, &str, &str, PolicyDataKey)> = std::vec![
        ("Admin", "Admin", "instance", PolicyDataKey::Admin),
        (
            "PendingAdmin",
            "PendingAdmin",
            "instance",
            PolicyDataKey::PendingAdmin
        ),
        (
            "TimelockDelay",
            "TimelockDelay",
            "instance",
            PolicyDataKey::TimelockDelay
        ),
        (
            "Asset",
            "Asset(Address)",
            "persistent",
            PolicyDataKey::Asset(token.clone())
        ),
        (
            "QueuedAsset",
            "QueuedAsset(Address)",
            "persistent",
            PolicyDataKey::QueuedAsset(token.clone())
        ),
        (
            "StreamPolicy",
            "StreamPolicy(Address)",
            "persistent",
            PolicyDataKey::StreamPolicy(token.clone())
        ),
        (
            "GlobalStreamPolicy",
            "GlobalStreamPolicy",
            "instance",
            PolicyDataKey::GlobalStreamPolicy
        ),
    ];

    let gov_key_cases: StdVec<(&str, &str, &str, GovernanceDataKey)> = std::vec![
        ("Signers", "Signers", "instance", GovernanceDataKey::Signers),
        (
            "VetoWindow",
            "VetoWindow",
            "instance",
            GovernanceDataKey::VetoWindow
        ),
        (
            "ProposalCount",
            "ProposalCount",
            "instance",
            GovernanceDataKey::ProposalCount
        ),
        (
            "Proposal",
            "Proposal(u64)",
            "persistent",
            GovernanceDataKey::Proposal(1)
        ),
    ];

    env.as_contract(&contract_id, || {
        for (name, shape, storage_type, key) in &datakey_cases {
            if *storage_type == "instance" {
                env.storage().instance().set(key, &42u32);
                let read_back: u32 = env.storage().instance().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            } else {
                env.storage().persistent().set(key, &42u32);
                let read_back: u32 = env.storage().persistent().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            }

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "DataKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }

        for (name, shape, storage_type, key) in &sponsor_key_cases {
            env.storage().persistent().set(key, &42u32);
            let read_back: u32 = env.storage().persistent().get(key).unwrap();
            assert_eq!(read_back, 42u32);

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "SponsorKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }

        for (name, shape, storage_type, key) in &policy_key_cases {
            if *storage_type == "instance" {
                env.storage().instance().set(key, &42u32);
                let read_back: u32 = env.storage().instance().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            } else {
                env.storage().persistent().set(key, &42u32);
                let read_back: u32 = env.storage().persistent().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            }

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "PolicyDataKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }

        for (name, shape, storage_type, key) in &gov_key_cases {
            if *storage_type == "instance" {
                env.storage().instance().set(key, &42u32);
                let read_back: u32 = env.storage().instance().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            } else {
                env.storage().persistent().set(key, &42u32);
                let read_back: u32 = env.storage().persistent().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            }

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "GovernanceDataKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }
    });

    // ── 2. Events probe (all 51 contract events) ────────────────────────────
    struct EventCase {
        name: &'static str,
        topics: StdVec<(&'static str, &'static str)>,
        data: StdVec<(&'static str, &'static str)>,
        xdr_bytes: StdVec<u8>,
    }

    macro_rules! event_case {
        ($name:ident, topics: [$(($t_name:expr, $t_type:expr)),*], data: [$(($d_name:expr, $d_type:expr)),*], $instance:expr) => {{
            let ev = $instance;
            let contract_event = ev.to_xdr(env, &contract_id);
            let bytes = contract_event.to_xdr(soroban_sdk::xdr::Limits::none()).expect("event to xdr");
            EventCase {
                name: stringify!($name),
                topics: std::vec![$(($t_name, $t_type)),*],
                data: std::vec![$(($d_name, $d_type)),*],
                xdr_bytes: bytes,
            }
        }};
    }

    let event_cases = std::vec![
        event_case!(
            StreamCreated,
            topics: [("stream_id", "u64")],
            data: [
                ("sender", "Address"),
                ("recipient", "Address"),
                ("token", "Address"),
                ("deposit", "i128"),
                ("start_time", "u64"),
                ("end_time", "u64"),
                ("cancelable", "bool")
            ],
            StreamCreated {
                stream_id: 1,
                sender: sender.clone(),
                recipient: recipient.clone(),
                token: token.clone(),
                deposit: 1000,
                start_time: 100,
                end_time: 200,
                cancelable: true,
            }
        ),
        event_case!(
            StreamsCreated,
            topics: [("sender", "Address")],
            data: [("stream_ids", "Vec<u64>")],
            StreamsCreated {
                sender: sender.clone(),
                stream_ids: Vec::from_array(env, [1, 2]),
            }
        ),
        event_case!(
            Withdrawn,
            topics: [("stream_id", "u64")],
            data: [
                ("recipient", "Address"),
                ("amount", "i128"),
                ("withdrawn_total", "i128")
            ],
            Withdrawn {
                stream_id: 1,
                recipient: recipient.clone(),
                amount: 500,
                withdrawn_total: 500,
            }
        ),
        event_case!(
            StreamCancelled,
            topics: [("stream_id", "u64")],
            data: [
                ("cancelled_by", "Address"),
                ("recipient_amount", "i128"),
                ("sender_amount", "i128")
            ],
            StreamCancelled {
                stream_id: 1,
                cancelled_by: sender.clone(),
                recipient_amount: 300,
                sender_amount: 700,
            }
        ),
        event_case!(
            StreamToppedUp,
            topics: [("stream_id", "u64")],
            data: [
                ("sender", "Address"),
                ("amount", "i128"),
                ("new_deposit", "i128")
            ],
            StreamToppedUp {
                stream_id: 1,
                sender: sender.clone(),
                amount: 500,
                new_deposit: 1500,
            }
        ),
        event_case!(
            StreamScheduled,
            topics: [("intent_id", "u64")],
            data: [
                ("sender", "Address"),
                ("recipient", "Address"),
                ("token", "Address"),
                ("deposit", "i128"),
                ("start_time", "u64"),
                ("end_time", "u64"),
                ("cancelable", "bool"),
                ("interval", "u64"),
                ("occurrences", "u32"),
                ("fee_budget", "i128"),
                ("execute_after", "u64"),
                ("expires_at", "u64")
            ],
            StreamScheduled {
                intent_id: 1,
                sender: sender.clone(),
                recipient: recipient.clone(),
                token: token.clone(),
                deposit: 1000,
                start_time: 100,
                end_time: 200,
                cancelable: true,
                interval: 3600,
                occurrences: 5,
                fee_budget: 10,
                execute_after: 100,
                expires_at: 20000,
            }
        ),
        event_case!(
            ScheduledStreamExecuted,
            topics: [("intent_id", "u64")],
            data: [
                ("keeper", "Address"),
                ("stream_id", "u64"),
                ("occurrence_index", "u32"),
                ("occurrences_remaining", "u32"),
                ("fee_paid", "i128")
            ],
            ScheduledStreamExecuted {
                intent_id: 1,
                keeper: keeper.clone(),
                stream_id: 10,
                occurrence_index: 0,
                occurrences_remaining: 4,
                fee_paid: 10,
            }
        ),
        event_case!(
            ScheduledIntentCancelled,
            topics: [("intent_id", "u64")],
            data: [("sender", "Address"), ("refund", "i128")],
            ScheduledIntentCancelled {
                intent_id: 1,
                sender: sender.clone(),
                refund: 4040,
            }
        ),
        event_case!(
            ScheduledIntentExpired,
            topics: [("intent_id", "u64")],
            data: [("sender", "Address"), ("refund", "i128")],
            ScheduledIntentExpired {
                intent_id: 1,
                sender: sender.clone(),
                refund: 4040,
            }
        ),
        event_case!(
            FeeCharged,
            topics: [("stream_id", "u64")],
            data: [
                ("token", "Address"),
                ("payer", "Address"),
                ("amount", "i128"),
                ("fee_bps", "u32")
            ],
            FeeCharged {
                stream_id: 1,
                token: token.clone(),
                payer: sender.clone(),
                amount: 25,
                fee_bps: 25,
            }
        ),
        event_case!(
            FeeWithdrawn,
            topics: [("token", "Address")],
            data: [
                ("governor", "Address"),
                ("recipient", "Address"),
                ("amount", "i128"),
                ("withdrawn_total", "i128")
            ],
            FeeWithdrawn {
                token: token.clone(),
                governor: governor.clone(),
                recipient: recipient.clone(),
                amount: 100,
                withdrawn_total: 100,
            }
        ),
        event_case!(
            SponsorRegistered,
            topics: [("sponsor", "Address"), ("kind", "Symbol")],
            data: [
                ("token", "Address"),
                ("per_period_limit", "i128"),
                ("per_beneficiary_limit", "i128"),
                ("window_seconds", "u64")
            ],
            SponsorRegistered {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "registered"),
                token: token.clone(),
                per_period_limit: 10000,
                per_beneficiary_limit: 1000,
                window_seconds: 86400,
            }
        ),
        event_case!(
            SponsorActiveSet,
            topics: [("sponsor", "Address"), ("kind", "Symbol")],
            data: [("active", "bool")],
            SponsorActiveSet {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "active"),
                active: true,
            }
        ),
        event_case!(
            BeneficiaryEnrolled,
            topics: [("beneficiary", "Address"), ("kind", "Symbol")],
            data: [("public_key", "BytesN<32>")],
            BeneficiaryEnrolled {
                beneficiary: recipient.clone(),
                kind: Symbol::new(env, "enrolled"),
                public_key: bytes32.clone(),
            }
        ),
        event_case!(
            OperatorKeyRotated,
            topics: [("sponsor", "Address"), ("kind", "Symbol")],
            data: [("new_operator_key", "BytesN<32>")],
            OperatorKeyRotated {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "rotated"),
                new_operator_key: bytes32.clone(),
            }
        ),
        event_case!(
            SponsorClaim,
            topics: [("sponsor", "Address"), ("kind", "Symbol"), ("stream_id", "u64")],
            data: [
                ("beneficiary", "Address"),
                ("amount", "i128"),
                ("nonce", "u64")
            ],
            SponsorClaim {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "claim"),
                stream_id: 1,
                beneficiary: recipient.clone(),
                amount: 500,
                nonce: 1,
            }
        ),
        event_case!(
            PolicyInitialized,
            topics: [],
            data: [("admin", "Address")],
            PolicyInitialized { admin: admin.clone() }
        ),
        event_case!(
            PolicyAssetQueued,
            topics: [("asset", "Address")],
            data: [("allowed", "bool"), ("executable_after", "u64")],
            PolicyAssetQueued {
                asset: token.clone(),
                allowed: true,
                executable_after: 500,
            }
        ),
        event_case!(
            PolicyAssetExecuted,
            topics: [("asset", "Address")],
            data: [("allowed", "bool")],
            PolicyAssetExecuted {
                asset: token.clone(),
                allowed: true,
            }
        ),
        event_case!(
            PolicyHandoffProposed,
            topics: [("current_admin", "Address")],
            data: [("proposed_admin", "Address")],
            PolicyHandoffProposed {
                current_admin: admin.clone(),
                proposed_admin: sender.clone(),
            }
        ),
        event_case!(
            PolicyHandoffAccepted,
            topics: [("new_admin", "Address")],
            data: [],
            PolicyHandoffAccepted { new_admin: sender.clone() }
        ),
        event_case!(
            PolicyHandoffCancelled,
            topics: [("proposed_admin", "Address")],
            data: [],
            PolicyHandoffCancelled { proposed_admin: sender.clone() }
        ),
        event_case!(
            UpgradeProposed,
            topics: [("new_wasm_hash", "BytesN<32>")],
            data: [("unlock_time", "u64"), ("proposer", "Address")],
            UpgradeProposed {
                new_wasm_hash: bytes32.clone(),
                unlock_time: 1000,
                proposer: governor.clone(),
            }
        ),
        event_case!(
            UpgradeCancelled,
            topics: [("new_wasm_hash", "BytesN<32>")],
            data: [("cancelled_by", "Address")],
            UpgradeCancelled {
                new_wasm_hash: bytes32.clone(),
                cancelled_by: governor.clone(),
            }
        ),
        event_case!(
            ContractUpgraded,
            topics: [("new_wasm_hash", "BytesN<32>")],
            data: [("executed_by", "Address")],
            ContractUpgraded {
                new_wasm_hash: bytes32.clone(),
                executed_by: governor.clone(),
            }
        ),
        event_case!(
            ContractFrozenStateChanged,
            topics: [("frozen", "bool")],
            data: [("changed_by", "Address")],
            ContractFrozenStateChanged {
                frozen: true,
                changed_by: governor.clone(),
            }
        ),
        event_case!(
            StorageMigrated,
            topics: [("from_version", "u32"), ("to_version", "u32")],
            data: [
                ("start_id", "u64"),
                ("end_id", "u64"),
                ("is_complete", "bool")
            ],
            StorageMigrated {
                from_version: 1,
                to_version: 2,
                start_id: 1,
                end_id: 10,
                is_complete: true,
            }
        ),
        event_case!(
            StreamPolicySet,
            topics: [],
            data: [
                ("token", "Option<Address>"),
                ("old_policy", "Option<StreamPolicy>"),
                ("new_policy", "StreamPolicy")
            ],
            StreamPolicySet {
                token: Some(token.clone()),
                old_policy: None,
                new_policy: StreamPolicy {
                    min_rate: 1,
                    max_rate: 1000,
                    min_duration: 60,
                    max_duration: 86400,
                    min_deposit: 100,
                },
            }
        ),
        event_case!(
            OracleConfigUpdated,
            topics: [],
            data: [("threshold", "u32"), ("max_stale_seconds", "u64")],
            OracleConfigUpdated {
                threshold: 2,
                max_stale_seconds: 300,
            }
        ),
        event_case!(
            OracleTimeReported,
            topics: [("publisher", "Address")],
            data: [("reported_time", "u64"), ("ledger_time", "u64")],
            OracleTimeReported {
                publisher: sender.clone(),
                reported_time: 1000,
                ledger_time: 1005,
            }
        ),
        event_case!(
            OracleStaleFallback,
            topics: [("stream_id", "u64")],
            data: [("ledger_time", "u64")],
            OracleStaleFallback {
                stream_id: 1,
                ledger_time: 1005,
            }
        ),
        event_case!(
            OwnershipProposed,
            topics: [("stream_id", "u64")],
            data: [
                ("current_owner", "Address"),
                ("new_owner", "Address"),
                ("role", "OwnershipRole"),
                ("expires_at", "u64")
            ],
            OwnershipProposed {
                stream_id: 1,
                current_owner: sender.clone(),
                new_owner: recipient.clone(),
                role: OwnershipRole::Sender,
                expires_at: 10000,
            }
        ),
        event_case!(
            OwnershipAccepted,
            topics: [("stream_id", "u64")],
            data: [
                ("previous_owner", "Address"),
                ("new_owner", "Address"),
                ("role", "OwnershipRole")
            ],
            OwnershipAccepted {
                stream_id: 1,
                previous_owner: sender.clone(),
                new_owner: recipient.clone(),
                role: OwnershipRole::Sender,
            }
        ),
        event_case!(
            RateChangeProposed,
            topics: [("stream_id", "u64")],
            data: [
                ("proposed_by", "Address"),
                ("counterparty", "Address"),
                ("amount_per_second", "i128"),
                ("expires_at", "u64")
            ],
            RateChangeProposed {
                stream_id: 1,
                proposed_by: sender.clone(),
                counterparty: recipient.clone(),
                amount_per_second: 10,
                expires_at: 10000,
            }
        ),
        event_case!(
            RateChangeAccepted,
            topics: [("stream_id", "u64")],
            data: [
                ("accepted_by", "Address"),
                ("new_amount_per_second", "i128"),
                ("effective_from", "u64"),
                ("owed_at_change", "i128"),
                ("reserved_at_new_rate", "i128"),
                ("adjustment", "i128"),
                ("deposit", "i128")
            ],
            RateChangeAccepted {
                stream_id: 1,
                accepted_by: recipient.clone(),
                new_amount_per_second: 10,
                effective_from: 500,
                owed_at_change: 250,
                reserved_at_new_rate: 750,
                adjustment: 0,
                deposit: 1000,
            }
        ),
        event_case!(
            GovernanceSignersSet,
            topics: [("set_by", "Address")],
            data: [("signers", "Vec<Address>"), ("veto_window", "u64")],
            GovernanceSignersSet {
                set_by: governor.clone(),
                signers: signers.clone(),
                veto_window: 86400,
            }
        ),
        event_case!(
            GovernanceActionProposed,
            topics: [("proposal_id", "u64")],
            data: [
                ("proposed_by", "Address"),
                ("executable_at", "u64"),
                ("action", "GovernanceAction")
            ],
            GovernanceActionProposed {
                proposal_id: 1,
                proposed_by: sender.clone(),
                executable_at: 10000,
                action: GovernanceAction::SetFrozen(true),
            }
        ),
        event_case!(
            GovernanceActionSigned,
            topics: [("proposal_id", "u64")],
            data: [("signer", "Address"), ("signature_count", "u32")],
            GovernanceActionSigned {
                proposal_id: 1,
                signer: sender.clone(),
                signature_count: 1,
            }
        ),
        event_case!(
            GovernanceActionVetoed,
            topics: [("proposal_id", "u64")],
            data: [("vetoed_by", "Address")],
            GovernanceActionVetoed {
                proposal_id: 1,
                vetoed_by: recipient.clone(),
            }
        ),
        event_case!(
            GovernanceActionExecuted,
            topics: [("proposal_id", "u64")],
            data: [
                ("action", "GovernanceAction"),
                ("signers", "Vec<Address>"),
                ("executed_by", "Address")
            ],
            GovernanceActionExecuted {
                proposal_id: 1,
                action: GovernanceAction::SetFrozen(true),
                signers: signers.clone(),
                executed_by: sender.clone(),
            }
        ),
        event_case!(
            BatchWithdrawSummary,
            topics: [("recipient", "Address")],
            data: [
                ("settled", "Vec<WithdrawOutcome>"),
                ("total", "i128"),
                ("requested", "u32"),
                ("skipped", "u32")
            ],
            BatchWithdrawSummary {
                recipient: recipient.clone(),
                settled: Vec::from_array(
                    env,
                    [WithdrawOutcome {
                        stream_id: 1,
                        amount: 500,
                    }],
                ),
                total: 500,
                requested: 1,
                skipped: 0,
            }
        ),
        event_case!(
            StreamPaused,
            topics: [("stream_id", "u64")],
            data: [("paused_at", "u64")],
            StreamPaused {
                stream_id: 1,
                paused_at: 150,
            }
        ),
        event_case!(
            StreamResumed,
            topics: [("stream_id", "u64")],
            data: [("new_end_time", "u64")],
            StreamResumed {
                stream_id: 1,
                new_end_time: 250,
            }
        ),
        event_case!(
            DisputeRaised,
            topics: [("stream_id", "u64")],
            data: [
                ("recipient", "Address"),
                ("bond", "i128"),
                ("expires_at", "u64")
            ],
            DisputeRaised {
                stream_id: 1,
                recipient: recipient.clone(),
                bond: 50,
                expires_at: 1000,
            }
        ),
        event_case!(
            DisputeResolved,
            topics: [("stream_id", "u64")],
            data: [
                ("sender", "Address"),
                ("accept", "bool"),
                ("bond", "i128")
            ],
            DisputeResolved {
                stream_id: 1,
                sender: sender.clone(),
                accept: true,
                bond: 50,
            }
        ),
        event_case!(
            DisputeExpired,
            topics: [("stream_id", "u64")],
            data: [
                ("recipient", "Address"),
                ("bond", "i128"),
                ("sender_share", "i128"),
                ("recipient_share", "i128")
            ],
            DisputeExpired {
                stream_id: 1,
                recipient: recipient.clone(),
                bond: 50,
                sender_share: 25,
                recipient_share: 25,
            }
        ),
        event_case!(
            StreamRecordMigrated,
            topics: [("stream_id", "u64")],
            data: [
                ("from_version", "u32"),
                ("to_version", "u32")
            ],
            StreamRecordMigrated {
                stream_id: 1,
                from_version: 1,
                to_version: 2,
            }
        ),
        event_case!(
            SenderTransferProposed,
            topics: [("stream_id", "u64")],
            data: [
                ("sender_from", "Address"),
                ("new_sender", "Address"),
                ("nonce", "u64"),
                ("expires_at", "u64"),
                ("transfer_refund_rights", "bool")
            ],
            SenderTransferProposed {
                stream_id: 1,
                sender_from: sender.clone(),
                new_sender: recipient.clone(),
                nonce: 1,
                expires_at: 10000,
                transfer_refund_rights: false,
            }
        ),
        event_case!(
            SenderTransferred,
            topics: [("stream_id", "u64")],
            data: [
                ("sender_from", "Address"),
                ("sender_to", "Address"),
                ("nonce", "u64"),
                ("refund_rights_transferred", "bool")
            ],
            SenderTransferred {
                stream_id: 1,
                sender_from: sender.clone(),
                sender_to: recipient.clone(),
                nonce: 1,
                refund_rights_transferred: false,
            }
        ),
        event_case!(
            SenderTransferExpired,
            topics: [("stream_id", "u64")],
            data: [
                ("sender_from", "Address"),
                ("new_sender", "Address"),
                ("nonce", "u64")
            ],
            SenderTransferExpired {
                stream_id: 1,
                sender_from: sender.clone(),
                new_sender: recipient.clone(),
                nonce: 1,
            }
        ),
        event_case!(
            StreamRefundTargetChanged,
            topics: [("stream_id", "u64")],
            data: [
                ("previous_target", "Address"),
                ("new_target", "Address"),
                ("at_creation", "bool")
            ],
            StreamRefundTargetChanged {
                stream_id: 1,
                previous_target: sender.clone(),
                new_target: recipient.clone(),
                at_creation: false,
            }
        ),
    ];

    let mut events_json = std::vec![];
    for case in event_cases {
        let topics_arr: StdVec<serde_json::Value> = case
            .topics
            .iter()
            .map(|(n, t)| serde_json::json!({ "name": n, "type": t }))
            .collect();
        let data_arr: StdVec<serde_json::Value> = case
            .data
            .iter()
            .map(|(n, t)| serde_json::json!({ "name": n, "type": t }))
            .collect();
        events_json.push(serde_json::json!({
            "name": case.name,
            "topics": topics_arr,
            "data": data_arr,
            "xdr_sample_hex": hex_str(&case.xdr_bytes),
        }));
    }

    // ── 3. Error codes probe (all 99 codes) ─────────────────────────────────
    let mut error_codes_json = std::vec![];
    for err in StreamError::ALL {
        let code = err.code();
        let name = format!("{:?}", err);
        let retired = code == 2 || code == 3;
        error_codes_json.push(serde_json::json!({
            "code": code,
            "name": name,
            "retired": retired,
        }));
    }

    // ── 4. Canonical ordering ───────────────────────────────────────────────
    // The probe order is an implementation detail; the interface is the set of
    // (name, shape) pairs. Sorting keeps the fingerprint independent of it.
    storage_keys_json.sort_by(|a, b| {
        a["enum"]
            .as_str()
            .cmp(&b["enum"].as_str())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    events_json.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    error_codes_json.sort_by_key(|e| e["code"].as_u64());

    serde_json::json!({
        "$schema_version": 1,
        "storage_keys": storage_keys_json,
        "events": events_json,
        "error_codes": error_codes_json,
    })
}

/// Computes canonical SHA-256 fingerprint from the schema JSON.
pub fn compute_schema_fingerprint(env: &Env, schema_obj: &serde_json::Value) -> String {
    let mut canonical_obj = schema_obj.clone();
    if let Some(obj) = canonical_obj.as_object_mut() {
        obj.remove("fingerprint");
    }
    // serde_json objects are sorted maps; normalise CRLF so the hash cannot depend on the checkout.
    let canon_str = serde_json::to_string(&canonical_obj)
        .expect("canonical json")
        .replace("\r\n", "\n");
    let canon_bytes = soroban_sdk::Bytes::from_slice(env, canon_str.as_bytes());
    let sha = env.crypto().sha256(&canon_bytes);
    hex_str(&sha.to_array())
}

#[test]
fn schema_fingerprint_matches_stored() {
    let env = Env::default();
    env.mock_all_auths();

    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fingerprint_file = manifest_dir.join("../../schema/fingerprint.json");

    let generated = generate_schema_representation(&env);
    let fp = compute_schema_fingerprint(&env, &generated);

    if std::env::var("STREAMPAY_SCHEMA_BLESS").as_deref() == Ok("1") {
        let mut blessed = generated.clone();
        blessed["fingerprint"] = serde_json::Value::String(fp.clone());
        let formatted = serde_json::to_string_pretty(&blessed).expect("pretty json") + "\n";
        std::fs::create_dir_all(fingerprint_file.parent().expect("schema dir"))
            .expect("create schema dir");
        std::fs::write(&fingerprint_file, formatted).expect("write blessed fingerprint.json");
        std::println!("Blessed schema fingerprint: {}", fp);
        return;
    }

    let stored_raw = std::fs::read_to_string(&fingerprint_file).unwrap_or_else(|_| {
        panic!("schema/fingerprint.json does not exist. Run 'npm run schema:bless' to create it.")
    });
    // Normalise CRLF before parsing, so a Windows checkout cannot change the outcome.
    let stored: serde_json::Value = serde_json::from_str(&stored_raw.replace("\r\n", "\n"))
        .expect("parse stored fingerprint.json");
    let stored_fp = stored["fingerprint"].as_str().unwrap_or("");

    // The stored file must hash to its own recorded fingerprint, so a hand-edited
    // body or fingerprint is caught even when the source matches.
    assert_eq!(
        compute_schema_fingerprint(&env, &stored),
        stored_fp,
        "schema/fingerprint.json is internally inconsistent: its fingerprint does not match its body. Re-run 'npm run schema:bless'."
    );

    if stored_fp != fp {
        let mut diff_report = String::new();
        if generated["storage_keys"] != stored["storage_keys"] {
            diff_report
                .push_str("  [MISMATCH] Storage layout (keys / shapes / types / serialization)\n");
        }
        if generated["events"] != stored["events"] {
            diff_report.push_str("  [MISMATCH] Event payloads (event field names / topics / types / serialization)\n");
        }
        if generated["error_codes"] != stored["error_codes"] {
            diff_report
                .push_str("  [MISMATCH] Error codes (StreamError numeric codes or variants)\n");
        }

        panic!(
            "\n====================================================================\n\
             SCHEMA COMPATIBILITY GUARD FAILURE: CONTRACT INTERFACE CHANGED\n\
             ====================================================================\n\
             Stored fingerprint : {}\n\
             Generated          : {}\n\n\
             Divergence detected in:\n{}\n\
             StreamPay interfaces are append-only. If this change is intentional:\n\
               1. Confirm no existing wire shape, event, or error code was renamed, renumbered or removed.\n\
               2. Run 'npm run schema:bless' to update schema/fingerprint.json.\n\
               3. Explain the change in the PR description.\n\
             ====================================================================\n",
            stored_fp, fp, diff_report
        );
    }
}
