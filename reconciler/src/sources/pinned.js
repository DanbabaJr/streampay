//! Pinned snapshot collection from the three reconciliation sources.

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function horizonAdapter(reader) {
  return {
    source: "horizon",
    async latestLedger() {
      await reader.updateLastLedger();
      const health = await reader.healthCheck();
      return Number.isFinite(health.lastLedger) ? health.lastLedger : null;
    },
    async snapshot(streamIds, asOfLedger) {
      const states = await reader.pollStreams(streamIds, asOfLedger);
      return { states, asOfLedger };
    },
  };
}

export function rpcAdapter(reader) {
  return {
    source: "rpc",
    latestLedger: () => reader.getLatestLedger(),
    async snapshot(streamIds, asOfLedger) {
      const states = await reader.pollStreams(streamIds, asOfLedger);
      return { states, asOfLedger };
    },
  };
}

export function projectionAdapter(reader) {
  return {
    source: "projection",
    latestLedger: (streamIds) => reader.latestLedger(streamIds),
    snapshot: (streamIds, asOfLedger) => reader.snapshot(streamIds, asOfLedger),
  };
}

/**
 * Read every source at one pinned ledger. Sources that fail are returned as
 * unavailable snapshots instead of throwing, so the engine can degrade
 * explicitly rather than silently comparing a truncated set.
 */
/**
 * Collect one snapshot per source pinned to a single as-of ledger.
 *
 * @param {{
 *   adapters: Array<any>,
 *   streamIds: string[],
 *   asOfLedger?: number | null,
 *   timeoutMs?: number
 * }} [options]
 */
export async function collectPinnedSnapshots({
  adapters,
  streamIds,
  asOfLedger = null,
  timeoutMs = 15_000,
} = {}) {
  const latest = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        const ledger = await withTimeout(
          Promise.resolve(adapter.latestLedger(streamIds)),
          timeoutMs,
          `${adapter.source} ledger read`
        );
        return { source: adapter.source, ledger: Number.isFinite(ledger) ? ledger : null };
      } catch (error) {
        return { source: adapter.source, ledger: null, error: message(error) };
      }
    })
  );
  const ledgers = latest.map((entry) => entry.ledger).filter(Number.isFinite);
  const pinned = Number.isFinite(asOfLedger)
    ? asOfLedger
    : ledgers.length > 0
      ? Math.max(...ledgers)
      : null;

  const snapshots = await Promise.all(
    adapters.map(async (adapter, index) => {
      const ledgerRead = latest[index];
      try {
        const result = await withTimeout(
          Promise.resolve(adapter.snapshot(streamIds, pinned)),
          timeoutMs,
          `${adapter.source} snapshot`
        );
        return {
          source: adapter.source,
          available: true,
          latestLedger: ledgerRead.ledger,
          asOfLedger: Number.isFinite(result?.asOfLedger) ? result.asOfLedger : pinned,
          fetchedAt: new Date().toISOString(),
          states: result?.states ?? [],
        };
      } catch (error) {
        return {
          source: adapter.source,
          available: false,
          latestLedger: ledgerRead.ledger,
          asOfLedger: ledgerRead.ledger,
          fetchedAt: new Date().toISOString(),
          error: ledgerRead.error ? `${ledgerRead.error}; ${message(error)}` : message(error),
          states: [],
        };
      }
    })
  );

  return { asOfLedger: pinned, snapshots };
}
