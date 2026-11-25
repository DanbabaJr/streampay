/**
 * Fee-aware claim scheduling — the pure decision core.
 *
 * A recipient can let StreamPay hold a *signed* `withdraw_max` intent and
 * submit it when the Soroban inclusion-fee percentile is cheap, instead of
 * paying whatever the network charges the moment they click "claim". This
 * module contains only the decision math: given a fee observation, a queued
 * claim and a policy, it returns one action. It performs no I/O and imports
 * nothing at runtime, which is what makes the replay simulation (and its
 * committed decisions table) deterministic.
 *
 * Wire-up lives in `fee-observer.ts` (RPC polling), `claim-runtime.ts`
 * (queue + submit), `pending-queue.ts` (storage) and the settings UI.
 *
 * ## The two deadlines
 *
 * A stream is `[start_time, end_time)` and accrues linearly; at `end_time` it
 * is fully mature (`streamed == deposit`). Two facts shape the deadline:
 *
 *   1. **Funds never evaporate.** The full deposit stays in the contract until
 *      withdrawn. After `end_time` the recipient can still claim everything,
 *      and a cancellation pays out the accrued balance atomically in the same
 *      transaction. So a claim can never be "missed" — only *deferred*.
 *   2. **A signature does expire.** The queued intent is a real signed
 *      transaction with a `maxTime`; past it the envelope is dead and the user
 *      must re-sign. This is the only hard wall the scheduler races.
 *
 * The deadline rule therefore is: stop optimizing once we reach
 * `stream_end_time - deadlineLeadSeconds` and submit at the next tick no
 * matter the fee (the fallback), and never let a live signature cross its
 * `maxTime - submitLeadSeconds` window without being submitted or replaced.
 */

import type { FeePercentileKey, FeePercentiles, FeeSnapshot } from "./fee-stats";
import { FEE_PERCENTILE_KEYS, feeAt } from "./fee-stats";

export { FEE_PERCENTILE_KEYS };
export type { FeePercentileKey, FeePercentiles, FeeSnapshot };

/** Lifecycle of one queued claim. Only `pending` is actionable. */
export type ClaimStatus =
  | "pending"
  | "submitted"
  | "failed"
  | "expired"
  | "cancelled";

/** A recipient's signed-intent claim, held until the fee is right. */
export interface QueuedClaim {
  /** Client-generated id (see `pending-queue.ts`). */
  id: string;
  streamId: string;
  recipient: string;
  /** Base64 signed envelope XDR; `null` while awaiting a signature. */
  signedXdr: string | null;
  /**
   * Unix seconds after which `signedXdr` is dead (the tx's `maxTime`).
   * `null` when no signature is held yet.
   */
  signedValidUntil: number | null;
  /** Unix seconds the stream began accruing — nothing is claimable before. */
  streamStartTime: number;
  /** Unix seconds the stream matures (`end_time`). */
  streamEndTime: number;
  /** Unix seconds the claim was queued. */
  createdAt: number;
  status: ClaimStatus;
  /** Submission attempts so far (diagnostics). */
  attempts: number;
  lastError?: string;
  txHash?: string;
}

/** User-tunable scheduling behaviour. */
export interface SchedulerPolicy {
  /** Master switch; when false the scheduler never acts. */
  enabled: boolean;
  /** Which Soroban inclusion-fee percentile to compare against the budget. */
  percentile: FeePercentileKey;
  /** Submit when the chosen percentile is ≤ this (stroops). */
  maxFeeStroops: number;
  /** Fall back to an immediate submit this many seconds before stream end. */
  deadlineLeadSeconds: number;
  /** Submit a still-valid signature before it gets this close to `maxTime`. */
  submitLeadSeconds: number;
  /** How long a freshly signed intent stays valid (the tx `maxTime` window). */
  intentValiditySeconds: number;
  /**
   * Minimum seconds between automatic re-signing attempts for one claim. Stops
   * a failed/lapsed signature from re-prompting the wallet every tick.
   */
  resignCooldownSeconds: number;
}

/**
 * Defaults: median Soroban inclusion fee ≤ 150 stroops, submit anyway in the
 * last 15 minutes of the stream, keep a 1-hour signature window. Deliberately
 * conservative — the base inclusion fee is 100 stroops.
 */
export const DEFAULT_POLICY: SchedulerPolicy = {
  enabled: false,
  percentile: "p50",
  maxFeeStroops: 150,
  deadlineLeadSeconds: 900,
  submitLeadSeconds: 120,
  intentValiditySeconds: 3600,
  resignCooldownSeconds: 120,
};

export type ClaimAction = "wait" | "resign" | "submit" | "done";

export type DecisionReason =
  | "already-terminal"
  | "disabled"
  | "too-early"
  | "awaiting-signature"
  | "signature-expired"
  | "fee-above-threshold"
  | "fee-below-threshold"
  | "intent-expiring"
  | "deadline-fallback";

/** One scheduler decision plus the numbers behind it. */
export interface ClaimEvaluation {
  /** Unix seconds the decision was made at. */
  now: number;
  action: ClaimAction;
  reason: DecisionReason;
  /** The observed Soroban percentile the policy selected (stroops). */
  feeStroops: number;
  /** The policy budget it was compared against (stroops). */
  thresholdStroops: number;
  /** Ledger the fee observation came from. */
  feeLedger: number;
  /** Seconds until the stream matures (negative after it has). */
  secondsToStreamEnd: number;
  /** Seconds until the held signature dies, or `null` when none is held. */
  secondsToIntentExpiry: number | null;
}

