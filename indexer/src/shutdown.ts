/**
 * Graceful shutdown for the indexer process.
 *
 * On SIGTERM/SIGINT the process must not be torn down while work is half
 * applied. The order below is what makes every exit point consistent:
 *
 * 1. Stop admitting work: poll timer cleared, HTTP listener closed, webhook and
 *    outbox timers stopped, the ingest pipeline told to stop between windows.
 * 2. Drain, under ONE shared deadline (`drainMs`):
 *    - ingest: the tick in flight finishes the window it is committing. A window
 *      commits in a single transaction (journal + outbox intents + resume
 *      position), so a tick cut off before commit leaves nothing behind and the
 *      next process re-reads that window.
 *    - outbox: the tick in flight records its delivery outcome; no new intent is
 *      claimed. On timeout the claims this process still holds are released back
 *      to `pending`, never left `in_flight`.
 * 3. Only then close the store and exit. Exit code is 0 when everything drained
 *    inside the window and 1 when the deadline forced the exit (state is still
 *    consistent; the code lets an orchestrator see that it was not clean).
 */

export interface ShutdownDeps {
  /** Total time allowed for step 2. */
  drainMs: number;
  /** Clear the poll timer and close the HTTP listener (including open SSE streams). */
  stopAccepting: () => void;
  /** Stops issuing/committing ingest windows after the current one. */
  pipeline?: { requestStop(): void };
  /** The ingest tick currently running, if any. */
  inFlightIngest: () => Promise<unknown> | null;
  outbox: { shutdown(timeoutMs: number): Promise<{ drained: boolean; released: number }> };
  webhooks: { stop(): void };
  store: { close(): void };
  exit: (code: number) => void;
  log?: (message: string) => void;
}

export interface ShutdownResult {
  ingestDrained: boolean;
  outboxDrained: boolean;
  releasedClaims: number;
  exitCode: 0 | 1;
}

/** Resolves true if `work` settled (either way) before `ms` elapsed. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([work.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function createGracefulShutdown(deps: ShutdownDeps): () => Promise<ShutdownResult> {
  const log = deps.log ?? (() => undefined);
  let running: Promise<ShutdownResult> | null = null;

  async function run(): Promise<ShutdownResult> {
    const deadline = Date.now() + deps.drainMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());

    deps.stopAccepting();
    deps.webhooks.stop();
    deps.pipeline?.requestStop();

    const ingest = deps.inFlightIngest();
    const [ingestDrained, outbox] = await Promise.all([
      ingest ? settlesWithin(ingest, remaining()) : Promise.resolve(true),
      deps.outbox.shutdown(remaining()),
    ]);

    const clean = ingestDrained && outbox.drained;
    if (!ingestDrained) log("[indexer] shutdown: ingest tick did not finish in the drain window; its window was not committed");
    if (!outbox.drained) log(`[indexer] shutdown: outbox dispatch did not finish in the drain window; released ${outbox.released} claim(s) for redelivery`);

    try {
      deps.store.close();
    } catch (error) {
      log(`[indexer] shutdown: store close failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const result: ShutdownResult = {
      ingestDrained,
      outboxDrained: outbox.drained,
      releasedClaims: outbox.released,
      exitCode: clean ? 0 : 1,
    };
    deps.exit(result.exitCode);
    return result;
  }

  // A second signal while draining joins the shutdown already running.
  return () => (running ??= run());
}

/** Registers `shutdown` for each signal on `proc` (the real `process`, or a test emitter). */
export function installShutdownHandlers(
  proc: { on(signal: NodeJS.Signals, listener: () => void): unknown },
  signals: readonly NodeJS.Signals[],
  shutdown: () => Promise<unknown>
): void {
  for (const signal of signals) {
    proc.on(signal, () => {
      void shutdown().catch((error) => console.error("[indexer] shutdown failed:", error));
    });
  }
}
