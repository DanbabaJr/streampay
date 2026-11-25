//! Upgrade replay (issue #210 requirement 3): boot the committed
//! baseline release wasm, write the canonical scenario's data through it,
//! upgrade the live instance to the in-development build through the
//! contract's own timelocked `execute_upgrade`, and read the same keys
//! back.
//!
//! Data-survival assertion set:
//! * every persistent `ContractData` record is byte-identical across the
//!   upgrade (key bytes incl. durability → value bytes);
//! * the instance flips exactly its executable hash and loses exactly the
//!   `PendingUpgrade` key the upgrade itself consumes — nothing else moves;
//! * post-upgrade, the in-development build's typed reads return exactly
//!   the records the scenario wrote through the baseline build;
//! * `execute_upgrade` emits `ContractUpgraded` with the dev wasm hash.

use std::collections::BTreeMap;
use std::eprintln;
use std::format;
use std::fs;
use std::string::{String, ToString};
use std::vec::Vec;

use soroban_sdk::testutils::{Events as _, Ledger as _};
use soroban_sdk::xdr::{self, ReadXdr, WriteXdr};
use soroban_sdk::{Bytes, Env};

use crate::stream::MIN_UPGRADE_DELAY_SECONDS;
use crate::test_client::StreamingPaymentsClient as Client;
use crate::{IntentStatus, StreamStatus};

use super::{
    baseline_wasm_path, contract_id, dev_wasm_path, events_from, render, sc_address_contract_id,
    scenario,
};

fn contract_data_of<'a>(
    k: &'a xdr::LedgerKey,
    e: &'a xdr::LedgerEntry,
) -> Option<(&'a xdr::LedgerKeyContractData, &'a xdr::ScVal)> {
    match (k, &e.data) {
        (xdr::LedgerKey::ContractData(lk), xdr::LedgerEntryData::ContractData(cd)) => {
            Some((lk, &cd.val))
        }
        _ => None,
    }
}

/// Main-contract persistent records: key bytes → value.
fn persistent_values(
    snap: &soroban_ledger_snapshot::LedgerSnapshot,
    target: &xdr::ContractId,
) -> BTreeMap<Vec<u8>, xdr::ScVal> {
    let mut out = BTreeMap::new();
    for (k, (e, _ttl)) in &snap.ledger_entries {
        let Some((lk, val)) = contract_data_of(k, e) else {
            continue;
        };
        if sc_address_contract_id(&lk.contract) != Some(target)
            || lk.durability != xdr::ContractDataDurability::Persistent
            // The instance entry is XDR-persistent too, but the upgrade
            // legitimately rewrites it (executable hash, consumed proposal);
            // `instance_state` asserts exactly what may move there.
            || lk.key == xdr::ScVal::LedgerKeyContractInstance
        {
            continue;
        }
        out.insert(
            xdr::LedgerKey::ContractData(lk.clone())
                .to_xdr(xdr::Limits::none())
                .unwrap(),
            val.clone(),
        );
    }
    out
}

/// A human-readable name for a persisted key: the rendered storage key when
/// the bytes decode, so a failure message says `vec[symbol:Stream,u64:3]`
/// rather than a byte prefix.
fn key_label(env: &Env, key_bytes: &[u8]) -> String {
    match xdr::LedgerKey::from_xdr(key_bytes, xdr::Limits::none()) {
        Ok(xdr::LedgerKey::ContractData(lk)) => render(env, &lk.key),
        _ => hex_preview(key_bytes),
    }
}

/// Field-for-field description of how one record value changed.
fn value_diff(env: &Env, label: &str, before: &xdr::ScVal, after: &xdr::ScVal) -> String {
    let g = super::fields_of(env, "", before);
    let a = super::fields_of(env, "", after);
    let diffs = super::diff_fields(label, &g, &a);
    if diffs.is_empty() {
        format!("{label}: field map matches but the wire bytes differ")
    } else {
        diffs.join("; ")
    }
}

