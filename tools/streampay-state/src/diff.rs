//! `diff` sub-command: deterministic comparison of two state snapshots.
//!
//! # Contract
//!
//! * **Exit codes** — `0` identical, `1` differences found, `2` error
//!   (unreadable / unparseable / structurally invalid input, bad arguments).
//!   Nothing is written to stdout on exit code `2`.
//! * **Deterministic** — records are matched by key and visited in key order;
//!   fields in the order they are declared in `model.rs`. The same two inputs
//!   always produce byte-identical output.
//! * **Memory** — each snapshot is parsed once through the shared
//!   [`Snapshot`](crate::model::Snapshot) model and kept once. Records are
//!   sorted by reference (no record is cloned) and the two sorted views are
//!   merge-walked, writing every change to the output as it is found; the
//!   diff itself is never collected into memory. A first pass only counts.
//! * **Provenance** — `exported_at`, `rpc_url` and `latest_ledger` describe
//!   *how and when* a snapshot was taken and always differ between two RPC
//!   providers. They are reported but do not make the snapshots "different"
//!   unless `--include-provenance` is given.
//!
//! Output is a JSON report (`--format json`) or a human summary (`--format
//! text`, the default, like `verify`).

use std::cmp::Ordering;
use std::fmt;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};

use anyhow::{anyhow, bail, Context};
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

use crate::model::{
    IndexEntry, ScheduledIntentEntry, Snapshot, StreamEntry, StreamFeeEntry, TreasuryEntry,
};

/// Version of the JSON report produced by `--format json`.
pub const DIFF_REPORT_VERSION: u32 = 1;

/// Output format of `diff`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Format {
    /// Human-readable summary (default).
    Text,
    /// JSON report on stdout.
    Json,
}

/// Result of a successful comparison; maps to the process exit code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Exit code 0.
    Identical,
    /// Exit code 1.
    Different,
}

// ── Values and keys ───────────────────────────────────────────────────────────

/// A field value. Amounts (`i128`) serialise as decimal strings, exactly like
/// `verify`'s report, because they can exceed JSON/JS safe integers.
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Uint(u64),
    Amount(i128),
    Bool(bool),
    Str(String),
    Ids(Vec<u64>),
}

impl Serialize for Val {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Val::Uint(n) => s.serialize_u64(*n),
            Val::Amount(n) => s.collect_str(n),
            Val::Bool(b) => s.serialize_bool(*b),
            Val::Str(v) => s.serialize_str(v),
            Val::Ids(v) => s.collect_seq(v),
        }
    }
}

impl fmt::Display for Val {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Val::Uint(n) => write!(f, "{n}"),
            Val::Amount(n) => write!(f, "{n}"),
            Val::Bool(b) => write!(f, "{b}"),
            Val::Str(v) => write!(f, "{v}"),
            Val::Ids(v) => write!(f, "{v:?}"),
        }
    }
}

/// The identity of a record within its family. Ordering is the output order.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Id(u64),
    Str(String),
    /// A fee record is identified by its stream *and* token.
    Fee(u64, String),
}

impl Serialize for Key {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Key::Id(n) => s.serialize_u64(*n),
            Key::Str(v) => s.serialize_str(v),
            Key::Fee(id, token) => {
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("stream_id", id)?;
                m.serialize_entry("token", token)?;
                m.end()
            }
        }
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Key::Id(n) => write!(f, "{n}"),
            Key::Str(v) => write!(f, "{v}"),
            Key::Fee(id, token) => write!(f, "{id}/{token}"),
        }
    }
}

