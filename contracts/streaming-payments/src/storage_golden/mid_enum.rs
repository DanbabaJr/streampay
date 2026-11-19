//! Mid-enum / discriminant pinning (issue #210 requirement 4).
//!
//! Soroban `#[contracttype]` enums ride the wire as
//! `ScVal::Vec([Symbol(VariantName), payload…])`: the variant *name* is the
//! discriminant and the element position is pinned by declaration order.
//! That makes these drifts invisible to Rust (the code compiles and its
//! semantics are unchanged) yet fatal on-ledger:
//!
//! * renaming a variant → old instances decode garbage or fail;
//! * inserting/removing a variant → payload positions shift for the cases
//!   that move;
//! * swapping a variant's payload order → same.
//!
//! This module proves by construction that the golden corpus catches all
//! three: the blobs pin the exact `vec[Symbol(…)]` form of every status
//! variant, the manifest diff flags a semantic shift by field name even
//! when the typed decode happily accepts it, and a wire form that is
//! *not* a valid enum encoding is rejected outright.

use std::format;
use std::panic;
use std::string::{String, ToString};
use std::vec;
use std::vec::Vec;

use soroban_sdk::xdr::{self, VecM};
use soroban_sdk::{Env, TryFromVal};

use crate::schedule::{IntentStatus, ScheduledIntent};
use crate::stream::{Stream, StreamStatus};

use super::{diff_fields, fields_of, fixtures_dir, read_manifest, read_record_bin};

/// `vec[Symbol(Name)]` — the v29 wire form of a unit enum variant.
fn enum_wire(name: &str) -> xdr::ScVal {
    let items: Vec<xdr::ScVal> = vec![xdr::ScVal::Symbol(xdr::ScSymbol(name.try_into().unwrap()))];
    xdr::ScVal::Vec(Some(xdr::ScVec(VecM::try_from(items).unwrap())))
}

fn stream_map(meta_file: &str) -> xdr::ScMap {
    let (_k, entry) = read_record_bin(&fixtures_dir().join(meta_file));
    let xdr::LedgerEntryData::ContractData(cd) = &entry.data else {
        panic!("not contract data");
    };
    match &cd.val {
        xdr::ScVal::Map(Some(m)) => m.clone(),
        other => panic!("{meta_file}: golden stream is not a map: {other:?}"),
    }
}

/// Status field lives in the alphabetically-sorted struct map; locate by
/// key symbol (binary search mirrors the SDK's own decoder).
fn status_slot(m: &xdr::ScMap) -> usize {
    let key = xdr::ScVal::Symbol(xdr::ScSymbol("status".try_into().unwrap()));
    m.binary_search_by_key(&&key, |e| &e.key)
        .unwrap_or_else(|_| panic!("golden stream map has no `status` field"))
}

/// The `status` entry, found by key instead of by index. An in-development
/// build that added a field since the corpus was cut shifts indexes after
/// its new key, and these assertions are about the status bytes, not about
/// where in the map they happen to sit.
fn status_entry(m: &xdr::ScMap) -> &xdr::ScMapEntry {
    let key = xdr::ScVal::Symbol(xdr::ScSymbol("status".try_into().unwrap()));
    m.0.iter()
        .find(|e| e.key == key)
        .unwrap_or_else(|| panic!("stream map has no `status` field"))
}

fn replace_status(m: &xdr::ScMap, new_val: xdr::ScVal) -> xdr::ScVal {
    let i = status_slot(m);
    let items: Vec<xdr::ScMapEntry> =
        m.0.iter()
            .enumerate()
            .map(|(j, e)| {
                if j == i {
                    xdr::ScMapEntry {
                        key: e.key.clone(),
                        val: new_val.clone(),
                    }
                } else {
                    e.clone()
                }
            })
            .collect();
    xdr::ScVal::Map(Some(xdr::ScMap(VecM::try_from(items).unwrap())))
}

fn decode_stream(bad: &xdr::ScVal) -> bool {
    panic::catch_unwind(|| {
        let env = Env::default();
        Stream::try_from_val(&env, bad).is_ok()
    })
    .unwrap_or(false)
}

