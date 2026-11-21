import { describe, expect, it, vi } from "vitest";
import { buildQueuedClaim, ClaimScheduler } from "./claim-runtime";
import { DEFAULT_POLICY, type QueuedClaim } from "./claim-scheduler";

function makeClaim(overrides: Partial<QueuedClaim> = {}): QueuedClaim {
  return {
    ...buildQueuedClaim({
      streamId: "1",
      recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      streamStartTime: 1_000,
      streamEndTime: 5_000,
      now: 1_500,
    }),
    ...overrides,
  };
}

describe("ClaimScheduler.submitNow", () => {
  it("signs a claim that had no signature, then submits the fresh envelope", async () => {
    const sign = vi.fn(async () => ({
      signedXdr: "fresh-signed",
      signedValidUntil: 4_000,
    }));
    const submit = vi.fn(async () => ({ hash: "hash-1" }));
    const scheduler = new ClaimScheduler(
      "testnet:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      { ...DEFAULT_POLICY, enabled: true },
      { sign, submit }
    );

    const claim = makeClaim({ signedXdr: null, signedValidUntil: null });
    scheduler.enqueue(claim);

    await scheduler.submitNow(claim.id);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("fresh-signed");
    expect(scheduler.all.find((c) => c.id === claim.id)?.status).toBe(
      "submitted"
    );
  });

  it("submits a held envelope without re-signing", async () => {
    const sign = vi.fn(async () => ({
      signedXdr: "should-not-be-used",
      signedValidUntil: 4_000,
    }));
    const submit = vi.fn(async () => ({ hash: "hash-2" }));
    const scheduler = new ClaimScheduler(
      "testnet:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      { ...DEFAULT_POLICY, enabled: true },
      { sign, submit }
    );

    const claim = makeClaim({ signedXdr: "held", signedValidUntil: 4_000 });
    scheduler.enqueue(claim);

    await scheduler.submitNow(claim.id);

    expect(sign).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith("held");
  });
});
