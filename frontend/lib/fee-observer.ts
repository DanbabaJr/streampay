/**
 * Fee observer — polls Soroban RPC `getFeeStats` and emits snapshots.
 *
 * Cadence: one poll per {@link DEFAULT_POLL_MS} (~6 s). Stellar closes a
 * ledger roughly every 5 s and `getFeeStats` summarizes the last `ledgerCount`
 * ledgers (50 on the public network), so polling faster than the ledger
 * cadence only re-reads the same distribution. Slower than ~15 s starts to
 * lag real fee moves. The window is documented in `docs/FEE_AWARE_CLAIMS.md`.
 *
 * The observer is deliberately dumb: it never decides, it just produces
 * {@link FeeSnapshot}s. The scheduler consumes them.
 */
import { rpc } from "@stellar/stellar-sdk";
import { parseFeeStats, type FeeSnapshot } from "./fee-stats";

/** Nominal Stellar ledger close time, ms. */
export const LEDGER_MS = 5_000;

/** Default poll interval, ms — one ledger plus a small margin. */
export const DEFAULT_POLL_MS = 6_000;

export interface FeeObserverOptions {
  /** Soroban RPC endpoint (e.g. `https://soroban-testnet.stellar.org`). */
  rpcUrl: string;
  /** Poll interval in ms. Defaults to {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Called on every successful observation. */
  onSnapshot: (snapshot: FeeSnapshot) => void;
  /** Called on RPC/parse failures; the loop keeps running. */
  onError?: (error: unknown) => void;
}

/**
 * Polls `getFeeStats` and reports snapshots. Overlapping polls are coalesced,
 * so a slow RPC never queues requests.
 */
export class FeeObserver {
  private readonly server: rpc.Server;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: FeeSnapshot | null = null;
  private inflight = false;

  constructor(private readonly options: FeeObserverOptions) {
    this.server = new rpc.Server(options.rpcUrl);
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  /** The most recent successful snapshot, or `null` before the first poll. */
  get current(): FeeSnapshot | null {
    return this.latest;
  }

  /** Starts polling immediately, then on the interval. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  /** Stops polling. Safe to call when already stopped. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const stats = await this.server.getFeeStats();
      const snapshot = parseFeeStats(stats, Date.now());
      if (snapshot) {
        this.latest = snapshot;
        this.options.onSnapshot(snapshot);
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.inflight = false;
    }
  }
}
