import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import ClaimSchedulerSettings from "./ClaimSchedulerSettings";
import { DEFAULT_POLICY, type QueuedClaim } from "@/lib/claim-scheduler";
import type { FeePercentiles, FeeSnapshot } from "@/lib/fee-stats";
import type { UseClaimSchedulerResult } from "@/lib/use-claim-scheduler";
import { FIXED_NOW_MS, FIXED_NOW_SECONDS } from "../.storybook/fake-clock";
import { RECIPIENT, activeStream } from "../.storybook/fixtures";

const percentiles = (base: number): FeePercentiles => ({
  min: base / 2,
  p10: base * 0.6,
  p20: base * 0.7,
  p30: base * 0.8,
  p40: base * 0.9,
  p50: base,
  p60: base * 1.2,
  p70: base * 1.5,
  p80: base * 2,
  p90: base * 3,
  p95: base * 4,
  p99: base * 8,
  mode: base,
  max: base * 10,
});

const fee = (p50: number): FeeSnapshot => ({
  ledger: 1_234_567,
  observedAt: FIXED_NOW_MS,
  soroban: percentiles(p50),
  classic: percentiles(100),
});

const pendingClaim: QueuedClaim = {
  id: "c1a2b3c4-0000-4000-8000-000000000001",
  streamId: activeStream.id,
  recipient: RECIPIENT,
  signedXdr: "AAAA",
  signedValidUntil: FIXED_NOW_SECONDS + 3600,
  streamStartTime: activeStream.startTime,
  streamEndTime: activeStream.endTime,
  createdAt: FIXED_NOW_SECONDS - 600,
  status: "pending",
  attempts: 0,
};

function scheduler(patch: Partial<UseClaimSchedulerResult> = {}): UseClaimSchedulerResult {
  return {
    ready: true,
    policy: { ...DEFAULT_POLICY, enabled: true },
    fee: fee(120),
    claims: [],
    lastEvaluation: null,
    error: "",
    updatePolicy: fn(),
    scheduleClaim: fn(),
    cancelClaim: fn(),
    resignClaim: fn(),
    submitNow: fn(),
    ...patch,
  };
}

/**
 * Opt-in fee-aware claim scheduling panel (docs/FEE_AWARE_CLAIMS.md). The
 * scheduler hook is a prop, so each state is just a different hook result.
 */
const meta = {
  title: "Streams/ClaimSchedulerSettings",
  component: ClaimSchedulerSettings,
  tags: ["autodocs"],
  args: { stream: activeStream, scheduler: scheduler() },
} satisfies Meta<typeof ClaimSchedulerSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disabled: Story = {
  args: { scheduler: scheduler({ policy: DEFAULT_POLICY }) },
};

/** Loading: no fee observation yet. */
export const FeeLoading: Story = {
  args: { scheduler: scheduler({ fee: null }) },
};

export const UnderBudget: Story = {};

export const QueuedOverBudget: Story = {
  args: {
    scheduler: scheduler({
      fee: fee(400),
      claims: [pendingClaim],
      lastEvaluation: {
        now: FIXED_NOW_SECONDS,
        action: "wait",
        reason: "fee-above-threshold",
        feeStroops: 400,
        thresholdStroops: 150,
        feeLedger: 1_234_567,
        secondsToStreamEnd: activeStream.endTime - FIXED_NOW_SECONDS,
        secondsToIntentExpiry: 3600,
      },
    }),
  },
};

/** Error: the last submission failed and the hook reports why. */
export const SubmissionFailed: Story = {
  args: {
    scheduler: scheduler({
      claims: [{ ...pendingClaim, status: "failed", attempts: 2, lastError: "txBadSeq" }],
      error: "Could not reach the RPC node to submit the claim.",
    }),
  },
};
