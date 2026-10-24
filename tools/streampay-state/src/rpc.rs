//! Minimal blocking Soroban JSON-RPC client for the state export tool.

use serde_json::{json, Value};

/// Blocking Soroban RPC client.
pub struct RpcClient {
    url: String,
    client: reqwest::blocking::Client,
    id: std::sync::atomic::AtomicU64,
}

impl RpcClient {
    pub fn new(url: &str) -> anyhow::Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| anyhow::anyhow!("HTTP client: {e}"))?;
        Ok(Self {
            url: url.to_string(),
            client,
            id: std::sync::atomic::AtomicU64::new(1),
        })
    }

    fn next_id(&self) -> u64 {
        self.id.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn call(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": method,
            "params": params,
        });
        let resp = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .map_err(|e| anyhow::anyhow!("HTTP: {e}"))?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("HTTP {}", resp.status()));
        }
        let json: Value = resp.json().map_err(|e| anyhow::anyhow!("parse: {e}"))?;
        if let Some(err) = json.get("error") {
            return Err(anyhow::anyhow!("RPC error: {err}"));
        }
        json.get("result")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing result"))
    }

    /// Returns the latest ledger sequence number.
    pub fn get_latest_ledger(&self) -> anyhow::Result<u64> {
        let result = self.call("getLatestLedger", json!({}))?;
        result["sequence"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("missing sequence"))
    }
}
