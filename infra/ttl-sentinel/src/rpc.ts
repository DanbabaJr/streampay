//! Minimal JSON-RPC client for the read paths the sentinel needs.
//!
//! Hand-rolled instead of the SDK's RPC server so the core stays injectable
//! (tests substitute a fake) and so the read-only core never pulls in signing
//! code paths. Field names follow the Stellar RPC reference:
//! `getLedgerEntries` → `{ latestLedger, entries: [{ key, xdr,
//! lastModifiedLedgerSeq, liveUntilLedgerSeq? }] }`.

export interface LedgerEntryObs {
  /** Base64 LedgerKey. */
  key: string;
  /** Base64 LedgerEntryData — absent when the entry is not live. */
  xdr?: string;
  lastModifiedLedgerSeq?: number;
  /** Zero/absent means the entry is no longer live. */
  liveUntilLedgerSeq?: number;
}

export interface LedgerEntriesResult {
  latestLedger: number;
  entries: LedgerEntryObs[];
}

export interface LatestLedgerResult {
  sequence: number;
}

/** The read surface the scanner depends on. Tests provide a fake. */
export interface RpcClient {
  getLatestLedger(): Promise<LatestLedgerResult>;
  getLedgerEntries(keys: string[]): Promise<LedgerEntriesResult>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class HttpRpcClient implements RpcClient {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${method}`, method, res.status);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new RpcError(`non-JSON response from ${method}`, method);
      }
      const msg = parsed as { error?: { code?: number; message?: string; data?: unknown }; result?: T };
      if (msg.error) {
        throw new RpcError(msg.error.message ?? `rpc error`, method, msg.error.code, msg.error.data);
      }
      if (msg.result === undefined) throw new RpcError(`missing result from ${method}`, method);
      return msg.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getLatestLedger(): Promise<LatestLedgerResult> {
    const result = await this.call<{ sequence?: number; ledger?: number }>('getLatestLedger', {});
    const sequence = result.sequence ?? result.ledger;
    if (typeof sequence !== 'number') throw new RpcError('getLatestLedger returned no sequence', 'getLatestLedger');
    return { sequence };
  }

  async getLedgerEntries(keys: string[]): Promise<LedgerEntriesResult> {
    const result = await this.call<{ latestLedger?: number; entries?: LedgerEntryObs[] }>('getLedgerEntries', {
      keys,
      xdrFormat: 'base64',
    });
    return {
      latestLedger: typeof result.latestLedger === 'number' ? result.latestLedger : 0,
      entries: Array.isArray(result.entries) ? result.entries : [],
    };
  }
}
