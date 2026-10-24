//! Horizon API reader that polls for effects related to StreamPay streams.

import { createHttpAgent } from "./http.js";
import type { StreamState, HorizonStreamEffect } from "./types.js";

export interface HorizonReaderConfig {
  url: string;
  token?: string;
  pollIntervalMs: number;
  contractAccount?: string; // StreamPay contract account on Horizon
}

export class HorizonReader {
  private config: HorizonReaderConfig;
  private http = createHttpAgent();
  private lastLedger = 0;
  private healthy = false;

  constructor(config: HorizonReaderConfig) {
    this.config = config;
  }

  /**
   * Check if Horizon is healthy and reachable.
   */
  async healthCheck(): Promise<{ healthy: boolean; lastLedger?: number; error?: string }> {
    try {
      const response = await this.http.get(`${this.config.url}/`);
      this.healthy = response.status === 200;
      // Try to extract latest ledger from response headers or body
      return {
        healthy: this.healthy,
        lastLedger: this.lastLedger,
      };
    } catch (err) {
      this.healthy = false;
      return {
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Poll for effects that indicate stream state changes since lastLedger.
   * Returns array of StreamState objects representing current known state.
   */
  async pollStreams(streamIds: string[]): Promise<StreamState[]> {
    try {
      // In a full implementation, we would:
      // 1. Query Horizon for effects related to stream operations
      // 2. Parse those effects to reconstruct stream state
      // 3. Return the latest known state for each streamId
      
      // For now, return empty array to avoid breaking the reconciliation loop
      // This is a placeholder that will be enhanced with actual Horizon integration
      
      // Simulate fetching effects for known streams
      if (streamIds.length === 0) return [];
      
      // TODO: Implement actual Horizon effects querying
      // Example: Query /accounts/{account}/effects?cursor=...
      
      return streamIds.map(id => ({
        streamId: id,
        ledger: this.lastLedger,
        timestamp: new Date().toISOString(),
        data: {
          deposit: "0",
          withdrawn: "0",
          status: "Active" as const, // Placeholder
        },
      }));
    } catch (err) {
      this.healthy = false;
      console.warn(`Horizon reader error: ${err}`);
      return []; // Return empty on error to allow Soroban data to dominate
    }
  }

  /**
   * Get historical effects for a specific stream from a ledger onwards.
   */
  async getHistoricalData(streamId: string, fromLedger: number): Promise<StreamState[]> {
    // TODO: Implement historical data fetching
    return [];
  }

  /**
   * Update internal state based on latest known ledger.
   */
  async updateLastLedger(): Promise<void> {
    try {
      const response = await this.http.get(`${this.config.url}/ledgers?limit=1&order=desc`);
      if (response.status === 200 && Array.isArray(response.data._embedded?.records)) {
        const ledger = response.data._embedded?.records[0]?.sequence;
        if (ledger && typeof ledger === "number") {
          this.lastLedger = ledger;
          this.healthy = true;
        }
      }
    } catch (err) {
      this.healthy = false;
      // Don't throw - ledger update is best-effort
    }
  }
}

// Re-export types for consumers
export type { HorizonReaderConfig };
export type { StreamState, HorizonStreamEffect } from "./types.js";