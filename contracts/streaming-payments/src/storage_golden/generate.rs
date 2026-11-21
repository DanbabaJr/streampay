//! Fixture generator: runs the canonical scenario and commits the exact
//! on-ledger XDR of every persisted record (plus one golden event per event
//! name) and the field-level manifest.
//!
//! Run with:
//! ```text
//! cargo test -p streampay-contract --lib storage_golden -- --ignored --nocapture
//! ```
//!
//! The generator pins the layout of the build it runs on; run it on the
//! release-line checkout when (re)baselining (see
//! `docs/STORAGE_LAYOUT.md`). The committed blobs are decoded forever after
//! by the in-development build via the `decode` tests.

use std::collections::{BTreeMap, BTreeSet};
use std::format;
use std::fs;
use std::println;
use std::string::{String, ToString};
use std::vec::Vec;

use soroban_sdk::xdr::{
    self, ContractDataEntry, LedgerEntry, LedgerEntryData, LedgerKey, LedgerKeyContractData,
    WriteXdr,
};
use soroban_sdk::Env;

use super::{
    events_dir, fields_of, fixtures_dir, kind_for_key, manifest_path, records_dir, render,
    sanitize, sc_address_contract_id, write_event_bin, write_record_bin, EventMeta, Manifest,
    RecordMeta,
};