/// Fields in declaration order, serialised as a JSON object.
struct Fields(Vec<(&'static str, Val)>);

impl Serialize for Fields {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (name, value) in &self.0 {
            m.serialize_entry(name, value)?;
        }
        m.end()
    }
}

/// A snapshot row that can be keyed and compared field by field.
trait Record {
    fn key(&self) -> Key;
    fn fields(&self) -> Vec<(&'static str, Val)>;
}

fn s(v: &str) -> Val {
    Val::Str(v.to_string())
}

impl Record for StreamEntry {
    fn key(&self) -> Key {
        Key::Id(self.id)
    }
    fn fields(&self) -> Vec<(&'static str, Val)> {
        vec![
            ("sender", s(&self.sender)),
            ("recipient", s(&self.recipient)),
            ("token", s(&self.token)),
            ("deposit", Val::Amount(self.deposit)),
            ("withdrawn", Val::Amount(self.withdrawn)),
            ("start_time", Val::Uint(self.start_time)),
            ("end_time", Val::Uint(self.end_time)),
            ("cancelable", Val::Bool(self.cancelable)),
            ("status", s(&self.status)),
        ]
    }
}

impl Record for ScheduledIntentEntry {
    fn key(&self) -> Key {
        Key::Id(self.id)
    }
    fn fields(&self) -> Vec<(&'static str, Val)> {
        vec![
            ("sender", s(&self.sender)),
            ("recipient", s(&self.recipient)),
            ("token", s(&self.token)),
            ("deposit", Val::Amount(self.deposit)),
            ("start_time", Val::Uint(self.start_time)),
            ("end_time", Val::Uint(self.end_time)),
            ("cancelable", Val::Bool(self.cancelable)),
            ("interval", Val::Uint(self.interval)),
            (
                "occurrences_total",
                Val::Uint(self.occurrences_total.into()),
            ),
            (
                "occurrences_remaining",
                Val::Uint(self.occurrences_remaining.into()),
            ),
            ("fee_budget", Val::Amount(self.fee_budget)),
            ("execute_after", Val::Uint(self.execute_after)),
            ("expires_at", Val::Uint(self.expires_at)),
            ("params_hash", s(&self.params_hash)),
            ("status", s(&self.status)),
        ]
    }
}

impl Record for TreasuryEntry {
    fn key(&self) -> Key {
        Key::Str(self.token.clone())
    }
    fn fields(&self) -> Vec<(&'static str, Val)> {
        vec![
            ("charged_total", Val::Amount(self.charged_total)),
            ("withdrawn_total", Val::Amount(self.withdrawn_total)),
        ]
    }
}

impl Record for StreamFeeEntry {
    fn key(&self) -> Key {
        Key::Fee(self.stream_id, self.token.clone())
    }
    fn fields(&self) -> Vec<(&'static str, Val)> {
        vec![("amount", Val::Amount(self.amount))]
    }
}

impl Record for IndexEntry {
    fn key(&self) -> Key {
        Key::Str(self.address.clone())
    }
    fn fields(&self) -> Vec<(&'static str, Val)> {
        // Index lists are append-only and creation-ordered, so order is data.
        vec![("stream_ids", Val::Ids(self.stream_ids.clone()))]
    }
}

// ── Change events ─────────────────────────────────────────────────────────────

struct Delta {
    field: &'static str,
    from: Val,
    to: Val,
}

enum Event<'a, R> {
    Added(&'a R),
    Removed(&'a R),
    Changed { key: Key, deltas: Vec<Delta> },
}

/// Sorts `rows` by key, by reference, and rejects duplicate keys: with two
/// rows claiming one identity there is no meaningful "changed" answer.
fn sorted<'a, R: Record>(rows: &'a [R], side: &str, family: &str) -> anyhow::Result<Vec<&'a R>> {
    let mut v: Vec<&R> = rows.iter().collect();
    v.sort_by_cached_key(|r| r.key());
    for pair in v.windows(2) {
        if pair[0].key() == pair[1].key() {
            bail!(
                "snapshot {side} is invalid: duplicate {family} key {} (run `verify` on it)",
                pair[0].key()
            );
        }
    }
    Ok(v)
}

fn deltas<R: Record>(a: &R, b: &R) -> Vec<Delta> {
    a.fields()
        .into_iter()
        .zip(b.fields())
        .filter(|((_, x), (_, y))| x != y)
        .map(|((field, from), (_, to))| Delta { field, from, to })
        .collect()
}

/// Merge-walks two key-sorted views, calling `emit` once per difference, in
/// key order. Allocates nothing proportional to the number of differences.
fn walk<R: Record>(
    a: &[&R],
    b: &[&R],
    mut emit: impl FnMut(Event<'_, R>) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        let order = match (a.get(i), b.get(j)) {
            (Some(x), Some(y)) => x.key().cmp(&y.key()),
            (Some(_), None) => Ordering::Less,
            _ => Ordering::Greater,
        };
        match order {
            Ordering::Less => {
                emit(Event::Removed(a[i]))?;
                i += 1;
            }
            Ordering::Greater => {
                emit(Event::Added(b[j]))?;
                j += 1;
            }
            Ordering::Equal => {
                let d = deltas(a[i], b[j]);
                if !d.is_empty() {
                    emit(Event::Changed {
                        key: a[i].key(),
                        deltas: d,
                    })?;
                }
                i += 1;
                j += 1;
            }
        }
    }
    Ok(())
}

