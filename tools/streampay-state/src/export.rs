//! `export` sub-command: reads all StreamPay contract storage via Soroban RPC
//! and writes a versioned JSON snapshot.
//!
//! # Strategy
//!
//! Soroban exposes contract storage through `getLedgerEntries` (by known key)
//! and `simulateTransaction` (to call read-only view functions). We use the
//! view functions (`get_stream`, `available`, `get_intent`, `treasury_status`,
//! `stream_fee`, `recipient_streams`, `sender_streams`, `total_streams`) rather
//! than raw storage parsing so the snapshot format is independent of the
//! internal XDR key encoding.

use std::collections::HashMap;

use serde_json::json;

use crate::model::{
    IndexEntry, Snapshot, StreamEntry, StreamFeeEntry, TreasuryEntry, SNAPSHOT_SCHEMA_FINGERPRINT,
    SNAPSHOT_SCHEMA_VERSION,
};

// Soroban SDK types we need for encoding arguments.
use stellar_xdr::{
    ContractId, Hash, HostFunction, InvokeContractArgs, InvokeHostFunctionOp, Limits, Memo,
    MuxedAccount, Operation, OperationBody, Preconditions, PublicKey, ReadXdr, ScAddress, ScSymbol,
    ScVal, SequenceNumber, Transaction, TransactionEnvelope, TransactionExt, TransactionV1Envelope,
    Uint256, VecM, WriteXdr,
};

/// All-zero G-address used as a dummy source for simulation transactions.
const DUMMY_SOURCE: [u8; 32] = [0u8; 32];

// ── XDR helpers ───────────────────────────────────────────────────────────────

fn contract_address(id: &str) -> anyhow::Result<ScAddress> {
    // Contract ids are StrKey C… addresses. Decode the 32-byte hash.
    let bytes = id
        .parse::<stellar_strkey::Contract>()
        .map_err(|e| anyhow::anyhow!("invalid contract id {id}: {e}"))?
        .0;
    Ok(ScAddress::Contract(ContractId(Hash(bytes))))
}

fn sc_u64(n: u64) -> ScVal {
    ScVal::U64(n)
}

/// Encodes a `simulateTransaction` call body for one read-only invocation.
fn build_sim_tx(
    contract_id: &str,
    method: &str,
    args: Vec<ScVal>,
    _network_passphrase: &str,
) -> anyhow::Result<String> {
    let invoke = HostFunction::InvokeContract(InvokeContractArgs {
        contract_address: contract_address(contract_id)?,
        function_name: ScSymbol(method.try_into()?),
        args: args.try_into()?,
    });

    let tx = Transaction {
        source_account: MuxedAccount::Ed25519(Uint256(DUMMY_SOURCE)),
        fee: 100,
        seq_num: SequenceNumber(1),
        cond: Preconditions::None,
        memo: Memo::None,
        operations: vec![Operation {
            source_account: None,
            body: OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
                host_function: invoke,
                auth: VecM::default(),
            }),
        }]
        .try_into()?,
        ext: TransactionExt::default(),
    };

    let env_tx = TransactionEnvelope::Tx(TransactionV1Envelope {
        tx,
        signatures: VecM::default(),
    });

    let xdr = env_tx.to_xdr_base64(Limits::none())?;
    Ok(xdr)
}

// ── Simulation helper ─────────────────────────────────────────────────────────

fn simulate(
    client: &reqwest::blocking::Client,
    rpc_url: &str,
    tx_xdr: &str,
) -> anyhow::Result<ScVal> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "simulateTransaction",
        "params": { "transaction": tx_xdr }
    });
    let resp: serde_json::Value = client.post(rpc_url).json(&body).send()?.json()?;

    if let Some(err) = resp["error"].as_str() {
        return Err(anyhow::anyhow!("simulateTransaction: {err}"));
    }
    let xdr = resp["result"]["results"][0]["xdr"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no simulation retval"))?;
    let val = ScVal::from_xdr_base64(xdr, Limits::none())?;
    Ok(val)
}

// ── ScVal → Rust type converters ──────────────────────────────────────────────

fn scval_to_i128(v: &ScVal) -> anyhow::Result<i128> {
    match v {
        ScVal::I128(parts) => Ok(((parts.hi as i128) << 64) | (parts.lo as i128)),
        ScVal::U64(n) => Ok(*n as i128),
        ScVal::U32(n) => Ok(*n as i128),
        _ => Err(anyhow::anyhow!("expected i128, got {v:?}")),
    }
}