fn decode_intent(bad: &xdr::ScVal) -> bool {
    panic::catch_unwind(|| {
        let env = Env::default();
        ScheduledIntent::try_from_val(&env, bad).is_ok()
    })
    .unwrap_or(false)
}

/// The golden stream records pin all three `StreamStatus` wire forms —
/// exactly, as bytes — so any variant rename or reordering shows up as a
/// corpus mismatch before it can ever touch mainnet state.
#[test]
fn stream_status_wire_forms_are_pinned() {
    let env = Env::default();
    let manifest = read_manifest();
    let stream_metas: Vec<_> = manifest
        .records
        .iter()
        .filter(|r| r.kind == "stream")
        .collect();
    assert!(
        stream_metas.len() >= 3,
        "expected at least three golden stream records"
    );

    let mut pinned: Vec<String> = Vec::new();
    for meta in &stream_metas {
        let status_render = meta
            .fields
            .get("status")
            .unwrap_or_else(|| panic!("{}: manifest has no status field", meta.file));
        // The render grammar writes unit enum variants as `vec[symbol:X]`.
        pinned.push(status_render.clone());

        let m = stream_map(&meta.file);
        let val = xdr::ScVal::Map(Some(m.clone()));
        let s = Stream::try_from_val(&env, &val)
            .unwrap_or_else(|e| panic!("{}: golden stream rejected: {e:?}", meta.file));
        let expected = match s.status {
            StreamStatus::Active => "Active",
            StreamStatus::Cancelled => "Cancelled",
            StreamStatus::Depleted => "Depleted",
        };
        assert_eq!(
            status_render,
            &format!("vec[symbol:{expected}]"),
            "{}: status wire form drifted",
            meta.file
        );
        // Byte-level: the decoded struct re-encodes to the identical wire
        // value for the status field specifically.
        let back: xdr::ScVal = (&s).try_into().unwrap();
        let xdr::ScVal::Map(Some(mb)) = back else {
            unreachable!()
        };
        assert_eq!(
            status_entry(&m).val,
            status_entry(&mb).val,
            "{}: status bytes changed through a decode/encode cycle",
            meta.file
        );
        assert_eq!(
            status_entry(&m).val,
            enum_wire(expected),
            "{}: status is not the pinned unit-variant encoding",
            meta.file
        );
    }
    for want in [
        "vec[symbol:Active]",
        "vec[symbol:Cancelled]",
        "vec[symbol:Depleted]",
    ] {
        assert!(
            pinned.contains(&want.to_string()),
            "golden corpus must pin stream status {want}, got {pinned:?}"
        );
    }
}

/// Intent statuses, same pinning for all four `IntentStatus` variants.
#[test]
fn intent_status_wire_forms_are_pinned() {
    let env = Env::default();
    let manifest = read_manifest();
    let intent_metas: Vec<_> = manifest
        .records
        .iter()
        .filter(|r| r.kind == "intent")
        .collect();
    let mut pinned: Vec<String> = Vec::new();
    for meta in &intent_metas {
        let render = meta
            .fields
            .get("status")
            .expect("intent status field in manifest");
        pinned.push(render.clone());
        let (_k, entry) = read_record_bin(&fixtures_dir().join(&meta.file));
        let xdr::LedgerEntryData::ContractData(cd) = &entry.data else {
            panic!("not contract data");
        };
        let i = ScheduledIntent::try_from_val(&env, &cd.val)
            .unwrap_or_else(|e| panic!("{}: golden intent rejected: {e:?}", meta.file));
        let expected = match i.status {
            IntentStatus::Pending => "Pending",
            IntentStatus::Executed => "Executed",
            IntentStatus::Cancelled => "Cancelled",
            IntentStatus::Expired => "Expired",
        };
        assert_eq!(render, &format!("vec[symbol:{expected}]"), "{}", meta.file);
    }
    for want in [
        "vec[symbol:Pending]",
        "vec[symbol:Executed]",
        "vec[symbol:Cancelled]",
        "vec[symbol:Expired]",
    ] {
        assert!(
            pinned.contains(&want.to_string()),
            "golden corpus must pin intent status {want}, got {pinned:?}"
        );
    }
}