// ── Header (non-record) fields ────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Describes contract state: always counts as a difference.
    State,
    /// Describes how/when the snapshot was taken.
    Provenance,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::State => "state",
            Kind::Provenance => "provenance",
        }
    }
}

fn header(snap: &Snapshot) -> Vec<(&'static str, Kind, Val)> {
    vec![
        (
            "schema_version",
            Kind::State,
            Val::Uint(snap.schema_version.into()),
        ),
        (
            "schema_fingerprint",
            Kind::State,
            s(&snap.schema_fingerprint),
        ),
        ("contract_id", Kind::State, s(&snap.contract_id)),
        (
            "contract_schema_version",
            Kind::State,
            Val::Uint(snap.contract_schema_version.into()),
        ),
        (
            "contract_frozen",
            Kind::State,
            Val::Bool(snap.contract_frozen),
        ),
        ("governor", Kind::State, s(&snap.governor)),
        ("exported_at", Kind::Provenance, Val::Uint(snap.exported_at)),
        ("rpc_url", Kind::Provenance, s(&snap.rpc_url)),
        (
            "latest_ledger",
            Kind::Provenance,
            Val::Uint(snap.latest_ledger),
        ),
    ]
}

struct HeaderChange {
    field: &'static str,
    kind: Kind,
    from: Val,
    to: Val,
}

fn header_changes(a: &Snapshot, b: &Snapshot) -> Vec<HeaderChange> {
    header(a)
        .into_iter()
        .zip(header(b))
        .filter(|((_, _, x), (_, _, y))| x != y)
        .map(|((field, kind, from), (_, _, to))| HeaderChange {
            field,
            kind,
            from,
            to,
        })
        .collect()
}

// ── Families ──────────────────────────────────────────────────────────────────

const FAMILIES: [&str; 6] = [
    "streams",
    "scheduled_intents",
    "treasuries",
    "stream_fees",
    "sender_indexes",
    "recipient_indexes",
];

#[derive(Default, Clone, Copy)]
struct Counts {
    added: usize,
    removed: usize,
    changed: usize,
}

impl Counts {
    fn total(&self) -> usize {
        self.added + self.removed + self.changed
    }
}

/// One family of one snapshot pair, key-sorted and validated.
struct Pair<'a, R> {
    name: &'static str,
    a: Vec<&'a R>,
    b: Vec<&'a R>,
}

fn pair<'a, R: Record>(name: &'static str, a: &'a [R], b: &'a [R]) -> anyhow::Result<Pair<'a, R>> {
    Ok(Pair {
        name,
        a: sorted(a, "A", name)?,
        b: sorted(b, "B", name)?,
    })
}

fn count<R: Record>(p: &Pair<'_, R>) -> anyhow::Result<Counts> {
    let mut c = Counts::default();
    walk(&p.a, &p.b, |ev| {
        match ev {
            Event::Added(_) => c.added += 1,
            Event::Removed(_) => c.removed += 1,
            Event::Changed { .. } => c.changed += 1,
        }
        Ok(())
    })?;
    Ok(c)
}

// ── Output ────────────────────────────────────────────────────────────────────

/// Writes the diff as it is discovered. JSON arrays are built by hand so the
/// element stream never needs to be buffered.
struct Out<W: Write> {
    w: W,
    format: Format,
    first_change: bool,
}

impl<W: Write> Out<W> {
    fn json<T: Serialize>(&mut self, v: &T) -> anyhow::Result<()> {
        serde_json::to_writer(&mut self.w, v)?;
        Ok(())
    }

