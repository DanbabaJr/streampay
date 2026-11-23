//! Reader for the indexer's own projection, pinned to a ledger for
//! three-way comparison.

import { createHttpAgent } from "../http.js";
import { normalizeStatus } from "../engine/tolerance.js";

function trimUrl(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export class ProjectionReader {
  constructor(config = {}) {
    this.config = config;
    this.http = config.http ?? createHttpAgent();
  }

  get available() {
    return Boolean(this.config.url);
  }

  headers() {
    return this.config.token
      ? { Authorization: `Bearer ${this.config.token}` }
      : {};
  }

  async latestLedger(streamIds = []) {
    if (!this.available) return null;
    try {
      const response = await this.http.get(`${trimUrl(this.config.url)}/health`, this.headers());
      if (response.status === 200 && Number.isFinite(response.data?.lastLedger)) {
        return response.data.lastLedger;
      }
    } catch {
      // Fall through to per-stream ledgers.
    }
    const { states } = await this.snapshot(streamIds);
    const ledgers = states.map((state) => state.ledger).filter(Number.isFinite);
    return ledgers.length > 0 ? Math.max(...ledgers) : null;
  }

  async snapshot(streamIds = [], asOfLedger = null) {
    if (!this.available) {
      throw new Error("projection reader has no URL configured");
    }
    const base = trimUrl(this.config.url);
    const states = [];
    let maxLedger = null;
    for (const streamId of streamIds) {
      const response = await this.http.get(
        `${base}/streams/${encodeURIComponent(streamId)}`,
        this.headers()
      );
      if (response.status === 404) continue;
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`projection read failed for ${streamId}: HTTP ${response.status}`);
      }
      const record = response.data?.stream ?? response.data;
      if (!record) continue;
      const ledger = Number(record.lastLedger ?? record.last_ledger ?? 0);
      if (Number.isFinite(ledger)) {
        maxLedger = maxLedger === null ? ledger : Math.max(maxLedger, ledger);
      }
      states.push({
        streamId: String(record.streamId ?? record.stream_id ?? streamId),
        ledger,
        timestamp: record.updatedAt ?? record.updated_at ?? new Date().toISOString(),
        data: {
          deposit: String(record.deposit ?? "0"),
          withdrawn: String(record.withdrawn ?? "0"),
          status: normalizeStatus(record.status ?? "Active"),
        },
      });
    }
    return {
      states,
      asOfLedger: maxLedger ?? asOfLedger,
      latestLedger: maxLedger,
    };
  }
}