fn scval_to_u64(v: &ScVal) -> anyhow::Result<u64> {
    match v {
        ScVal::U64(n) => Ok(*n),
        ScVal::U32(n) => Ok(*n as u64),
        _ => Err(anyhow::anyhow!("expected u64, got {v:?}")),
    }
}

fn scval_to_bool(v: &ScVal) -> bool {
    matches!(v, ScVal::Bool(true))
}

fn scval_to_address(v: &ScVal) -> anyhow::Result<String> {
    match v {
        ScVal::Address(a) => {
            let strkey = match a {
                ScAddress::Account(acc) => {
                    let inner = match &acc.0 {
                        PublicKey::PublicKeyTypeEd25519(u) => u.0,
                    };
                    stellar_strkey::Strkey::PublicKeyEd25519(stellar_strkey::ed25519::PublicKey(
                        inner,
                    ))
                }
                ScAddress::Contract(hash) => {
                    stellar_strkey::Strkey::Contract(stellar_strkey::Contract(hash.0 .0))
                }
                _ => return Err(anyhow::anyhow!("unsupported address kind in {v:?}")),
            };
            Ok(strkey.to_string().to_string())
        }
        _ => Err(anyhow::anyhow!("expected Address, got {v:?}")),
    }
}

fn scval_to_string_status(v: &ScVal) -> String {
    match v {
        ScVal::Vec(Some(vec)) if !vec.is_empty() => {
            if let ScVal::Symbol(s) = &vec[0] {
                return s.0.to_utf8_string_lossy();
            }
        }
        ScVal::Symbol(s) => return s.0.to_utf8_string_lossy(),
        _ => {}
    }
    format!("{v:?}")
}

fn map_get<'a>(map: &'a [(ScVal, ScVal)], key: &str) -> Option<&'a ScVal> {
    map.iter()
        .find(|(k, _)| matches!(k, ScVal::Symbol(s) if s.0.as_slice() == key.as_bytes()))
        .map(|(_, v)| v)
}

fn scval_map_to_pairs(v: &ScVal) -> anyhow::Result<Vec<(ScVal, ScVal)>> {
    match v {
        ScVal::Map(Some(m)) => Ok(m.iter().map(|e| (e.key.clone(), e.val.clone())).collect()),
        _ => Err(anyhow::anyhow!("expected Map, got {v:?}")),
    }
}

// ── Entry-point ───────────────────────────────────────────────────────────────