const TERMINAL: readonly ClaimStatus[] = [
  "submitted",
  "failed",
  "expired",
  "cancelled",
];

/**
 * The decision ladder, evaluated top to bottom. First match wins:
 *
 *   1. terminal call                     → done
 *   2. scheduling disabled               → wait (disabled)
 *   3. before anything has accrued       → wait (too-early)
 *   4. no signature held                 → resign (awaiting-signature)
 *   5. signature already dead            → resign (signature-expired)
 *   6. inside the deadline window        → submit (deadline-fallback)
 *   7. signature about to die            → submit (intent-expiring)
 *   8. fee percentile ≤ budget           → submit (fee-below-threshold)
 *   9. otherwise                         → wait (fee-above-threshold)
 *
 * Steps 6 and 7 can never both fire on contradictory terms: 5 re-signs a dead
 * envelope before 6/7 ever look at it.
 */
export function evaluateClaim(
  claim: QueuedClaim,
  fee: FeeSnapshot,
  policy: SchedulerPolicy,
  now: number = Math.floor(Date.now() / 1000)
): ClaimEvaluation {
  const feeStroops = feeAt(fee.soroban, policy.percentile);
  const thresholdStroops = policy.maxFeeStroops;
  const secondsToStreamEnd = claim.streamEndTime - now;
  const secondsToIntentExpiry =
    claim.signedValidUntil === null ? null : claim.signedValidUntil - now;

  const base = {
    now,
    feeStroops,
    thresholdStroops,
    feeLedger: fee.ledger,
    secondsToStreamEnd,
    secondsToIntentExpiry,
  };

  if (TERMINAL.includes(claim.status)) {
    return { ...base, action: "done", reason: "already-terminal" };
  }
  if (!policy.enabled) {
    return { ...base, action: "wait", reason: "disabled" };
  }
  // Nothing is claimable during the stream's opening second.
  if (now <= claim.streamStartTime) {
    return { ...base, action: "wait", reason: "too-early" };
  }
  if (claim.signedXdr === null || claim.signedValidUntil === null) {
    return { ...base, action: "resign", reason: "awaiting-signature" };
  }
  if (now >= claim.signedValidUntil) {
    return { ...base, action: "resign", reason: "signature-expired" };
  }
  if (now >= claim.streamEndTime - policy.deadlineLeadSeconds) {
    return { ...base, action: "submit", reason: "deadline-fallback" };
  }
  if (now >= claim.signedValidUntil - policy.submitLeadSeconds) {
    return { ...base, action: "submit", reason: "intent-expiring" };
  }
  if (feeStroops <= thresholdStroops) {
    return { ...base, action: "submit", reason: "fee-below-threshold" };
  }
  return { ...base, action: "wait", reason: "fee-above-threshold" };
}

export interface ReplayOptions {
  /**
   * When > 0, a `resign` decision is simulated as a successful re-signature
   * with a fresh window of this many seconds — i.e. the runtime asked the
   * wallet for a new intent. Default 0 keeps the envelope fixed, so a stale
   * signature surfaces as a repeated `resign` and the table makes the cost
   * of not refreshing obvious.
   */
  refreshValiditySeconds?: number;
}

/**
 * Replays a recorded fee series against one claim and returns the decision
 * taken at each sample, stopping after the claim is submitted (or when the
 * series ends). This is the function behind the simulation test and the
 * committed decisions table.
 */
export function replaySeries(
  samples: readonly FeeSnapshot[],
  claim: QueuedClaim,
  policy: SchedulerPolicy,
  options: ReplayOptions = {}
): ClaimEvaluation[] {
  const refresh = options.refreshValiditySeconds ?? 0;
  let working: QueuedClaim = { ...claim };
  const rows: ClaimEvaluation[] = [];
  for (const sample of samples) {
    const now = Math.floor(sample.observedAt / 1000);
    const evaluation = evaluateClaim(working, sample, policy, now);
    rows.push(evaluation);
    if (evaluation.action === "submit") break;
    if (evaluation.action === "resign" && refresh > 0) {
      // Model the runtime refreshing the envelope with a fresh `maxTime`.
      working = {
        ...working,
        signedXdr: "re-signed-envelope",
        signedValidUntil: now + refresh,
      };
    }
  }
  return rows;
}

/** Renders the replay output as a markdown table for a PR description. */
export function renderDecisionsTable(rows: readonly ClaimEvaluation[]): string {
  const header =
    "| # | t (unix) | since end | since sig | fee stroops | budget | action | reason |";
  const sep =
    "|---|----------|-----------|-----------|-------------|--------|--------|--------|";
  const body = rows.map((r, i) => {
    const sinceEnd = `${r.secondsToStreamEnd}s`;
    const sinceSig =
      r.secondsToIntentExpiry === null ? "—" : `${r.secondsToIntentExpiry}s`;
    return `| ${i + 1} | ${r.now} | ${sinceEnd} | ${sinceSig} | ${r.feeStroops} | ${r.thresholdStroops} | ${r.action} | ${r.reason} |`;
  });
  return [header, sep, ...body].join("\n");
}