/// Names come from the `#[contractevent]` snake-casing of the struct names.
/// The scenario must trigger every one, so the golden event set can never
/// silently shrink when an event is added.
pub(crate) fn expected_event_names() -> Vec<String> {
    [
        "stream_created",
        "streams_created",
        "withdrawn",
        "stream_cancelled",
        "stream_topped_up",
        "stream_scheduled",
        "scheduled_stream_executed",
        "scheduled_intent_cancelled",
        "scheduled_intent_expired",
        "fee_charged",
        "fee_withdrawn",
        "policy_initialized",
        "policy_asset_queued",
        "policy_asset_executed",
        "policy_handoff_proposed",
        "policy_handoff_accepted",
        "policy_handoff_cancelled",
        "upgrade_proposed",
        "upgrade_cancelled",
        "contract_upgraded",
        "contract_frozen_state_changed",
        "storage_migrated",
        "stream_policy_set",
        "stream_paused",
        "stream_resumed",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn snapshot_entries(s: &soroban_ledger_snapshot::LedgerSnapshot) -> Vec<(LedgerKey, LedgerEntry)> {
    s.ledger_entries
        .iter()
        .map(|(k, (e, _ttl))| ((**k).clone(), (**e).clone()))
        .collect()
}

/// Main-contract `ContractData` records from both snapshots. Snapshot A
/// wins on shared keys (it carries the frozen-state instance); snapshot B
/// contributes keys A lacks (the pending governor nominee).
///
/// Instance-storage keys are not ledger entries of their own — they live
/// inside the `contract_instance` value's storage map. The corpus pins each
/// one as a standalone record anyway (the inner key wrapped in a
/// `LedgerKey::ContractData`, value bytes untouched, durability labelled
/// `Instance`), so a layout change to an instance value fails with the
/// per-key name (`governor`, `fee_bps`, …) instead of only as one diff
/// buried inside the instance blob.
fn merged_records(
    env: &Env,
    target: &xdr::ContractId,
    snapshots: [&[(LedgerKey, LedgerEntry)]; 2],
) -> Vec<(String, String, LedgerKey, LedgerEntry, String)> {
    let mut seen: BTreeSet<Vec<u8>> = BTreeSet::new();
    let mut out = Vec::new();
    let mut per_kind: BTreeMap<String, u32> = BTreeMap::new();

    for (k, e) in snapshots[0].iter().chain(snapshots[1].iter()) {
        let LedgerKey::ContractData(lkcd) = k else {
            continue;
        };
        if sc_address_contract_id(&lkcd.contract) != Some(target) {
            continue;
        }
        let key_bytes = k.to_xdr(xdr::Limits::none()).unwrap();
        if !seen.insert(key_bytes) {
            continue;
        }
        let xdr::LedgerEntryData::ContractData(cd) = &e.data else {
            continue;
        };
        let Some(kind) = kind_for_key(env, &lkcd.key) else {
            panic!(
                "storage key {} is not a known DataKey/PolicyDataKey variant — the \
                 golden suite needs a new dispatch arm (see docs/STORAGE_LAYOUT.md)",
                render(env, &lkcd.key)
            );
        };
        let idx = per_kind.entry(kind.clone()).or_insert(0);
        let file = format!("{}_{:04}.bin", sanitize(&kind), *idx);
        *idx += 1;
        out.push((
            kind,
            file,
            k.clone(),
            e.clone(),
            format!("{:?}", cd.durability),
        ));
    }

    let (contract_addr, instance_keys) = instance_storage(env, target, snapshots);
    for (key, val) in instance_keys {
        let Some(kind) = kind_for_key(env, &key) else {
            panic!(
                "instance storage key {} is not a known DataKey/PolicyDataKey variant — \
                 the golden suite needs a new dispatch arm (see docs/STORAGE_LAYOUT.md)",
                render(env, &key)
            );
        };
        let ledger_key = LedgerKey::ContractData(LedgerKeyContractData {
            contract: contract_addr.clone(),
            durability: xdr::ContractDataDurability::Persistent,
            key: key.clone(),
        });
        let ledger_entry = LedgerEntry {
            last_modified_ledger_seq: 0,
            data: LedgerEntryData::ContractData(ContractDataEntry {
                ext: xdr::ExtensionPoint::V0,
                contract: contract_addr.clone(),
                key: key.clone(),
                durability: xdr::ContractDataDurability::Persistent,
                val,
            }),
            ext: xdr::LedgerEntryExt::V0,
        };
        let idx = per_kind.entry(kind.clone()).or_insert(0);
        let file = format!("{}_{:04}.bin", sanitize(&kind), *idx);
        *idx += 1;
        out.push((kind, file, ledger_key, ledger_entry, "Instance".to_string()));
    }

    out.sort_by(|x, y| x.1.cmp(&y.1));
    out
}

/// The target contract's instance-storage key/value pairs across both
/// snapshots, keyed by the rendered key so snapshot A wins per key and
/// snapshot B only adds the keys A does not carry.
fn instance_storage(
    env: &Env,
    target: &xdr::ContractId,
    snapshots: [&[(LedgerKey, LedgerEntry)]; 2],
) -> (xdr::ScAddress, Vec<(xdr::ScVal, xdr::ScVal)>) {
    let mut contract_addr: Option<xdr::ScAddress> = None;
    let mut by_render: BTreeMap<String, (xdr::ScVal, xdr::ScVal)> = BTreeMap::new();

    for (k, e) in snapshots[0].iter().chain(snapshots[1].iter()) {
        let LedgerKey::ContractData(lkcd) = k else {
            continue;
        };
        if lkcd.key != xdr::ScVal::LedgerKeyContractInstance
            || sc_address_contract_id(&lkcd.contract) != Some(target)
        {
            continue;
        }
        let xdr::LedgerEntryData::ContractData(cd) = &e.data else {
            continue;
        };
        let inst = instance_value(env, cd);
        contract_addr.get_or_insert_with(|| lkcd.contract.clone());
        for entry in inst
            .storage
            .as_ref()
            .map(|m| m.0.iter())
            .unwrap_or_default()
        {
            by_render
                .entry(render(env, &entry.key))
                .or_insert_with(|| (entry.key.clone(), entry.val.clone()));
        }
    }

    (
        contract_addr.expect("the contract instance entry must be in the snapshots"),
        by_render.into_values().collect(),
    )
}

fn instance_value(env: &Env, cd: &ContractDataEntry) -> xdr::ScContractInstance {
    match &cd.val {
        xdr::ScVal::ContractInstance(inst) => inst.clone(),
        other => panic!(
            "instance entry value is not a ContractInstance for {}: {other:?}",
            render(env, &cd.key)
        ),
    }
}

#[test]
#[ignore]
pub(crate) fn generate_golden_fixtures() {
    let out = super::scenario::run(None);
    // Stateless decode host, used only for labels/renders: the results are
    // functions of the blob bytes alone.
    let dec = Env::default();

    let snap_a = snapshot_entries(&out.snapshot_a);
    let snap_b = snapshot_entries(&out.snapshot_b);
    let target = super::contract_id(&out.env, &out.contract);
    let records = merged_records(&dec, &target, [&snap_a[..], &snap_b[..]]);

    // Start from an empty corpus: a kind whose instance count shrinks must
    // not leave a stale blob behind for the decode test to trip over.
    for dir in [records_dir(), events_dir()] {
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
    }

    let mut record_metas = Vec::new();
    for (kind, file, key, entry, durability) in &records {
        write_record_bin(&records_dir().join(file), key, entry).unwrap();
        let (key_sc, cd) = super::contract_data(key, entry);
        record_metas.push(RecordMeta {
            file: format!("records/{file}"),
            kind: kind.clone(),
            durability: durability.clone(),
            key: render(&dec, &key_sc),
            fields: fields_of(&dec, kind, &cd.val),
        });
    }

    // One golden event per event name, in emission-topic form.
    let mut event_metas = Vec::new();
    for (name, e) in &out.events {
        let xdr::ContractEventBody::V0(body) = &e.body;
        let topics = xdr::ScVec(body.topics.clone());
        let data = body.data.clone();
        let file = format!("{}.bin", sanitize(name));
        write_event_bin(&events_dir().join(&file), &topics, &data).unwrap();
        event_metas.push(EventMeta {
            file: format!("events/{file}"),
            name: name.clone(),
            topics: render(&dec, &xdr::ScVal::Vec(Some(topics))),
            data: render(&dec, &data),
            fields: fields_of(&dec, name, &data),
        });
    }

    let expected = expected_event_names();
    let missing: Vec<&String> = expected
        .iter()
        .filter(|n| !out.events.contains_key(*n))
        .collect();
    assert!(
        missing.is_empty(),
        "scenario did not emit expected events: {missing:?}"
    );
    let extra: Vec<&String> = out
        .events
        .keys()
        .filter(|n| !expected.contains(n))
        .collect();
    assert!(
        extra.is_empty(),
        "scenario emitted events with unknown names (new event? add it to \
         expected_event_names and the decode dispatch): {extra:?}"
    );

    let manifest = Manifest {
        records: record_metas,
        events: event_metas,
    };
    fs::write(
        manifest_path(),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    println!(
        "wrote {} records and {} events under {}",
        manifest.records.len(),
        manifest.events.len(),
        fixtures_dir().display()
    );
}
