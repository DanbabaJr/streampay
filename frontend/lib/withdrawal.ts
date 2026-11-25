/**
 * Pure validation and formatting helpers for stream withdrawal operations.
 */

export interface WithdrawalValidationResult {
  valid: boolean;
  error?: string;
  overWithdrawal: boolean;
  amount: bigint;
}

/**
 * Mirrors the contract's `MIN_CLAIM_AMOUNT` (#78): the smallest single claim
 * `withdraw` / `withdraw_max` accept while a stream is still accruing, in token
 * base units (0.1 token at 7 decimals). See `docs/DUST_ECONOMICS.md`.
 */
export const MIN_CLAIM_AMOUNT = 1_000_000n;

/**
 * Mirrors the contract's `MIN_STREAM_DEPOSIT` (#78): the smallest deposit any
 * creation path accepts, in token base units (1 token at 7 decimals).
 */
export const MIN_STREAM_DEPOSIT = 10_000_000n;

/** What the claim floor needs to know about the stream and the clock. */
export interface ClaimFloorContext {
  /** Stream start, unix seconds. */
  startTime: number;
  /** Stream end, unix seconds. */
  endTime: number;
  /** Deposit in base units, used to estimate when the floor is reached. */
  deposit: bigint;
  /** The ledger-aligned "now", unix seconds. */
  nowSeconds: number;
  /**
   * Whether the stream is paused. The contract lifts the floor while paused;
   * pass `false` when unknown, and keep the contract as the final authority.
   */
  paused?: boolean;
}

/**
 * Whether the contract would refuse a sub-floor claim right now: only while
 * the stream window is still open and the stream is not paused. Mirrors
 * `dust::claim_floor_applies`.
 */
export function claimFloorApplies(ctx: ClaimFloorContext): boolean {
  return !ctx.paused && ctx.nowSeconds < ctx.endTime;
}

export type ClaimReadiness =
  | { state: "nothing" }
  | { state: "claimable" }
  | {
      /** Accrued, but below the floor while the stream still accrues. */
      state: "not-worth-claiming-yet";
      /** Base units still to accrue before a claim is accepted. */
      shortfall: bigint;
      /**
       * Estimated unix second at which the balance reaches the floor
       * (linear accrual at the stream's average rate), capped at `endTime`,
       * when the floor lifts anyway.
       */
      readyAt: number;
    };

/**
 * Classifies the accrued balance for the claim UI: nothing to claim, a balance
 * the contract would refuse as dust ("not worth claiming yet"), or claimable.
 */
export function claimReadiness(
  available: bigint | null,
  ctx: ClaimFloorContext
): ClaimReadiness {
  if (available === null || available <= 0n) return { state: "nothing" };
  if (available >= MIN_CLAIM_AMOUNT || !claimFloorApplies(ctx)) {
    return { state: "claimable" };
  }
  const shortfall = MIN_CLAIM_AMOUNT - available;
  const duration = BigInt(Math.max(1, ctx.endTime - ctx.startTime));
  let readyAt = ctx.endTime;
  if (ctx.deposit > 0n) {
    // ceil(shortfall * duration / deposit) seconds at the average rate.
    const wait = (shortfall * duration + ctx.deposit - 1n) / ctx.deposit;
    readyAt = Math.min(ctx.endTime, ctx.nowSeconds + Number(wait));
  }
  return { state: "not-worth-claiming-yet", shortfall, readyAt };
}

/**
 * Validates a user-input withdrawal amount against the available balance.
 * Prevents client-side over-withdrawal, negative amounts, and invalid numbers.
 * With a `floor` context it also refuses a mid-stream claim below
 * {@link MIN_CLAIM_AMOUNT}, which the contract would reject with
 * `ClaimBelowMinimum`.
 */
export function validateWithdrawal(
  amountStr: string,
  available: bigint | null,
  floor?: ClaimFloorContext
): WithdrawalValidationResult {
  const trimmed = amountStr.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "Please enter an amount to withdraw.",
      overWithdrawal: false,
      amount: 0n,
    };
  }

  let amount: bigint;
  try {
    amount = BigInt(trimmed);
  } catch {
    return {
      valid: false,
      error: "Invalid numeric amount.",
      overWithdrawal: false,
      amount: 0n,
    };
  }

  if (amount <= 0n) {
    return {
      valid: false,
      error: "Withdrawal amount must be greater than zero.",
      overWithdrawal: false,
      amount,
    };
  }

  if (available !== null && amount > available) {
    return {
      valid: false,
      error: `Amount exceeds the currently accrued ${available.toString()} units. The contract will reject this call with AmountExceedsAvailable.`,
      overWithdrawal: true,
      amount,
    };
  }

  if (floor !== undefined && amount < MIN_CLAIM_AMOUNT && claimFloorApplies(floor)) {
    return {
      valid: false,
      error: `Not worth claiming yet: while the stream is still accruing, claims below ${MIN_CLAIM_AMOUNT.toString()} units are refused (ClaimBelowMinimum) because the network fee would eat most of them. Wait for more to accrue, or claim any amount after the stream ends.`,
      overWithdrawal: false,
      amount,
    };
  }

  return {
    valid: true,
    overWithdrawal: false,
    amount,
  };
}

/**
 * Formats token units for display.
 */
export function fmtUnits(v: bigint | number | string): string {
  try {
    return BigInt(v).toString();
  } catch {
    return String(v);
  }
}

/** The contract's batch-claim cap (`stream::MAX_WITHDRAW_BATCH`), mirrored. */
export const MAX_WITHDRAW_BATCH = 20;

/**
 * Multi-select batch claiming is opt-in while `withdraw_many` is new: the
 * contract is the authority, this flag only gates the affordance.
 */
export const BATCH_CLAIM_ENABLED =
  process.env.NEXT_PUBLIC_BATCH_CLAIM === "1";

export interface BatchSelectionResult {
  valid: boolean;
  error?: string;
  /** The ids to send, in the order the contract will answer them. */
  ids: string[];
}

/**
 * Checks a batch-claim selection against the bounds `withdraw_many` enforces
 * on-chain, so an impossible request is caught before a wallet prompt instead
 * of as a failed transaction. The contract's own rejections are
 * `WithdrawBatchEmpty` (#96), `WithdrawBatchTooLarge` (#97) and
 * `WithdrawDuplicateStreamIds` (#98).
 */
export function validateBatchSelection(selection: string[]): BatchSelectionResult {
  if (selection.length === 0) {
    return {
      valid: false,
      error: "Select at least one stream to claim.",
      ids: [],
    };
  }
  if (selection.length > MAX_WITHDRAW_BATCH) {
    return {
      valid: false,
      error: `A single claim covers at most ${MAX_WITHDRAW_BATCH} streams.`,
      ids: [],
    };
  }
  if (new Set(selection).size !== selection.length) {
    return {
      valid: false,
      error: "A stream can only be claimed once per batch.",
      ids: [],
    };
  }
  return { valid: true, ids: [...selection] };
}
