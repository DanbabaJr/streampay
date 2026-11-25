//! Event-schema registry.
//!
//! The `#[contractevent]` structs are a public interface: the indexer, the
//! frontend and third-party consumers decode them. This module extracts every
//! event shape straight from the crate sources (`syn`), and maintains the
//! committed registry under `schemas/events/`:
//!
//! * `schemas/events/registry.json` — the flat fingerprint table: one canonical
//!   shape (topic layout, data fields, Rust types, expanded struct definitions)
//!   and one SHA-256 fingerprint per event, plus the definitions it references.
//! * `schemas/events/v1/events/<event_key>.json` — one JSON Schema per event.
//! * `schemas/events/v1/catalog.json` — the v1 event list with fingerprints.
//!
//! Mirrors the `surface.rs` pattern: the *code* is the source of truth, the
//! artifact is generated, and a test pins them together.
//!
//! * `generate` (run with `--ignored`) rewrites `schemas/events/`. CI runs it
//!   and fails on any `git diff` of `schemas/`, so the registry can never
//!   drift from the contract.
//! * `registry_matches_contract_event_structs` re-derives the whole registry
//!   in-memory and compares it against the committed file field-for-field:
//!   adding, removing, renaming or re-typing an event field (or a field of a
//!   referenced struct/enum) without regenerating — and passing the CI
//!   compatibility gate — fails `cargo test`.
//! * `no_event_is_emitted_that_the_registry_does_not_declare` walks every
//!   `publish()` call site in the crate: an event that is not declared by a
//!   `#[contractevent]` struct cannot be published, and a declared event that
//!   nothing publishes is dropped from the registry. This is the event-side
//!   mirror of `surface.rs`, which forces every rejection branch to be declared.
//! * `every_contractevent_is_registered` proves the scan sees every
//!   `#[contractevent]` struct anywhere under `src/`, including ones that are
//!   never constructed by an existing test.
//!
//! Everything here is test-only: `syn`/`quote`/`sha2` are dev-dependencies and
//! nothing in this module reaches the Wasm build.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::format;
use std::path::{Path, PathBuf};
use std::string::{String, ToString};
use std::vec;
use std::vec::Vec;

use quote::ToTokens;
use sha2::{Digest, Sha256};
use syn::visit::Visit;
use syn::{File, Item, ItemStruct};

/// Version of the registry layout and canonical-fingerprint scheme. A change
/// here means consumers must re-read every schema; additive evolutions never
/// bump it (see `schemas/events/README.md`).
pub const REGISTRY_VERSION: u32 = 1;

/// Command that regenerates `schemas/events/`. Embedded in the artifacts so a
/// consumer can always tell how to refresh them.
pub const REGEN_COMMAND: &str =
    "cargo test -p streampay-contract --lib --locked event_registry::generate -- --ignored";

/// Schema id prefix for per-event JSON Schemas.
const SCHEMA_ID_BASE: &str = "https://streampay.dev/schemas/events";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .to_path_buf()
}

fn contract_src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// One named field of an event (or of a referenced struct definition).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct FieldSpec {
    name: String,
    ty: String,
}

/// A contract type referenced by an event field. Structs contribute their field
/// set; unit-variant enums (wire-encoded as symbols) contribute their variant
/// names; enums with payloads contribute each variant's positional payload
/// types. Either way the expansion is folded into every fingerprint that
/// references it, so changing the definition changes the event.
#[derive(Clone, Debug)]
enum DefKind {
    Struct(Vec<FieldSpec>),
    Enum(Vec<String>),
    PayloadEnum(Vec<VariantSpec>),
}

/// One variant of a payload-carrying `#[contracttype]` enum. Soroban encodes
/// such an enum as `[Symbol(variant), payload…]` and selects the variant by
/// *discriminant*, so both the payload types and the declaration order are
/// wire-visible — unlike the unit-variant case above, these variants stay in
/// declaration order and are never sorted.
///
/// `fields` carries the payload in source order; `FieldSpec::name` is the
/// variant's field name for a struct-like variant, or its positional index as
/// text for a tuple variant.
#[derive(Clone, Debug)]
struct VariantSpec {
    name: String,
    fields: Vec<FieldSpec>,
}

impl VariantSpec {
    /// True when every payload field is positional (a tuple variant), as
    /// opposed to a struct-like variant with named fields.
    fn is_positional(&self) -> bool {
        self.fields.iter().all(|f| f.name.parse::<usize>().is_ok())
    }