    fn change_json<T: Serialize>(&mut self, v: &T) -> anyhow::Result<()> {
        if self.first_change {
            self.first_change = false;
            write!(self.w, "\n    ")?;
        } else {
            write!(self.w, ",\n    ")?;
        }
        self.json(v)
    }

    fn emit<R: Record>(&mut self, family: &'static str, ev: Event<'_, R>) -> anyhow::Result<()> {
        match (self.format, ev) {
            (Format::Json, Event::Added(r)) => self.change_json(&JsonAdd {
                family,
                change: "added",
                key: r.key(),
                record: Fields(r.fields()),
            }),
            (Format::Json, Event::Removed(r)) => self.change_json(&JsonAdd {
                family,
                change: "removed",
                key: r.key(),
                record: Fields(r.fields()),
            }),
            (Format::Json, Event::Changed { key, deltas }) => self.change_json(&JsonChanged {
                family,
                change: "changed",
                key,
                fields: deltas
                    .iter()
                    .map(|d| JsonDelta {
                        field: d.field,
                        from: &d.from,
                        to: &d.to,
                    })
                    .collect(),
            }),
            (Format::Text, Event::Added(r)) => {
                writeln!(self.w, "  + {family} {}", r.key())?;
                for (name, v) in r.fields() {
                    writeln!(self.w, "      {name}: {v}")?;
                }
                Ok(())
            }
            (Format::Text, Event::Removed(r)) => {
                writeln!(self.w, "  - {family} {}", r.key())?;
                for (name, v) in r.fields() {
                    writeln!(self.w, "      {name}: {v}")?;
                }
                Ok(())
            }
            (Format::Text, Event::Changed { key, deltas }) => {
                writeln!(self.w, "  ~ {family} {key}")?;
                for d in deltas {
                    writeln!(self.w, "      {}: {} -> {}", d.field, d.from, d.to)?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Serialize)]
struct JsonAdd {
    family: &'static str,
    change: &'static str,
    key: Key,
    record: Fields,
}

#[derive(Serialize)]
struct JsonChanged<'a> {
    family: &'static str,
    change: &'static str,
    key: Key,
    fields: Vec<JsonDelta<'a>>,
}

#[derive(Serialize)]
struct JsonDelta<'a> {
    field: &'static str,
    from: &'a Val,
    to: &'a Val,
}

#[derive(Serialize)]
struct JsonHeader<'a> {
    field: &'static str,
    kind: &'static str,
    from: &'a Val,
    to: &'a Val,
}

#[derive(Serialize)]
struct JsonCounts {
    added: usize,
    removed: usize,
    changed: usize,
}