/// The target contract's instance entry: its executable render plus its
/// storage map (ScVal key render → ScVal value render).
fn instance_state(
    snap: &soroban_ledger_snapshot::LedgerSnapshot,
    target: &xdr::ContractId,
) -> (String, BTreeMap<String, String>) {
    let env = Env::default();
    for (k, (e, _ttl)) in &snap.ledger_entries {
        let xdr::LedgerKey::ContractData(lk) = &**k else {
            continue;
        };
        if lk.key != xdr::ScVal::LedgerKeyContractInstance
            || sc_address_contract_id(&lk.contract) != Some(target)
        {
            continue;
        }
        let xdr::LedgerEntryData::ContractData(cd) = &e.data else {
            panic!("instance key without contract-data entry");
        };
        let xdr::ScVal::ContractInstance(inst) = &cd.val else {
            panic!("instance entry value is not a ContractInstance");
        };
        let executable = match &inst.executable {
            xdr::ContractExecutable::Wasm(h) => format!("wasm:{}", super::hex(&h.0)),
            other => format!("{other:?}"),
        };
        let mut storage = BTreeMap::new();
        if let Some(m) = &inst.storage {
            for ent in m.0.iter() {
                storage.insert(render(&env, &ent.key), render(&env, &ent.val));
            }
        }
        return (executable, storage);
    }
    panic!("no contract-instance entry for the scenario contract in the snapshot");
}

