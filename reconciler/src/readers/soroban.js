//! Soroban RPC reader that polls contract state for stream information.

import { createHttpAgent } from "./http.js";
import type { StreamState, SorobanStreamStorage } from "./types.js";

export interface SorobanRpcReaderConfig {
  url: string;
  token?: string;
  pollIntervalMs: number;
  contractId: string; // StreamPay contract ID
}

export class SorobanRpcReader {
  private config: SorobanRpcReaderConfig;
  private http = createHttpAgent();
  private healthy = false;

  constructor(config: SorobanRpcReaderConfig) {
    this.config = config;
  }

  /**
   * Check if Soroban RPC is healthy and reachable.
   */
  async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await this.http.get(`${this.config.url}`);
      this.healthy = response.status === 200;
      return { healthy: this.healthy };
    } catch (err) {
      this.healthy = false;
      return {
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Poll for current state of multiple streams.
   * Returns array of StreamState objects.
   */
  async pollStreams(streamIds: string[]): Promise<StreamState[]> {
    if (streamIds.length === 0) return [];

    try {
      // For efficiency, we could batch these requests, but Soroban RPC
      // doesn't have a bulk getContractData endpoint, so we do them sequentially
      // with reasonable concurrency
      
      const states = await Promise.all(
        streamIds.map(id => this.getStreamState(id))
      );
      
      return states.filter((state): state is StreamState => state !== null);
    } catch (err) {
      this.healthy = false;
      console.warn(`Soroban RPC reader error: ${err}`);
      return []; // Return empty on error
    }
  }

  /**
   * Get the current on-chain state for a single stream.
   */
  async getStreamState(streamId: string): Promise<StreamState | null> {
    try {
      // Stream data is stored in a map where key is streamId (as bytes)
      // We need to read multiple contract data entries to reconstruct a stream
      
      const [
        depositRes,
        withdrawnRes,
        startTimeRes,
        endTimeRes,
        cancelableRes,
        statusRes,
      ] = await Promise.allSettled([
        this.getContractData(`stream:${streamId}:deposit`),
        this.getContractData(`stream:${streamId}:withdrawn`),
        this.getContractData(`stream:${streamId}:start_time`),
        this.getContractData(`stream:${streamId}:end_time`),
        this.getContractData(`stream:${streamId}:cancelable`),
        this.getContractData(`stream:${streamId}:status`),
      ]);

      // Check if we got essential data
      if (depositRes.status !== "fulfilled" || withdrawnRes.status !== "fulfilled") {
        return null; // Stream not found or incomplete data
      }

      // Parse the XDR-encoded values from Soroban RPC
      const parseValue = (res: PromiseSettledResult<{ xdr?: string }>): string | null => {
        if (res.status !== "fulfilled" || !res.value?.xdr) return null;
        try {
          // In a real implementation, we'd decode the XDR properly
          // For now, we'll return raw string values as placeholders
          return res.value.xdr;
        } catch {
          return null;
        }
      };

      const deposit = parseValue(depositRes) ?? "0";
      const withdrawn = parseValue(withdrawnRes) ?? "0";
      const startTime = parseValue(startTimeRes) ?? null;
      const endTime = parseValue(endTimeRes) ?? null;
      const cancelableStr = parseValue(cancelableRes);
      const cancelable = cancelableStr === "true" || cancelableStr === "1";
      const statusStr = parseValue(statusRes) ?? "Active";

      // Validate status
      const status: StreamStatus = 
        ["Active", "Cancelled", "Depleted"].includes(statusStr as StreamStatus) 
          ? (statusStr as StreamStatus) 
          : "Active";

      return {
        streamId,
        ledger: Date.now(), // In reality, we'd get this from the RPC response
        timestamp: new Date().toISOString(),
        data: {
          deposit,
          withdrawn,
          status,
        },
      };
    } catch (err) {
      console.warn(`Failed to get stream state for ${streamId}: ${err}`);
      return null;
    }
  }

  /**
   * Helper to read a single contract data entry.
   */
  private async getContractData(key: string): Promise<{ xdr?: string }> {
    // Soroban RPC endpoint: POST /rpc/getContractData
    const body = {
      contractId: this.config.contractId,
      key: this.scvalToBytes(key), // Convert string key to bytes (xdr)
    };

    const response = await this.http.post(
      `${this.config.url}/rpc/getContractData`,
      body
    );

    if (response.status !== 200) {
      throw new Error(`Soroban RPC error: ${response.status}`);
    }

    // Response format: { xdr: "AAAA..." } or similar
    return response.data as { xdr?: string };
  }

  /**
   * Convert a string key to its byte representation for Soroban contract data keys.
   * In reality, we'd use proper SCVal encoding, but for simplicity:
   */
  private scvalToBytes(str: string): string {
    // Convert string to hex-encoded bytes
    // This is a simplified version - real implementation would use stellar-sdk
    return Buffer.from(str).toString("hex");
  }

  /**
   * Get the latest ledger from Soroban RPC for health checking.
   */
  async getLatestLedger(): Promise<number | null> {
    try {
      const response = await this.http.get(`${this.config.url}`);
      if (response.status === 200 && typeof response.data === "object" && response.data !== null) {
        // Extract ledger from response - this depends on RPC implementation
        return (response.data as any).ledger ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }
}

// Re-export types for consumers
export type { SorobanRpcReaderConfig };
export type { StreamState, SorobanStreamStorage } from "./types.js";