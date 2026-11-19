import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";

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


/** `fireEvent.change` on a number input: one onChange carrying exactly `value`. */
function edit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/**
 * Leaves no focused control behind. The scheduler is a prop, so the `fn()`
 * spies never feed a new policy back in: every controlled input snaps back to
 * its prop value and the resting render stays byte-identical to the baseline.
 * Only focus could still differ, so drop it.
 */
function release(canvasElement: HTMLElement) {
  (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
}

/** The cells of the queue table row for `claim`, by the shortened id the panel shows. */
function claimRow(canvas: ReturnType<typeof within>, claim: QueuedClaim) {
  return within(canvas.getByRole("row", { name: new RegExp(claim.id.slice(0, 8)) }));
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
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const { updatePolicy } = args.scheduler;
    const enable = canvas.getByRole("checkbox", { name: "Enable scheduled claims" });
    const schedule = canvas.getByRole("button", { name: "Schedule claim" });

    // Automation is off, so there is nothing to schedule yet.
    await expect(enable).not.toBeChecked();
    await expect(schedule).toBeDisabled();

    // Opting in reports exactly one change: the flag, nothing else.
    await userEvent.click(enable);
    await expect(updatePolicy).toHaveBeenCalledTimes(1);
    await expect(updatePolicy).toHaveBeenLastCalledWith({ enabled: true });
    // The policy is the hook's to change, not the panel's.
    await expect(enable).not.toBeChecked();
    await expect(schedule).toBeDisabled();
    release(canvasElement);
  },
};

/** Loading: no fee observation yet. */
export const FeeLoading: Story = {
  args: { scheduler: scheduler({ fee: null }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // No observation yet: placeholders, and no claim of being under budget.
    await expect(canvas.getByText(/ledger …/)).toBeVisible();
    await expect(canvas.getByText(/over budget/)).toBeVisible();
    await expect(canvas.queryByText(/under budget/)).not.toBeInTheDocument();
  },
};

export const UnderBudget: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const { updatePolicy, scheduleClaim } = args.scheduler;

    await expect(canvas.getByText(/under budget/)).toBeVisible();

    // Toggling automation off.
    const enable = canvas.getByRole("checkbox", { name: "Enable scheduled claims" });
    await expect(enable).toBeChecked();
    await userEvent.click(enable);
    await expect(updatePolicy).toHaveBeenLastCalledWith({ enabled: false });
    await expect(enable).toBeChecked();

    // Editing the caps. Each field reports only its own key, in the unit the
    // policy stores (minutes in the form, seconds in the policy).
    const percentile = canvas.getByLabelText("Fee percentile");
    await userEvent.selectOptions(percentile, "p90");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ percentile: "p90" });
    await expect(percentile).toHaveValue("p50");

    edit(canvas.getByLabelText("Max fee (stroops)"), "200");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ maxFeeStroops: 200 });

    edit(canvas.getByLabelText("Deadline lead (minutes)"), "10");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ deadlineLeadSeconds: 600 });

    edit(canvas.getByLabelText("Signature window (minutes)"), "15");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ intentValiditySeconds: 900 });
    await expect(updatePolicy).toHaveBeenCalledTimes(5);

    // The form still shows the policy it was given.
    await expect(canvas.getByLabelText("Max fee (stroops)")).toHaveValue(DEFAULT_POLICY.maxFeeStroops);
    await expect(canvas.getByLabelText("Deadline lead (minutes)")).toHaveValue(15);
    await expect(canvas.getByLabelText("Signature window (minutes)")).toHaveValue(60);

    // Scheduling hands the panel's stream to the hook.
    await userEvent.click(canvas.getByRole("button", { name: "Schedule claim" }));
    await expect(scheduleClaim).toHaveBeenCalledTimes(1);
    await expect(scheduleClaim).toHaveBeenCalledWith(activeStream);
    release(canvasElement);
  },
};

/**
 * Same resting render as UnderBudget (so it shares that baseline's pixels),
 * driven through the inputs' guard rails: out-of-range and empty values are
 * clamped before they reach the policy.
 */
export const ClampsInvalidInput: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const { updatePolicy } = args.scheduler;

    // An emptied budget is reported as 0 (and so reads as "over budget").
    edit(canvas.getByLabelText("Max fee (stroops)"), "");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ maxFeeStroops: 0 });

    // A negative or empty lead means "no lead", never a negative duration.
    edit(canvas.getByLabelText("Deadline lead (minutes)"), "-5");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ deadlineLeadSeconds: 0 });
    edit(canvas.getByLabelText("Deadline lead (minutes)"), "");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ deadlineLeadSeconds: 0 });

    // A signature must stay valid for at least a minute.
    edit(canvas.getByLabelText("Signature window (minutes)"), "0");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ intentValiditySeconds: 60 });
    edit(canvas.getByLabelText("Signature window (minutes)"), "");
    await expect(updatePolicy).toHaveBeenLastCalledWith({ intentValiditySeconds: 60 });

    await expect(updatePolicy).toHaveBeenCalledTimes(5);
    await expect(canvas.getByText(/under budget/)).toBeVisible();
    release(canvasElement);
  },
};

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
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const { cancelClaim, resignClaim, submitNow } = args.scheduler;

    // Feedback: over budget, why it is waiting, and no second claim can be queued.
    await expect(canvas.getByText(/over budget/)).toBeVisible();
    await expect(canvas.getByText(/waiting — fee above budget/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Claim queued" })).toBeDisabled();

    // The queued claim and its signature expiry (a fixed constant, not "now").
    const row = claimRow(canvas, pendingClaim);
    await expect(row.getByText("pending")).toBeVisible();
    await expect(
      row.getByText(new Date(pendingClaim.signedValidUntil! * 1000).toISOString())
    ).toBeVisible();

    // A pending claim can be re-signed, submitted early or cancelled.
    await userEvent.click(row.getByRole("button", { name: "Re-sign" }));
    await expect(resignClaim).toHaveBeenCalledWith(pendingClaim.id);
    await userEvent.click(row.getByRole("button", { name: "Submit now" }));
    await expect(submitNow).toHaveBeenCalledWith(pendingClaim.id);
    await userEvent.click(row.getByRole("button", { name: "Cancel" }));
    await expect(cancelClaim).toHaveBeenCalledWith(pendingClaim.id);
    release(canvasElement);
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
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const { cancelClaim, resignClaim, submitNow } = args.scheduler;

    // Both the hook-level error and the claim's own failure are shown.
    await expect(canvas.getByText("Could not reach the RPC node to submit the claim.")).toBeVisible();
    const row = claimRow(canvas, pendingClaim);
    await expect(row.getByText("failed")).toBeVisible();
    await expect(row.getByText("txBadSeq")).toBeVisible();

    // A failed claim is final here: its actions are disabled and do nothing.
    for (const name of ["Re-sign", "Submit now", "Cancel"]) {
      const button = row.getByRole("button", { name });
      await expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    await expect(resignClaim).not.toHaveBeenCalled();
    await expect(submitNow).not.toHaveBeenCalled();
    await expect(cancelClaim).not.toHaveBeenCalled();
    release(canvasElement);
  },
};