    fn canonical(&self, defs: &Definitions) -> String {
        let parts: Vec<String> = self
            .fields
            .iter()
            .map(|f| {
                if self.is_positional() {
                    defs.canonical_type(&f.ty)
                } else {
                    format!("{}:{}", f.name, defs.canonical_type(&f.ty))
                }
            })
            .collect();
        if self.is_positional() {
            format!("{}({})", self.name, parts.join("+"))
        } else {
            format!("{}{{{}}}", self.name, parts.join(","))
        }
    }
}

impl DefKind {
    fn canonical(&self, name: &str, defs: &Definitions) -> String {
        match self {
            DefKind::Struct(fields) => {
                let mut parts: Vec<String> = fields
                    .iter()
                    .map(|f| format!("{}:{}", f.name, defs.canonical_type(&f.ty)))
                    .collect();
                parts.sort();
                format!("{name}{{{}}}", parts.join(","))
            }
            DefKind::Enum(variants) => format!("{name}{{enum:{}}}", variants.join(",")),
            DefKind::PayloadEnum(variants) => format!(
                "{name}{{payload_enum:{}}}",
                variants
                    .iter()
                    .map(|v| v.canonical(defs))
                    .collect::<Vec<String>>()
                    .join(",")
            ),
        }
    }
}

/// One event, extracted from its `#[contractevent]` struct.
#[derive(Clone, Debug)]
struct EventSpec {
    struct_name: String,
    event_key: String,
    doc: String,
    topics: Vec<FieldSpec>,
    data: Vec<FieldSpec>,
}

impl EventSpec {
    /// Order-insensitive canonical form. Data is a symbol-keyed map on the
    /// wire, so its fields are sorted; topics are positional XDR, so their
    /// order is significant and kept as declared.
    fn canonical(&self, defs: &Definitions) -> String {
        let mut s = format!(
            "streampay-event/v{REGISTRY_VERSION}|{}|key={}|topics=[",
            self.struct_name, self.event_key
        );
        for (i, t) in self.topics.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            write!(&mut s, "{}:{}", t.name, defs.canonical_type(&t.ty)).unwrap();
        }
        s.push_str("],data=[");
        let mut data: Vec<&FieldSpec> = self.data.iter().collect();
        data.sort_by(|a, b| a.name.cmp(&b.name));
        for (i, f) in data.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            write!(&mut s, "{}:{}", f.name, defs.canonical_type(&f.ty)).unwrap();
        }
        s.push(']');
        s
    }

    fn fingerprint(&self, defs: &Definitions) -> String {
        fingerprint_of(&self.canonical(defs))
    }
}

fn fingerprint_of(canonical: &str) -> String {
    let digest = Sha256::digest(canonical.as_bytes());
    let mut hex = String::from("sha256:");
    for b in digest {
        write!(&mut hex, "{b:02x}").unwrap();
    }
    hex
}