#[test]
fn upgrade_replay_preserves_every_record() {
    let baseline = fs::read(baseline_wasm_path()).unwrap_or_else(|e| {
        panic!(
            "missing baseline wasm {}: {e}",
            baseline_wasm_path().display()
        )
    });
    // The in-development artifact is produced by `stellar contract build`
    // (CI builds the wasm before running the test suite). When it is absent
    // locally, report a skip instead of failing a unit-test-only run — but
    // `STORAGE_GOLDEN_REQUIRE_WASM=1` (set in CI) turns the skip into a
    // failure, so the replay can never silently drop out of the gate.
    let dev = match fs::read(dev_wasm_path()) {
        Ok(dev) => dev,
        Err(e) => {
            let msg = format!(
                "no in-development wasm at {} ({e}); build it with `stellar contract build` \
                 (see docs/STORAGE_LAYOUT.md)",
                dev_wasm_path().display()
            );
            if std::env::var("STORAGE_GOLDEN_REQUIRE_WASM").is_ok() {
                panic!("{msg}");
            }
            eprintln!("SKIP upgrade_replay: {msg}");
            return;
        }
    };

    // 1. Boot the BASELINE wasm and write the full scenario through it.
    let out = scenario::run(Some(baseline.clone()));
    let env = out.env.clone();
    let contract = out.contract.clone();
    let client = Client::new(&env, &contract);
    let target = contract_id(&env, &contract);

    let pre = env.to_ledger_snapshot();
    let pre_values = persistent_values(&pre, &target);
    let (pre_exec, pre_storage) = instance_state(&pre, &target);
    assert!(
        !pre_values.is_empty(),
        "scenario wrote no persistent records"
    );
    assert!(
        pre_storage.keys().any(|k| k.contains("PendingUpgrade")),
        "scenario must leave a PendingUpgrade for the replay to execute"
    );

    // The instance must really be running the committed released bytecode.

    let baseline_hash = env
        .deployer()
        .upload_contract_wasm(Bytes::from_slice(&env, &baseline));
    assert_eq!(
        pre_exec,
        format!("wasm:{}", super::hex(&baseline_hash.to_array())),
        "the replay must boot the committed baseline wasm, not the host build"
    );

    // 2. Upload the in-development build and upgrade through the
    //    contract's own timelocked path (executed BY the baseline wasm).
    let dev_hash = env
        .deployer()
        .upload_contract_wasm(Bytes::from_slice(&env, &dev));
    client.propose_upgrade(&out.governor, &dev_hash, &MIN_UPGRADE_DELAY_SECONDS);
    env.ledger()
        .with_mut(|li| li.timestamp += MIN_UPGRADE_DELAY_SECONDS + 1);
    client.execute_upgrade(&out.governor);
    // Read the upgrade's events immediately: the host's event buffer reports
    // the most recent invocation, so a later read cannot see them.
    let upgrade_events = events_from(&env, &env.events().all(), &contract);

    // 3. Data survival: persistent records byte-identical.
    let post = env.to_ledger_snapshot();
    let post_values = persistent_values(&post, &target);

    let mut diffs: Vec<String> = Vec::new();
    for (k, before) in &pre_values {
        let label = key_label(&env, k);
        match post_values.get(k) {
            None => diffs.push(format!(
                "persistent record VANISHED across the upgrade: {label}"
            )),
            Some(after) => {
                let before_bytes = before.to_xdr(xdr::Limits::none()).unwrap();
                let after_bytes = after.to_xdr(xdr::Limits::none()).unwrap();
                if before_bytes != after_bytes {
                    diffs.push(format!(
                        "persistent record MUTATED across the upgrade: {} ({} bytes -> {} bytes): {}",
                        label,
                        before_bytes.len(),
                        after_bytes.len(),
                        value_diff(&env, &label, before, after),
                    ));
                }
            }
        }
    }
    for k in post_values.keys() {
        if !pre_values.contains_key(k) {
            diffs.push(format!(
                "new persistent record appeared across the upgrade: {}",
                key_label(&env, k)
            ));
        }
    }
    assert!(
        diffs.is_empty(),
        "upgrade-replay data-survival failures ({}):\n{}",
        diffs.len(),
        diffs.join("\n")
    );

    // 4. Instance: executable now points at the in-development build;
    //    exactly the PendingUpgrade key was consumed; nothing else moved.
    let (post_exec, post_storage) = instance_state(&post, &target);
    assert_eq!(
        post_exec,
        format!("wasm:{}", super::hex(&dev_hash.to_array())),
        "post-upgrade executable must be the in-development wasm"
    );
    if dev_hash == baseline_hash {
        // The in-development source is byte-identical to the captured
        // release build (a test-only or metadata change): the swap is a
        // no-op, and only the data-survival assertions above carry signal.
        eprintln!(
            "NOTE: in-development wasm equals the baseline artifact; the \
             upgrade replay still asserts data survival, but the executable \
             hash legitimately does not change."
        );
    } else {
        assert_ne!(pre_exec, post_exec, "upgrade must change the executable");
    }
    let removed: Vec<&String> = pre_storage
        .keys()
        .filter(|k| !post_storage.contains_key(*k))
        .collect();
    let added: Vec<&String> = post_storage
        .keys()
        .filter(|k| !pre_storage.contains_key(*k))
        .collect();
    assert_eq!(
        removed.len(),
        1,
        "upgrade must consume exactly the PendingUpgrade key: {removed:?}"
    );
    assert!(
        removed[0].contains("PendingUpgrade"),
        "unexpected instance key removed: {removed:?}"
    );
    assert!(
        added.is_empty(),
        "unexpected instance keys added: {added:?}"
    );
    for (k, v) in &pre_storage {
        if k.contains("PendingUpgrade") {
            continue;
        }
        assert_eq!(
            post_storage.get(k),
            Some(v),
            "instance storage changed across the upgrade: {k}"
        );
    }

    // 5. The in-development build reads back every scenario record with
    //    the exact typed values the scenario wrote.
    assert_eq!(client.schema_version(), 2);
    assert_eq!(client.total_streams(), 6);
    assert!(!client.is_frozen(), "the scenario ends unfrozen");
    for id in [out.s1, out.s2, out.s3, out.s4, out.s5, out.s6] {
        let s = client.get_stream(&id);
        assert_eq!(s.id, id, "stream identity changed across the upgrade");
    }
    assert_eq!(client.get_stream(&out.s1).status, StreamStatus::Active);
    assert_eq!(
        client.get_stream(&out.s2).status,
        StreamStatus::Cancelled,
        "cancelled stream status must survive the upgrade"
    );
    assert_eq!(
        client.get_stream(&out.s3).status,
        StreamStatus::Depleted,
        "depleted stream status must survive the upgrade"
    );
    assert_eq!(client.get_intent(&out.i1).status, IntentStatus::Executed);
    assert_eq!(client.get_intent(&out.i2).status, IntentStatus::Pending);
    assert_eq!(client.get_intent(&out.i3).status, IntentStatus::Cancelled);
    assert_eq!(client.get_intent(&out.i4).status, IntentStatus::Expired);
    assert_eq!(client.sender_intents(&out.sender, &0u32, &50u32).len(), 4);
    assert_eq!(
        client
            .recipient_streams(&out.recipient, &0u32, &50u32)
            .len(),
        5,
        "every stream the intent executions created must stay indexed"
    );
    assert_eq!(client.sender_streams(&out.sender, &0u32, &50u32).len(), 6);
    let other_streams = client.recipient_streams(&out.other_recipient, &0u32, &50u32);
    assert_eq!(other_streams.len(), 1);
    assert_eq!(
        other_streams.get(0).unwrap(),
        out.s6,
        "the batch-created stream must stay indexed for its recipient"
    );
    assert_eq!(
        client.policy_admin(),
        Some(out.new_admin.clone()),
        "the completed policy handoff must survive the upgrade"
    );
    assert!(
        client.policy_get_queued_asset(&out.token2).is_some(),
        "queued policy change must survive the upgrade"
    );
    assert!(
        !client.policy_is_asset_allowed(&out.token1),
        "executed allowlist removal must survive the upgrade"
    );
    assert_eq!(
        client.pending_upgrade(),
        None,
        "PendingUpgrade must be cleared by the executed upgrade"
    );
    let ts = client.treasury_status(&out.token1);
    assert!(
        ts.charged_total > 0 && ts.withdrawn_total > 0 && ts.withdrawn_total < ts.charged_total,
        "treasury accounting must survive: {ts:?}"
    );
    assert_eq!(
        ts.pending_governor,
        Some(out.governor2.clone()),
        "the pending governor nominee must survive the upgrade"
    );
    assert_eq!(client.stream_fee(&out.s1), 0, "zero-fee stream stays zero");
    assert!(
        client.stream_fee(&out.s3) > 0,
        "fee-charged stream keeps its fee record"
    );
    let mig = client.migration_progress();
    assert!(
        mig.is_complete && mig.cursor == 6 && mig.total_streams == 6,
        "migration progress must survive the upgrade: {mig:?}"
    );

    // 6. The upgrade emitted ContractUpgraded with the dev hash.
    let last = upgrade_events
        .last()
        .expect("execute_upgrade emitted no event for the target contract");
    let xdr::ContractEventBody::V0(body) = &last.body;
    let topics = body.topics.as_slice();
    assert_eq!(
        topics[0],
        xdr::ScVal::Symbol(xdr::ScSymbol("contract_upgraded".try_into().unwrap())),
        "last event after execute_upgrade must be ContractUpgraded"
    );
    // `new_wasm_hash` is a `#[topic]` field: the hash lives in topics[1],
    // and the payload keeps only `executed_by`.
    assert_eq!(
        topics.len(),
        2,
        "ContractUpgraded topic layout changed: {topics:?}"
    );
    assert_eq!(
        render(&env, &topics[1]),
        format!("bytes:{}", super::hex(&dev_hash.to_array())),
        "ContractUpgraded must carry the in-development wasm hash"
    );
    let data_fields = super::fields_of(&env, "contract_upgraded", &body.data);
    let names: Vec<String> = data_fields.keys().cloned().collect();
    assert_eq!(
        names.as_slice(),
        ["executed_by".to_string()].as_slice(),
        "ContractUpgraded payload layout changed: {data_fields:?}"
    );
}

fn hex_preview(bytes: &[u8]) -> String {
    let s = super::hex(bytes);
    s.chars().take(24).collect::<String>() + &format!("…({} bytes)", bytes.len())
}
