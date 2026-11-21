/**
 * Framework-free live-accrual engine (issue #211).
 *
 * Owns the 15s simulate refresh + 1s local ticker loop used by the stream
 * detail views, with two seams the clock-skew suite drives:
 *
 *  - `nowMs` — the local wall clock (injectable fake timer source),
 *  - `readStream` — may report the server's ledger timestamp for the read;
 *    when it does, the engine anchors the ticker to ledger time instead of
 *    the local clock, which makes the guarded display obey the
 *    never-over-up contract even with a skewed local clock.
 *
 * Display rule (docs/TIME_HANDLING.md): the counter may re-anchor down
 * (stale-down) but may never show more than contract-available at the known
 * ledger moment plus one epsilon.
 */

import { type StreamSnapshot } from "./accrual.ts";
import {
  REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
  guardedLiveDisplay,
} from "./clock-skew.ts";

export type LiveStreamRead = StreamSnapshot & {
  /** `ledger().timestamp()` of the ledger the read was pinned to. */
  ledgerTime?: number;
};

export type LiveAccrualState = {
  snapshot: StreamSnapshot | null;
  /** Simulate-confirmed available: the value a withdraw action is guarded by. */
  available: bigint | null;
  displayAvailable: bigint | null;
  error: unknown;
};

export type LiveAccrualOptions = {
  readStream: () => Promise<LiveStreamRead>;
  readAvailable: () => Promise<bigint>;
  nowMs?: () => number;
  tickMs?: number;
  refreshMs?: number;
  onUpdate: (state: LiveAccrualState) => void;
};

export type LiveAccrual = {
  stop(): void;
  refresh(): Promise<void>;
};

export const INITIAL_STATE: LiveAccrualState = {
  snapshot: null,
  available: null,
  displayAvailable: null,
  error: null,
};

function toSeconds(ms: number): bigint {
  return BigInt(Math.floor(ms / 1000));
}

export function startLiveAccrual(options: LiveAccrualOptions): LiveAccrual {
  const nowMs = options.nowMs ?? ((): number => Date.now());
  const tickMs = options.tickMs ?? TICK_INTERVAL_MS;
  const refreshMs = options.refreshMs ?? REFRESH_INTERVAL_MS;

  let state = INITIAL_STATE;
  let anchor: { ledgerTime: bigint; localTime: bigint } | null = null;
  let stopped = false;

  const displayAt = (snapshot: StreamSnapshot, localTime: bigint): bigint => {
    const ledgerTime = anchor
      ? anchor.ledgerTime + (localTime - anchor.localTime)
      : localTime;
    return guardedLiveDisplay(snapshot, { localTime, ledgerTime });
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    try {
      const [stream, available] = await Promise.all([
        options.readStream(),
        options.readAvailable(),
      ]);
      if (stopped) return;
      const localTime = toSeconds(nowMs());
      const snapshot: StreamSnapshot = {
        deposit: stream.deposit,
        startTime: stream.startTime,
        endTime: stream.endTime,
        withdrawn: stream.withdrawn,
        status: stream.status,
      };
      anchor = {
        ledgerTime:
          stream.ledgerTime !== undefined
            ? BigInt(stream.ledgerTime)
            : localTime,
        localTime,
      };
      state = {
        snapshot,
        available,
        displayAvailable: displayAt(snapshot, localTime),
        error: null,
      };
      options.onUpdate(state);
    } catch (e) {
      if (stopped) return;
      state = { ...state, error: e };
      options.onUpdate(state);
    }
  };

  const tickTimer = setInterval(() => {
    if (stopped || !state.snapshot) return;
    const localTime = toSeconds(nowMs());
    const displayAvailable = displayAt(state.snapshot, localTime);
    if (displayAvailable === state.displayAvailable) return;
    state = { ...state, displayAvailable };
    options.onUpdate(state);
  }, tickMs);

  const refreshTimer = setInterval(() => {
    void refresh();
  }, refreshMs);

  void refresh();

  return {
    stop() {
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(refreshTimer);
    },
    refresh,
  };
}