/// `Vec<u64>` / `crate::policy::StreamPolicy` token strings have spaces around
/// punctuation; strip all whitespace to get a stable type identifier. Event
/// field types never contain significant whitespace.
fn compact_type(ty: &syn::Type) -> String {
    ty.to_token_stream()
        .to_string()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// Soroban emits the event name as the snake_case symbol of the struct name.
fn snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for (i, c) in name.char_indices() {
        if c.is_uppercase() {
            if i > 0 {
                let prev = name[..i].chars().last().unwrap();
                if prev.is_lowercase() || prev.is_ascii_digit() {
                    out.push('_');
                }
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Every doc string on an item, in source order.
///
/// Two spellings have to be read. `///` compiles to a plain `#[doc = "…"]`, and
/// main's wasm-size pass rewrote event docs into
/// `#[cfg_attr(not(target_family = "wasm"), doc = "…")]` so the strings stay out
/// of the on-chain artifact. Skipping the second form would silently publish
/// `description: ""` for every event, so the generator reads both: a doc behind
/// a cfg condition still documents the event for every registry consumer.
fn doc_strings(attrs: &[syn::Attribute]) -> Vec<String> {
    let mut out = Vec::new();
    for attr in attrs {
        let mut push = |meta: &syn::Meta| {
            if let syn::Meta::NameValue(nv) = meta {
                if nv.path.is_ident("doc") {
                    if let syn::Expr::Lit(syn::ExprLit {
                        lit: syn::Lit::Str(s),
                        ..
                    }) = &nv.value
                    {
                        out.push(s.value());
                    }
                }
            }
        };
        match &attr.meta {
            syn::Meta::List(list) if list.path.is_ident("cfg_attr") => {
                let inner = list
                    .parse_args_with(
                        syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
                    )
                    .unwrap_or_else(|e| panic!("cannot read `cfg_attr({})`: {e}", list.tokens));
                for meta in inner {
                    push(&meta);
                }
            }
            meta => push(meta),
        }
    }
    out
}

fn doc_text(item: &ItemStruct) -> String {
    let lines = doc_strings(&item.attrs);
    let text = lines
        .iter()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    text.replace('\n', " ")
}

fn is_contractevent(item: &ItemStruct) -> bool {
    item.attrs
        .iter()
        .any(|a| a.path().is_ident("contractevent"))
}

fn field_specs(item: &ItemStruct) -> Vec<FieldSpec> {
    item.fields
        .iter()
        .map(|f| FieldSpec {
            name: f.ident.as_ref().unwrap().to_string(),
            ty: normalize_type(&compact_type(&f.ty)),
        })
        .collect()
}

fn is_topic_field(f: &syn::Field) -> bool {
    f.attrs.iter().any(|a| a.path().is_ident("topic"))
}

/// The payload of one enum variant, in source order. Tuple variants have no
/// idents, so their fields are labelled by position; struct-like variants keep
/// their names.
fn variant_field_specs(fields: &syn::Fields) -> Vec<FieldSpec> {
    fields
        .iter()
        .enumerate()
        .map(|(i, f)| FieldSpec {
            name: f
                .ident
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| i.to_string()),
            ty: normalize_type(&compact_type(&f.ty)),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// publish() call sites
// ---------------------------------------------------------------------------

/// One `publish()` call found in the crate sources.
struct PublishSite {
    /// The event struct being published, when the call is written in the
    /// `Event { .. }.publish(env)` struct-literal form the macro requires.
    event: Option<String>,
    /// Index of this call among `.publish(` occurrences in its file, used to
    /// recover a line number for the failure message.
    occurrence: usize,
}

struct PublishVisitor {
    sites: Vec<PublishSite>,
}

impl<'ast> Visit<'ast> for PublishVisitor {
    fn visit_expr_method_call(&mut self, node: &syn::ExprMethodCall) {
        if node.method == "publish" {
            self.sites.push(PublishSite {
                event: publish_receiver_name(&node.receiver),
                occurrence: self.sites.len(),
            });
        }
        syn::visit::visit_expr_method_call(self, node);
    }
}

/// Unwrap the receiver of `.publish()` down to the struct literal being sent.
fn publish_receiver_name(expr: &syn::Expr) -> Option<String> {
    match expr {
        syn::Expr::Struct(s) => s.path.segments.last().map(|p| p.ident.to_string()),
        syn::Expr::Paren(p) => publish_receiver_name(&p.expr),
        syn::Expr::Reference(r) => publish_receiver_name(&r.expr),
        syn::Expr::Group(g) => publish_receiver_name(&g.expr),
        syn::Expr::Block(b) => b.block.stmts.last().and_then(|stmt| match stmt {
            syn::Stmt::Expr(expr, _) => publish_receiver_name(expr),
            _ => None,
        }),
        _ => None,
    }
}

/// Every `publish()` call site in `src/`, in source order per file.
fn publish_sites() -> Vec<(PathBuf, Vec<PublishSite>)> {
    let src = contract_src_dir();
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    files.sort();

    let mut out = Vec::new();
    for path in files {
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        if !text.contains(".publish(") {
            continue;
        }
        let file: File =
            syn::parse_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        let mut visitor = PublishVisitor { sites: Vec::new() };
        visitor.visit_file(&file);
        out.push((path, visitor.sites));
    }
    out
}

/// 1-based line of the `occurrence`th `.publish(` in `text`.
fn publish_line(text: &str, occurrence: usize) -> usize {
    let mut from = 0usize;
    for _ in 0..=occurrence {
        match text[from..].find(".publish(") {
            Some(offset) => from += offset + 1,
            None => return 0,
        }
    }
    text[..from].matches('\n').count() + 1
}

/// Walk `src/` recursively collecting every Rust file.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
            out.push(path);
        }
    }
}

/// All contract types referenced by event fields, by identifier — the pool
/// that event field types resolve against.
struct Definitions {
    defs: BTreeMap<String, DefKind>,
}

impl Definitions {
    fn resolve(&self, ty: &str) -> Option<&DefKind> {
        // Strip any path prefix: `crate::policy::StreamPolicy` -> `StreamPolicy`.
        let last = ty.rsplit("::").next().unwrap_or(ty);
        if last.chars().next()?.is_uppercase() {
            self.defs.get(last)
        } else {
            None
        }
    }

    fn resolve_name(&self, ty: &str) -> Option<String> {
        self.resolve(ty)
            .map(|_| ty.rsplit("::").next().unwrap_or(ty).to_string())
    }

    /// Expand a type into its canonical form. Unknown scalars are emitted
    /// verbatim; named-field structs referenced by an event are expanded to
    /// their full field signature and unit-variant enums to their variant list,
    /// so a change to a referenced type changes every event fingerprint that
    /// uses it.
    fn canonical_type(&self, ty: &str) -> String {
        if let Some(inner) = ty.strip_prefix("Option<").and_then(|t| t.strip_suffix('>')) {
            format!("Option<{}>", self.canonical_type(inner))
        } else if let Some(inner) = ty.strip_prefix("Vec<").and_then(|t| t.strip_suffix('>')) {
            format!("Vec<{}>", self.canonical_type(inner))
        } else if let Some(kind) = self.resolve(ty) {
            kind.canonical(&self.resolve_name(ty).unwrap(), self)
        } else {
            ty.to_string()
        }
    }
}

/// Strip the module path off a leaf type name so that moving a struct between
/// modules does not look like a wire change, recursing through the generic
/// wrappers events actually use.
fn normalize_type(ty: &str) -> String {
    if let Some(inner) = ty.strip_prefix("Option<").and_then(|t| t.strip_suffix('>')) {
        format!("Option<{}>", normalize_type(inner))
    } else if let Some(inner) = ty.strip_prefix("Vec<").and_then(|t| t.strip_suffix('>')) {
        format!("Vec<{}>", normalize_type(inner))
    } else {
        ty.rsplit("::").next().unwrap_or(ty).to_string()
    }
}

/// Parse every `#[contractevent]` struct under `src/`, plus every contract type
/// they may reference (named-field structs and unit-variant enums).
fn extract() -> (Vec<EventSpec>, Definitions) {
    let src = contract_src_dir();
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    files.sort();

    let mut defs: BTreeMap<String, DefKind> = BTreeMap::new();
    let mut events: Vec<EventSpec> = Vec::new();

    for path in files {
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let file: File =
            syn::parse_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        collect_items(&file, &mut defs, &mut events);
    }

    events.sort_by(|a, b| a.struct_name.cmp(&b.struct_name));
    (events, Definitions { defs })
}

fn collect_items(file: &File, defs: &mut BTreeMap<String, DefKind>, events: &mut Vec<EventSpec>) {
    for item in &file.items {
        match item {
            Item::Struct(s) => {
                let name = s.ident.to_string();
                let named = s.fields.iter().all(|f| f.ident.is_some());
                if named {
                    defs.insert(name.clone(), DefKind::Struct(field_specs(s)));
                }
                if is_contractevent(s) {
                    let all = field_specs_with_topic(s);
                    events.push(EventSpec {
                        struct_name: name,
                        event_key: snake_case(&s.ident.to_string()),
                        doc: doc_text(s),
                        topics: all
                            .iter()
                            .filter(|(_, t)| *t)
                            .map(|(f, _)| f.clone())
                            .collect(),
                        data: all
                            .iter()
                            .filter(|(_, t)| !*t)
                            .map(|(f, _)| f.clone())
                            .collect(),
                    });
                }
            }
            Item::Enum(e) => {
                // `#[contracttype]` enums come in two wire shapes. If every
                // variant is data-free the host encodes the value as its
                // variant symbol alone, so the sorted name set is the whole
                // public shape. Once a variant carries a payload the encoding
                // becomes `[symbol, payload…]` selected by discriminant, so the
                // registry keeps declaration order and each variant's types.
                let variants: Vec<VariantSpec> = e
                    .variants
                    .iter()
                    .map(|v| VariantSpec {
                        name: v.ident.to_string(),
                        fields: variant_field_specs(&v.fields),
                    })
                    .collect();
                if variants.is_empty() {
                    // A data-less enum has no public shape to pin.
                } else if variants.iter().all(|v| v.fields.is_empty()) {
                    let mut sorted: Vec<String> = variants.iter().map(|v| v.name.clone()).collect();
                    sorted.sort();
                    defs.insert(e.ident.to_string(), DefKind::Enum(sorted));
                } else {
                    defs.insert(e.ident.to_string(), DefKind::PayloadEnum(variants));
                }
            }
            Item::Mod(m) => {
                if let Some((_, content)) = &m.content {
                    let nested = File {
                        shebang: None,
                        frontmatter: None,
                        attrs: vec![],
                        items: content.clone(),
                    };
                    collect_items(&nested, defs, events);
                }
            }
            _ => {}
        }
    }
}

fn field_specs_with_topic(item: &ItemStruct) -> Vec<(FieldSpec, bool)> {
    item.fields
        .iter()
        .map(|f| {
            (
                FieldSpec {
                    name: f.ident.as_ref().unwrap().to_string(),
                    ty: normalize_type(&compact_type(&f.ty)),
                },
                is_topic_field(f),
            )
        })
        .collect()
}

/// JSON Schema fragment for a Rust event type. Raises on an unmapped type:
/// new field types must be mapped deliberately (the indexer and frontend
/// codegen share this vocabulary).
fn json_schema_for(
    ty: &str,
    defs: &Definitions,
    emitted: &mut BTreeMap<String, serde_json::Value>,
) -> serde_json::Value {
    use serde_json::json;
    if let Some(inner) = ty.strip_prefix("Option<").and_then(|t| t.strip_suffix('>')) {
        let mut schema = json_schema_for(inner, defs, emitted);
        schema = json!({
            "anyOf": [schema, {"type": "null"}],
            "x-soroban-type": ty,
        });
        return schema;
    }
    if let Some(inner) = ty.strip_prefix("Vec<").and_then(|t| t.strip_suffix('>')) {
        let items = json_schema_for(inner, defs, emitted);
        return json!({
            "type": "array",
            "items": items,
            "x-soroban-type": ty,
        });
    }
    let known = match ty {
        "bool" => json!({"type": "boolean", "x-soroban-type": "bool"}),
        "u32" => {
            json!({"type": "integer", "minimum": 0, "maximum": 4294967295_u64, "x-soroban-type": "u32"})
        }
        "u64" => json!({"type": "integer", "minimum": 0, "x-soroban-type": "u64"}),
        "i64" => json!({"type": "integer", "x-soroban-type": "i64"}),
        "i128" => json!({"type": "integer", "x-soroban-type": "i128"}),
        "Address" => json!({
            "type": "string",
            "description": "Stellar account or contract address (StrKey).",
            "x-soroban-type": "Address",
        }),
        "BytesN<32>" => json!({
            "type": "string",
            "contentEncoding": "base64",
            "description": "32-byte hash, base64-encoded on the registry surface.",
            "x-soroban-type": "BytesN<32>",
        }),
        "Symbol" => json!({
            "type": "string",
            "description": "Soroban symbol (a short upper-/lower-case tag, not free text).",
            "x-soroban-type": "Symbol",
        }),
        _ => {
            if let Some(name) = defs.resolve_name(ty) {
                if !emitted.contains_key(&name) {
                    let schema = match defs.resolve(ty).unwrap() {
                        DefKind::Struct(fields) => {
                            let mut properties = serde_json::Map::new();
                            let mut required = Vec::new();
                            for f in fields {
                                required.push(f.name.clone());
                                properties
                                    .insert(f.name.clone(), json_schema_for(&f.ty, defs, emitted));
                            }
                            json!({
                                "type": "object",
                                "title": name,
                                "description": format!("Contract struct `{name}` referenced by event fields."),
                                "properties": properties,
                                "required": required,
                                "additionalProperties": false,
                            })
                        }
                        DefKind::Enum(variants) => json!({
                            "type": "string",
                            "title": name,
                            "description": format!("Contract enum `{name}` referenced by event fields, wire-encoded as its variant symbol."),
                            "enum": variants,
                        }),
                        DefKind::PayloadEnum(variants) => json!({
                            "type": "array",
                            "title": name,
                            "description": format!(
                                "Contract enum `{name}` referenced by event fields. Wire form is \
                                 [variant symbol, payload…]; the payload shape depends on the variant."
                            ),
                            "oneOf": variants
                                .iter()
                                .map(|v| {
                                    let mut positional =
                                        vec![json!({"const": v.name.clone()})];
                                    positional.extend(
                                        v.fields
                                            .iter()
                                            .map(|f| json_schema_for(&f.ty, defs, emitted))
                                            .collect::<Vec<_>>(),
                                    );
                                    json!({
                                        "prefixItems": positional,
                                        "minItems": v.fields.len() + 1,
                                        "maxItems": v.fields.len() + 1,
                                    })
                                })
                                .collect::<Vec<_>>(),
                        }),
                    };
                    emitted.insert(name.clone(), schema);
                }
                json!({"$ref": format!("#/$defs/{name}"), "x-soroban-type": ty})
            } else {
                panic!(
                    "event field type `{ty}` has no JSON Schema mapping — add it to \
                     event_registry::json_schema_for and regenerate schemas/events/"
                );
            }
        }
    };
    known
}

/// The complete registry document (`schemas/events/registry.json`).
fn registry_json(events: &[EventSpec], defs: &Definitions) -> serde_json::Value {
    use serde_json::{json, Map, Value};
    let mut events_obj = Map::new();
    let mut fingerprints = Map::new();
    let mut referenced: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for e in events {
        let mut schema_props = Map::new();
        for f in &e.data {
            schema_props.insert(
                f.name.clone(),
                json_schema_for(&f.ty, defs, &mut referenced),
            );
        }
        let fingerprint = e.fingerprint(defs);
        fingerprints.insert(e.struct_name.clone(), Value::String(fingerprint.clone()));
        events_obj.insert(
            e.struct_name.clone(),
            json!({
                "event_key": e.event_key,
                "fingerprint": fingerprint,
                "canonical": e.canonical(defs),
                "topics": e.topics.iter().map(|f| json!({"name": f.name, "type": f.ty})).collect::<Vec<_>>(),
                "data": e.data.iter().map(|f| json!({"name": f.name, "type": f.ty})).collect::<Vec<_>>(),
            }),
        );
    }

    let mut definitions_obj = Map::new();
    for (name, schema) in &referenced {
        let canonical = defs.canonical_type(name);
        let mut entry = Map::new();
        entry.insert(
            "fingerprint".into(),
            Value::String(fingerprint_of(&canonical)),
        );
        entry.insert("canonical".into(), Value::String(canonical));
        match defs.defs.get(name).unwrap() {
            DefKind::Struct(fields) => {
                entry.insert("kind".to_string(), Value::String("struct".into()));
                entry.insert(
                    "fields".into(),
                    Value::Array(
                        fields
                            .iter()
                            .map(|f| json!({ "name": f.name, "type": f.ty }))
                            .collect(),
                    ),
                );
            }
            DefKind::Enum(variants) => {
                entry.insert("kind".to_string(), Value::String("enum".into()));
                entry.insert(
                    "variants".into(),
                    Value::Array(variants.iter().map(|v| Value::String(v.clone())).collect()),
                );
            }
            DefKind::PayloadEnum(variants) => {
                entry.insert("kind".to_string(), Value::String("payload_enum".into()));
                entry.insert(
                    "variants".into(),
                    Value::Array(
                        variants
                            .iter()
                            .map(|v| {
                                json!({
                                    "name": v.name,
                                    "positional": v.is_positional(),
                                    "fields": v
                                        .fields
                                        .iter()
                                        .map(|f| json!({"name": f.name, "type": f.ty}))
                                        .collect::<Vec<_>>(),
                                })
                            })
                            .collect::<Vec<_>>(),
                    ),
                );
            }
        }
        entry.insert("schema".into(), schema.clone());
        definitions_obj.insert(name.clone(), Value::Object(entry));
    }

    json!({
        "$comment": format!("Generated by `{REGEN_COMMAND}`. Do not edit by hand."),
        "generated_by": REGEN_COMMAND,
        "registry_version": REGISTRY_VERSION,
        "source": "contracts/streaming-payments/src/",
        "events": Value::Object(events_obj),
        "definitions": Value::Object(definitions_obj),
        "fingerprints": Value::Object(fingerprints),
    })
}

/// One per-event JSON Schema document (`schemas/events/v1/events/<key>.json`).
fn event_schema_json(e: &EventSpec, defs: &Definitions) -> serde_json::Value {
    use serde_json::{json, Map, Value};
    let mut referenced: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    let mut properties = Map::new();
    let mut required: Vec<Value> = Vec::new();
    for f in &e.data {
        properties.insert(
            f.name.clone(),
            json_schema_for(&f.ty, defs, &mut referenced),
        );
        required.push(Value::String(f.name.clone()));
    }
    let mut topic_properties = Map::new();
    for t in &e.topics {
        topic_properties.insert(
            t.name.clone(),
            json_schema_for(&t.ty, defs, &mut referenced),
        );
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": format!("{SCHEMA_ID_BASE}/v{REGISTRY_VERSION}/events/{}.json", e.event_key),
        "title": e.struct_name,
        "description": e.doc,
        "type": "object",
        "properties": Value::Object(properties),
        "required": required,
        "additionalProperties": false,
        "x-streampay": {
            "event_key": e.event_key,
            "registry_version": REGISTRY_VERSION,
            "fingerprint": e.fingerprint(defs),
            "topics": e.topics.iter().map(|f| json!({"name": f.name, "type": f.ty})).collect::<Vec<_>>(),
            "topicSchema": {
                "type": "array",
                "items": Value::Array(
                    e.topics
                        .iter()
                        .map(|t| json_schema_for(&t.ty, defs, &mut referenced))
                        .collect(),
                ),
            },
        },
        "$defs": referenced,
    })
}

fn catalog_json(events: &[EventSpec], defs: &Definitions) -> serde_json::Value {
    use serde_json::json;
    json!({
        "$comment": format!("Generated by `{REGEN_COMMAND}`. Do not edit by hand."),
        "registry_version": REGISTRY_VERSION,
        "events": events
            .iter()
            .map(|e| json!({
                "struct": e.struct_name,
                "event_key": e.event_key,
                "schema": format!("events/{}.json", e.event_key),
                "fingerprint": e.fingerprint(defs),
            }))
            .collect::<Vec<_>>(),
    })
}

fn write_json(path: &Path, value: &serde_json::Value) {
    std::fs::create_dir_all(path.parent().unwrap())
        .unwrap_or_else(|e| panic!("mkdir {}: {e}", path.display()));
    let mut text = serde_json::to_string_pretty(value).expect("serialize");
    text.push('\n');
    std::fs::write(path, text).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

/// Regenerate `schemas/events/` from the contract sources.
#[test]
#[ignore = "run with: cargo test -p streampay-contract --lib --locked event_registry::generate -- --ignored"]
fn generate() {
    let (events, defs) = extract();
    let root = repo_root().join("schemas").join("events");

    write_json(&root.join("registry.json"), &registry_json(&events, &defs));
    write_json(
        &root
            .join(format!("v{REGISTRY_VERSION}"))
            .join("catalog.json"),
        &catalog_json(&events, &defs),
    );
    for e in &events {
        write_json(
            &root
                .join(format!("v{REGISTRY_VERSION}"))
                .join("events")
                .join(format!("{}.json", e.event_key)),
            &event_schema_json(e, &defs),
        );
    }
    std::println!("wrote {} event schemas to {}", events.len(), root.display());
}

/// The committed registry must match the contract code field-for-field.
/// Rename, remove, add or re-type any event field (or a referenced struct
/// field) and this fails until the registry is regenerated — at which point
/// the CI compatibility gate is the one that has to be satisfied.
#[test]
fn registry_matches_contract_event_structs() {
    let (events, defs) = extract();
    let expected = registry_json(&events, &defs);

    let path = repo_root()
        .join("schemas")
        .join("events")
        .join("registry.json");
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "committed registry missing at {}: {e} — run `{REGEN_COMMAND}` and commit the output",
            path.display()
        )
    });
    let committed: serde_json::Value =
        serde_json::from_str(&committed).expect("registry.json parses");

    if expected == committed {
        return;
    }

    let mut diffs = Vec::new();
    let exp_events = expected["events"].as_object().unwrap();
    let com_events = committed["events"].as_object().unwrap();
    for name in exp_events.keys() {
        match com_events.get(name) {
            None => diffs.push(format!("+ {name} (new event, not in registry)")),
            Some(c) => {
                let e = &exp_events[name];
                if c["fingerprint"] != e["fingerprint"] {
                    diffs.push(format!(
                        "! {name}: registry {} != code {}",
                        c["fingerprint"], e["fingerprint"]
                    ));
                }
                for field in ["topics", "data"] {
                    if c[field] != e[field] {
                        diffs.push(format!(
                            "! {name}.{field}: registry {:?} != code {:?}",
                            c[field], e[field]
                        ));
                    }
                }
            }
        }
    }
    for name in com_events.keys().filter(|n| !exp_events.contains_key(*n)) {
        diffs.push(format!("- {name} (in registry, no longer emitted)"));
    }
    panic!(
        "schemas/events/registry.json is stale — the emitted event shapes changed.\n\
         {}\n\
         Regenerate with `{REGEN_COMMAND}`, commit the output, and make the CI \
         compatibility gate (scripts/event_compat_check.mjs) pass.",
        diffs.join("\n")
    );
}