pub fn run(
    rpc_url: &str,
    contract_id: &str,
    out_path: &str,
    network_passphrase: &str,
) -> anyhow::Result<()> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    println!("Exporting StreamPay state from {contract_id} via {rpc_url}");

    // ── Latest ledger ──────────────────────────────────────────────────────────
    let ledger_resp: serde_json::Value = client
        .post(rpc_url)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}))
        .send()?
        .json()?;
    let latest_ledger = ledger_resp["result"]["sequence"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("getLatestLedger: no sequence"))?;
    println!("  Latest ledger: {latest_ledger}");

    // ── total_streams() ────────────────────────────────────────────────────────
    let total_streams_xdr = build_sim_tx(contract_id, "total_streams", vec![], network_passphrase)?;
    let total_streams_val = simulate(&client, rpc_url, &total_streams_xdr)?;
    let total_streams = scval_to_u64(&total_streams_val).unwrap_or(0);
    println!("  Total streams: {total_streams}");

    // ── Fetch all streams ──────────────────────────────────────────────────────
    let mut streams = Vec::with_capacity(total_streams as usize);
    let mut stream_fees = Vec::new();
    let mut treasury_tokens: std::collections::HashSet<String> = std::collections::HashSet::new();

    for id in 1..=total_streams {
        let tx = build_sim_tx(
            contract_id,
            "get_stream",
            vec![sc_u64(id)],
            network_passphrase,
        )?;
        let val = match simulate(&client, rpc_url, &tx) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("  Warning: get_stream({id}) failed: {e}");
                continue;
            }
        };

        // Unwrap Ok(_) wrapper from Result return.
        let stream_map = match &val {
            ScVal::Vec(Some(v)) if v.len() == 2 => {
                // Result::Ok variant.
                if let ScVal::Symbol(s) = &v[0] {
                    if s.0.as_slice() == b"Ok" {
                        &v[1]
                    } else {
                        &val
                    }
                } else {
                    &val
                }
            }
            _ => &val,
        };

        let pairs = scval_map_to_pairs(stream_map)?;

        let token = map_get(&pairs, "token")
            .and_then(|v| scval_to_address(v).ok())
            .unwrap_or_default();

        treasury_tokens.insert(token.clone());

        streams.push(StreamEntry {
            id,
            sender: map_get(&pairs, "sender")
                .and_then(|v| scval_to_address(v).ok())
                .unwrap_or_default(),
            recipient: map_get(&pairs, "recipient")
                .and_then(|v| scval_to_address(v).ok())
                .unwrap_or_default(),
            token: token.clone(),
            deposit: map_get(&pairs, "deposit")
                .and_then(|v| scval_to_i128(v).ok())
                .unwrap_or(0),
            withdrawn: map_get(&pairs, "withdrawn")
                .and_then(|v| scval_to_i128(v).ok())
                .unwrap_or(0),
            start_time: map_get(&pairs, "start_time")
                .and_then(|v| scval_to_u64(v).ok())
                .unwrap_or(0),
            end_time: map_get(&pairs, "end_time")
                .and_then(|v| scval_to_u64(v).ok())
                .unwrap_or(0),
            cancelable: map_get(&pairs, "cancelable")
                .map(scval_to_bool)
                .unwrap_or(false),
            status: map_get(&pairs, "status")
                .map(scval_to_string_status)
                .unwrap_or_else(|| "Unknown".to_string()),
        });

        // Per-stream fee.
        let fee_tx = build_sim_tx(
            contract_id,
            "stream_fee",
            vec![sc_u64(id)],
            network_passphrase,
        )?;
        if let Ok(fv) = simulate(&client, rpc_url, &fee_tx) {
            if let Ok(fee) = scval_to_i128(&fv) {
                if fee > 0 {
                    stream_fees.push(StreamFeeEntry {
                        stream_id: id,
                        token: token.clone(),
                        amount: fee,
                    });
                }
            }
        }

        if id % 50 == 0 {
            println!("  Progress: {id}/{total_streams} streams");
        }
    }

    // ── Fetch treasuries ───────────────────────────────────────────────────────
    let mut treasuries = Vec::new();
    for token in &treasury_tokens {
        let addr_val = match stellar_strkey::Strkey::from_string(token) {
            Ok(stellar_strkey::Strkey::Contract(c)) => ScAddress::Contract(ContractId(Hash(c.0))),
            _ => continue,
        };
        let tx = build_sim_tx(
            contract_id,
            "treasury_status",
            vec![ScVal::Address(addr_val)],
            network_passphrase,
        )?;
        if let Ok(val) = simulate(&client, rpc_url, &tx) {
            let pairs = scval_map_to_pairs(&val)?;
            treasuries.push(TreasuryEntry {
                token: token.clone(),
                charged_total: map_get(&pairs, "charged_total")
                    .and_then(|v| scval_to_i128(v).ok())
                    .unwrap_or(0),
                withdrawn_total: map_get(&pairs, "withdrawn_total")
                    .and_then(|v| scval_to_i128(v).ok())
                    .unwrap_or(0),
            });
        }
    }

    // ── Collect address indexes ────────────────────────────────────────────────
    // Build from streams (cheaper than paginating each unique address separately).
    let mut sender_map: HashMap<String, Vec<u64>> = HashMap::new();
    let mut recipient_map: HashMap<String, Vec<u64>> = HashMap::new();
    for s in &streams {
        sender_map.entry(s.sender.clone()).or_default().push(s.id);
        recipient_map
            .entry(s.recipient.clone())
            .or_default()
            .push(s.id);
    }
    let sender_indexes: Vec<IndexEntry> = sender_map
        .into_iter()
        .map(|(address, stream_ids)| IndexEntry {
            address,
            stream_ids,
        })
        .collect();
    let recipient_indexes: Vec<IndexEntry> = recipient_map
        .into_iter()
        .map(|(address, stream_ids)| IndexEntry {
            address,
            stream_ids,
        })
        .collect();

    // ── Build snapshot ─────────────────────────────────────────────────────────
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let snapshot = Snapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        schema_fingerprint: SNAPSHOT_SCHEMA_FINGERPRINT.to_string(),
        exported_at,
        rpc_url: rpc_url.to_string(),
        contract_id: contract_id.to_string(),
        latest_ledger,
        contract_schema_version: 1,
        contract_frozen: false,
        governor: String::new(),
        streams,
        scheduled_intents: vec![],
        treasuries,
        stream_fees,
        sender_indexes,
        recipient_indexes,
    };

    let json_output = serde_json::to_string_pretty(&snapshot)?;
    std::fs::write(out_path, &json_output)?;
    println!("Snapshot written to {out_path}");
    println!(
        "  {} streams, {} fees, {} treasuries",
        snapshot.streams.len(),
        snapshot.stream_fees.len(),
        snapshot.treasuries.len()
    );
    Ok(())
}