impl From<Counts> for JsonCounts {
    fn from(c: Counts) -> Self {
        JsonCounts {
            added: c.added,
            removed: c.removed,
            changed: c.changed,
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn load(path: &str, side: &str) -> anyhow::Result<Snapshot> {
    let file = File::open(path).with_context(|| format!("cannot read snapshot {side} ({path})"))?;
    serde_json::from_reader(BufReader::new(file))
        .map_err(|e| anyhow!("cannot parse snapshot {side} ({path}): {e}"))
}

/// Compares two snapshot files and writes the report to stdout.
///
/// Any error is returned **before** a byte is written, so a failed run never
/// leaves a half-written report behind.
pub fn run(
    path_a: &str,
    path_b: &str,
    format: Format,
    include_provenance: bool,
) -> anyhow::Result<Outcome> {
    let a = load(path_a, "A")?;
    let b = load(path_b, "B")?;
    let stdout = std::io::stdout();
    let out = BufWriter::new(stdout.lock());
    diff_to(&a, &b, (path_a, path_b), format, include_provenance, out)
}

fn diff_to<W: Write>(
    a: &Snapshot,
    b: &Snapshot,
    paths: (&str, &str),
    format: Format,
    include_provenance: bool,
    w: W,
) -> anyhow::Result<Outcome> {
    // Validate and index everything first, so errors precede all output.
    let streams = pair("streams", &a.streams, &b.streams)?;
    let intents = pair(
        "scheduled_intents",
        &a.scheduled_intents,
        &b.scheduled_intents,
    )?;
    let treasuries = pair("treasuries", &a.treasuries, &b.treasuries)?;
    let fees = pair("stream_fees", &a.stream_fees, &b.stream_fees)?;
    let senders = pair("sender_indexes", &a.sender_indexes, &b.sender_indexes)?;
    let recipients = pair(
        "recipient_indexes",
        &a.recipient_indexes,
        &b.recipient_indexes,
    )?;

    // Pass 1: counts only.
    let counts = [
        count(&streams)?,
        count(&intents)?,
        count(&treasuries)?,
        count(&fees)?,
        count(&senders)?,
        count(&recipients)?,
    ];
    let hdr = header_changes(a, b);
    let counted = |k: Kind| hdr.iter().filter(|h| h.kind == k).count();
    let state_changes = counted(Kind::State);
    let provenance_changes = counted(Kind::Provenance);
    let record_changes: usize = counts.iter().map(Counts::total).sum();
    let differs =
        record_changes > 0 || state_changes > 0 || (include_provenance && provenance_changes > 0);

    // Pass 2: stream the report.
    let mut out = Out {
        w,
        format,
        first_change: true,
    };
    match format {
        Format::Json => {
            write!(
                out.w,
                "{{\n  \"report_version\": {DIFF_REPORT_VERSION},\n  \"identical\": {},\n  \"include_provenance\": {include_provenance},\n  \"inputs\": ",
                !differs
            )?;
            out.json(&serde_json::json!({ "a": paths.0, "b": paths.1 }))?;
            write!(out.w, ",\n  \"summary\": {{\n    \"header\": ")?;
            out.json(&serde_json::json!({
                "state_changed": state_changes,
                "provenance_changed": provenance_changes,
            }))?;
            write!(out.w, ",\n    \"families\": {{")?;
            for (n, (name, c)) in FAMILIES.iter().zip(counts).enumerate() {
                write!(out.w, "{}\n      ", if n == 0 { "" } else { "," })?;
                out.json(name)?;
                write!(out.w, ": ")?;
                out.json(&JsonCounts::from(c))?;
            }
            write!(out.w, "\n    }}\n  }},\n  \"header\": [")?;
            for (n, h) in hdr.iter().enumerate() {
                write!(out.w, "{}\n    ", if n == 0 { "" } else { "," })?;
                out.json(&JsonHeader {
                    field: h.field,
                    kind: h.kind.name(),
                    from: &h.from,
                    to: &h.to,
                })?;
            }
            write!(
                out.w,
                "{}],\n  \"changes\": [",
                if hdr.is_empty() { "" } else { "\n  " }
            )?;
        }
        Format::Text => {
            if differs {
                writeln!(out.w, "Snapshots differ.")?;
            } else {
                writeln!(out.w, "Snapshots are identical.")?;
            }
            writeln!(out.w, "  A: {}\n  B: {}", paths.0, paths.1)?;
            for (name, c) in FAMILIES.iter().zip(counts) {
                if c.total() > 0 {
                    writeln!(
                        out.w,
                        "  {name}: {} added, {} removed, {} changed",
                        c.added, c.removed, c.changed
                    )?;
                }
            }
            for h in &hdr {
                let note = match (h.kind, include_provenance) {
                    (Kind::Provenance, false) => " (provenance, ignored)",
                    (Kind::Provenance, true) => " (provenance)",
                    _ => "",
                };
                writeln!(out.w, "  {}: {} -> {}{note}", h.field, h.from, h.to)?;
            }
            if record_changes > 0 {
                writeln!(out.w, "\nChanges:")?;
            }
        }
    }

    stream_family(&mut out, &streams)?;
    stream_family(&mut out, &intents)?;
    stream_family(&mut out, &treasuries)?;
    stream_family(&mut out, &fees)?;
    stream_family(&mut out, &senders)?;
    stream_family(&mut out, &recipients)?;

    if format == Format::Json {
        writeln!(out.w, "{}]\n}}", if out.first_change { "" } else { "\n  " })?;
    }
    out.w.flush()?;

    Ok(if differs {
        Outcome::Different
    } else {
        Outcome::Identical
    })
}

fn stream_family<W: Write, R: Record>(out: &mut Out<W>, p: &Pair<'_, R>) -> anyhow::Result<()> {
    let name = p.name;
    walk(&p.a, &p.b, |ev| out.emit(name, ev))
}