/// The registry covers every `#[contractevent]` struct in the crate —
/// including ones defined outside `events.rs` or added later: the scan is
/// over the source tree, not a hand-maintained list.
#[test]
fn every_contractevent_is_registered() {
    let (events, _defs) = extract();
    let path = repo_root()
        .join("schemas")
        .join("events")
        .join("registry.json");
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("registry.json"))
            .expect("registry.json parses");
    let registered = committed["events"].as_object().unwrap();

    let missing: Vec<&str> = events
        .iter()
        .filter(|e| !registered.contains_key(&e.struct_name))
        .map(|e| e.struct_name.as_str())
        .collect();
    assert!(
        missing.is_empty(),
        "emitted events missing from the registry: {missing:?} — regenerate with `{REGEN_COMMAND}`"
    );
    assert!(
        events.len() >= 33,
        "event scan regressed: only {} events found under src/",
        events.len()
    );
}

/// The registry declares everything the contract can emit, and nothing it
/// cannot. This is the `surface.rs` rule applied to events: every rejection
/// branch must be declared there, every `publish()` here must name a declared
/// event, and every declared event must actually be published somewhere.
///
/// Consequence for contributors: adding a field to an event is a three-file
/// change in one commit — the struct, the `publish()` call site that fills it,
/// and the regenerated registry. An `Event { .. }.publish()` written through an
/// alias or a binding is rejected too, because the gate has to be able to see
/// which event a site emits.
#[test]
fn no_event_is_emitted_that_the_registry_does_not_declare() {
    let (events, _defs) = extract();
    let declared: BTreeSet<&str> = events.iter().map(|e| e.struct_name.as_str()).collect();

    let mut problems: Vec<String> = Vec::new();
    let mut published: BTreeSet<String> = BTreeSet::new();
    let mut site_count = 0usize;

    for (path, sites) in publish_sites() {
        let text = std::fs::read_to_string(&path).expect("source file");
        let rel = path.display().to_string();
        // The line lookup walks raw `.publish(` occurrences, so it is only
        // trustworthy when the AST agrees with the text about how many there are.
        let text_count = text.matches(".publish(").count();
        let exact_lines = text_count == sites.len();
        for site in &sites {
            site_count += 1;
            let line = if exact_lines {
                publish_line(&text, site.occurrence)
            } else {
                0
            };
            let at = if line == 0 {
                rel.clone()
            } else {
                format!("{rel}:{line}")
            };
            match &site.event {
                None => problems.push(format!(
                    "{at} — publish() is not written as `Event {{ .. }}.publish(env)`, \
                     so the gate cannot tell which event it emits"
                )),
                Some(name) if !declared.contains(name.as_str()) => problems.push(format!(
                    "{at} — publishes `{name}`, which has no #[contractevent] declaration: \
                     declare the event, run `{REGEN_COMMAND}`, and commit schemas/events/ in the \
                     same commit as this publish site"
                )),
                Some(name) => {
                    published.insert(name.clone());
                }
            }
        }
    }

    let never: Vec<&str> = declared
        .iter()
        .filter(|name| !published.contains(**name))
        .copied()
        .collect();
    assert!(
        problems.is_empty(),
        "undeclared events would reach the wire:\n{}\n\
         The registry (schemas/events/) is the emit list: no event may be published \
         before it is declared and regenerated.",
        problems.join("\n")
    );
    assert!(
        never.is_empty(),
        "declared events with no publish site: {never:?} — the registry promises \
         consumers an event nothing emits; either wire it up or remove it and regenerate."
    );
    assert!(
        site_count >= 30,
        "publish-site scan regressed: only {site_count} publish() calls found under src/"
    );
}

#[test]
fn snake_case_matches_soroban_event_topics() {
    for (input, expected) in [
        ("StreamCreated", "stream_created"),
        ("StreamsCreated", "streams_created"),
        ("Withdrawn", "withdrawn"),
        ("StreamToppedUp", "stream_topped_up"),
        ("ScheduledStreamExecuted", "scheduled_stream_executed"),
        ("FeeCharged", "fee_charged"),
        (
            "ContractFrozenStateChanged",
            "contract_frozen_state_changed",
        ),
        ("PolicyAssetQueued", "policy_asset_queued"),
        ("StorageMigrated", "storage_migrated"),
        ("StreamPolicySet", "stream_policy_set"),
        ("OracleConfigUpdated", "oracle_config_updated"),
        ("OracleStaleFallback", "oracle_stale_fallback"),
        ("OwnershipProposed", "ownership_proposed"),
        ("BeneficiaryEnrolled", "beneficiary_enrolled"),
        ("OperatorKeyRotated", "operator_key_rotated"),
        ("SponsorClaim", "sponsor_claim"),
    ] {
        assert_eq!(snake_case(input), expected, "snake_case({input})");
    }
}
