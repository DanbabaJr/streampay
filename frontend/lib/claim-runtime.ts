/**
 * Claim scheduler runtime — persists queued claims and acts on decisions.
 *
 * This is the thin, side-effecting shell around the pure core in
 * `claim-scheduler.ts`. It owns the queued claims for one scope, evaluates
 * each pending claim against a fee snapshot, and performs the one action the
 * decision names: ask the signer for a fresh intent, submit a held intent, or
 * wait. Signing and submitting are injected so the runtime stays testable and
 * so all contract interaction can live in `lib/stellar.ts`.
 *
 * Persistence goes through the shared {@link QueuedIntent} queue
 * (`pending-queue.ts`), tagged `kind: "claim"` — the same mechanism the PWA
 * offline queue (#48) uses.
 */
import {
  evaluateClaim,
  type ClaimEvaluation,
  type QueuedClaim,
  type SchedulerPolicy,
} from "./claim-scheduler";
import type { FeeSnapshot } from "./fee-stats";
import {
  loadQueue,
  newIntentId,
  removeIntent,
  saveQueue,
  upsertIntent,
  type QueuedIntent,
} from "./pending-queue";

/** Queue kind tag for scheduler intents. */
export const CLAIM_INTENT_KIND = "claim";

/** Produces (or refreshes) a signed intent for a claim. */
export type ClaimSigner = (
  claim: QueuedClaim
) => Promise<{ signedXdr: string; signedValidUntil: number }>;

/** Submits a signed intent and resolves with the transaction hash. */
export type ClaimSubmitter = (signedXdr: string) => Promise<{ hash: string }>;

export interface ClaimSchedulerEvents {
  /** Fired after any mutation to the claim list. */
  onUpdate?: (claims: QueuedClaim[]) => void;
  /** Fired for every evaluated pending claim. */
  onEvaluation?: (evaluation: ClaimEvaluation, claim: QueuedClaim) => void;
  /** Fired when signing or submitting fails. */
  onError?: (claim: QueuedClaim, error: unknown) => void;
}

function wrap(claim: QueuedClaim): QueuedIntent<QueuedClaim> {
  return {
    id: claim.id,
    kind: CLAIM_INTENT_KIND,
    scope: "",
    createdAt: claim.createdAt,
    updatedAt: Math.floor(Date.now() / 1000),
    payload: claim,
  };
}