/// The subtle case: a variant renamed in Rust but re-declared so that a
/// *different valid variant* occupies the old wire name (e.g. `Active`
/// redefined to stream like `Depleted` did). The typed decode succeeds —
/// the blob is perfectly valid for the new type — and only the manifest
/// field diff names the change. This is why the corpus carries a
/// field-level manifest, not just bytes.
#[test]
fn semantic_variant_shift_is_caught_even_when_decode_accepts_it() {
    let manifest = read_manifest();
    let meta = manifest
        .records
        .iter()
        .find(|r| {
            r.kind == "stream"
                && r.fields.get("status").map(String::as_str) == Some("vec[symbol:Active]")
        })
        .expect("a golden Active stream record");

    let m = stream_map(&meta.file);
    let shifted = replace_status(&m, enum_wire("Depleted"));

    // Decode accepts it: `Depleted` is a valid current variant…
    assert!(
        decode_stream(&shifted),
        "expected the typed decoder to accept a valid alternate variant"
    );
    // …but the field diff names it, exactly, as a status change.
    let got = fields_of(&Env::default(), "stream", &shifted);
    let ds = diff_fields(&meta.file, &meta.fields, &got);
    assert_eq!(ds.len(), 1, "expected exactly one field diff, got {ds:?}");
    assert!(
        ds[0].contains(".status:")
            && ds[0].contains("vec[symbol:Active]")
            && ds[0].contains("vec[symbol:Depleted]"),
        "diff must name the status field with both wire forms: {ds:?}"
    );
}

/// An unknown variant name on the wire (what a deleted/renamed variant
/// looks like to the old decoder) must fail the typed decode — proving the
/// corpus would reject a record the current build cannot represent.
#[test]
fn unknown_variant_is_rejected() {
    let manifest = read_manifest();
    let meta = manifest
        .records
        .iter()
        .find(|r| r.kind == "stream")
        .expect("golden stream record");
    let m = stream_map(&meta.file);

    let bogus = replace_status(&m, enum_wire("Streaming"));
    assert!(
        !decode_stream(&bogus),
        "an unknown StreamStatus variant must not decode"
    );
    let bogus_intent = {
        let im = {
            let (_k, entry) = read_record_bin(
                &fixtures_dir().join(
                    &manifest
                        .records
                        .iter()
                        .find(|r| r.kind == "intent")
                        .expect("golden intent record")
                        .file,
                ),
            );
            let xdr::LedgerEntryData::ContractData(cd) = &entry.data else {
                panic!("not contract data");
            };
            match &cd.val {
                xdr::ScVal::Map(Some(mm)) => mm.clone(),
                _ => panic!("not a map"),
            }
        };
        replace_status(&im, enum_wire("Paused"))
    };
    assert!(
        !decode_intent(&bogus_intent),
        "an unknown IntentStatus variant must not decode"
    );
}

/// A bare `Symbol(Name)` where the grammar requires
/// `Vec([Symbol(Name)])` (the pre-v29 ordinal-adjacent form) must be
/// rejected: the pinned encoding is the vec form, and a future SDK/macro
/// change that flipped the enum wire grammar without re-baselining would
/// otherwise silently pass semantic decode tests.
#[test]
fn bare_symbol_form_is_not_the_pinned_encoding() {
    let manifest = read_manifest();
    let meta = manifest
        .records
        .iter()
        .find(|r| r.kind == "stream")
        .expect("golden stream record");
    let m = stream_map(&meta.file);
    let bare = replace_status(
        &m,
        xdr::ScVal::Symbol(xdr::ScSymbol("Active".try_into().unwrap())),
    );
    assert!(
        !decode_stream(&bare),
        "status must ride as vec[Symbol(Name)], not a bare symbol"
    );
}