/** Owns the queued claims for one scope and drives them from fee snapshots. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class ClaimScheduler {
  private claims: QueuedClaim[];
  private readonly busy = new Set<string>();
  /** Last automatic sign attempt per claim, to respect the re-sign cooldown. */
  private readonly signAttemptAt = new Map<string, number>();

  constructor(
    private readonly scope: string,
    private policy: SchedulerPolicy,
    private readonly deps: { sign: ClaimSigner; submit: ClaimSubmitter },
    private readonly events: ClaimSchedulerEvents = {}
  ) {
    this.claims = loadQueue<QueuedClaim>(scope)
      .filter((intent) => intent.kind === CLAIM_INTENT_KIND)
      .map((intent) => intent.payload)
      .filter((claim) => claim.status === "pending");
    // Emit the loaded queue so subscribers can render it immediately, without
    // the owner having to copy state after construction.
    this.events.onUpdate?.([...this.claims]);
  }

  /** Current queued claims, oldest first. */
  get all(): QueuedClaim[] {
    return this.claims;
  }

  /** Replaces the active policy (e.g. after a settings change). */
  setPolicy(policy: SchedulerPolicy): void {
    this.policy = policy;
  }

  /** Adds a new pending claim (id assigned if missing). */
  enqueue(claim: QueuedClaim): QueuedClaim[] {
    const withId: QueuedClaim = claim.id ? claim : { ...claim, id: newIntentId() };
    this.claims = [...this.claims.filter((c) => c.id !== withId.id), withId];
    this.persist();
    return this.claims;
  }

  /** Drops a claim entirely (user cancelled the schedule). */
  remove(id: string): QueuedClaim[] {
    this.claims = this.claims.filter((claim) => claim.id !== id);
    removeIntent<QueuedClaim>(this.scope, id);
    this.events.onUpdate?.(this.claims);
    return this.claims;
  }

  /**
   * Evaluates every pending claim against one fee snapshot and performs the
   * named action. Safe to call frequently; busy claims are skipped so a slow
   * submit never overlaps itself.
   */
  async tick(
    fee: FeeSnapshot,
    now: number = Math.floor(Date.now() / 1000)
  ): Promise<void> {
    for (const claim of [...this.claims]) {
      if (claim.status !== "pending" || this.busy.has(claim.id)) continue;
      const evaluation = evaluateClaim(claim, fee, this.policy, now);
      this.events.onEvaluation?.(evaluation, claim);
      if (evaluation.action === "submit") {
        await this.submit(claim);
      } else if (evaluation.action === "resign") {
        await this.sign(claim, now);
      }
    }
    this.persist();
  }

  /** Forces a fresh signature for a claim (e.g. after "Re-sign" in the UI). */
  async refreshSignature(id: string): Promise<void> {
    const claim = this.claims.find((c) => c.id === id);
    if (!claim || claim.status !== "pending") return;
    await this.sign(claim, nowSeconds(), true);
    this.persist();
  }

  /** Attempts an immediate submit regardless of fee (UI "Submit now"). */
  async submitNow(id: string): Promise<void> {
    let claim = this.claims.find((c) => c.id === id);
    if (!claim || claim.status !== "pending") return;
    if (claim.signedXdr === null) {
      await this.sign(claim, nowSeconds(), true);
      // `sign` replaces the claim record in-place, so the reference we held is
      // stale; re-read it before deciding whether there is anything to submit.
      claim = this.claims.find((c) => c.id === id);
      if (!claim || claim.signedXdr === null) return;
    }
    await this.submit(claim);
    this.persist();
  }

  private async sign(
    claim: QueuedClaim,
    now: number,
    force = false
  ): Promise<void> {
    if (this.busy.has(claim.id)) return;
    const lastAttempt = this.signAttemptAt.get(claim.id) ?? 0;
    if (!force && now - lastAttempt < this.policy.resignCooldownSeconds) return;
    this.signAttemptAt.set(claim.id, now);
    this.busy.add(claim.id);
    try {
      const { signedXdr, signedValidUntil } = await this.deps.sign(claim);
      this.replace(claim.id, { signedXdr, signedValidUntil, lastError: undefined });
    } catch (error) {
      this.replace(claim.id, {
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.events.onError?.(claim, error);
    } finally {
      this.busy.delete(claim.id);
    }
  }

  private async submit(claim: QueuedClaim): Promise<void> {
    if (claim.signedXdr === null || this.busy.has(claim.id)) return;
    this.busy.add(claim.id);
    try {
      const { hash } = await this.deps.submit(claim.signedXdr);
      this.replace(claim.id, {
        status: "submitted",
        txHash: hash,
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A rejected/stale envelope is useless — drop it so the next tick re-signs.
      this.replace(claim.id, {
        attempts: claim.attempts + 1,
        lastError: message,
        signedXdr: null,
        signedValidUntil: null,
      });
      this.events.onError?.(claim, error);
    } finally {
      this.busy.delete(claim.id);
    }
  }

  private replace(id: string, patch: Partial<QueuedClaim>): void {
    this.claims = this.claims.map((claim) =>
      claim.id === id ? { ...claim, ...patch } : claim
    );
    this.events.onUpdate?.(this.claims);
  }

  private persist(): void {
    // Persist only claims still worth resuming; terminal ones are dropped.
    const pending = this.claims.filter((claim) => claim.status === "pending");
    saveQueue<QueuedClaim>(
      this.scope,
      pending.map((claim) => ({ ...wrap(claim), scope: this.scope }))
    );
    this.events.onUpdate?.(this.claims);
  }
}

/** Convenience: build a fresh pending claim for a stream. */
export function buildQueuedClaim(args: {
  streamId: string;
  recipient: string;
  streamStartTime: number;
  streamEndTime: number;
  now?: number;
}): QueuedClaim {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  return {
    id: newIntentId(),
    streamId: args.streamId,
    recipient: args.recipient,
    signedXdr: null,
    signedValidUntil: null,
    streamStartTime: args.streamStartTime,
    streamEndTime: args.streamEndTime,
    createdAt: now,
    status: "pending",
    attempts: 0,
  };
}

// `upsertIntent` is re-exported for the settings UI so it can persist a single
// claim without rebuilding the whole queue.
export { upsertIntent };
