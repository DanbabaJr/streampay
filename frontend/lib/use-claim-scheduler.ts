"use client";

/**
 * React glue for the fee-aware claim scheduler.
 *
 * Owns one {@link ClaimScheduler} and one {@link FeeObserver} per connected
 * address, persists the policy in `localStorage`, and exposes the actions the
 * settings UI needs. All contract interaction is injected from `stellar.ts`
 * so the hook stays free of RPC details.
 *
 * The scheduler is the source of truth for the queue; the hook subscribes via
 * its `onUpdate`/`onEvaluation` callbacks rather than copying state, and
 * resets per-wallet state during render when the address changes (React's
 * documented pattern for deriving state from props).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_POLICY,
  type ClaimEvaluation,
  type QueuedClaim,
  type SchedulerPolicy,
} from "./claim-scheduler";
import { buildQueuedClaim, ClaimScheduler } from "./claim-runtime";
import type { FeeSnapshot } from "./fee-stats";
import { FeeObserver } from "./fee-observer";
import {
  describeError,
  NETWORK_LABEL,
  prepareWithdrawMax,
  RPC_URL,
  signPreparedIntent,
  submitSignedIntent,
  type StreamView,
} from "./stellar";

const POLICY_KEY_PREFIX = "streampay:claim-policy:v1:";

function loadPolicy(scope: string): SchedulerPolicy {
  if (typeof window === "undefined") return DEFAULT_POLICY;
  try {
    const raw = window.localStorage.getItem(POLICY_KEY_PREFIX + scope);
    if (!raw) return DEFAULT_POLICY;
    const parsed = JSON.parse(raw) as Partial<SchedulerPolicy>;
    return { ...DEFAULT_POLICY, ...parsed };
  } catch {
    return DEFAULT_POLICY;
  }
}

function savePolicy(scope: string, policy: SchedulerPolicy): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(POLICY_KEY_PREFIX + scope, JSON.stringify(policy));
  } catch {
    // Non-fatal: the in-memory policy still applies for this session.
  }
}

export interface UseClaimSchedulerResult {
  /** Whether the address scope is ready (wallet connected). */
  ready: boolean;
  policy: SchedulerPolicy;
  fee: FeeSnapshot | null;
  /** Queued claims across all of this address's streams. */
  claims: QueuedClaim[];
  /** The most recent decision taken (for the live status line). */
  lastEvaluation: ClaimEvaluation | null;
  error: string;
  updatePolicy: (patch: Partial<SchedulerPolicy>) => void;
  /** Queue and immediately sign a claim for the given active stream. */
  scheduleClaim: (stream: StreamView) => Promise<void>;
  cancelClaim: (id: string) => void;
  resignClaim: (id: string) => Promise<void>;
  submitNow: (id: string) => Promise<void>;
}

export function useClaimScheduler(address: string | null): UseClaimSchedulerResult {
  const scope = address ? `${NETWORK_LABEL}:${address}` : null;

  const [policy, setPolicyState] = useState<SchedulerPolicy>(DEFAULT_POLICY);
  const [fee, setFee] = useState<FeeSnapshot | null>(null);
  const [claims, setClaims] = useState<QueuedClaim[]>([]);
  const [lastEvaluation, setLastEvaluation] = useState<ClaimEvaluation | null>(
    null
  );
  const [error, setError] = useState("");
  const [boundScope, setBoundScope] = useState<string | null>(null);

  const schedulerRef = useRef<ClaimScheduler | null>(null);
  const observerRef = useRef<FeeObserver | null>(null);
  const policyRef = useRef<SchedulerPolicy>(DEFAULT_POLICY);
  const feeRef = useRef<FeeSnapshot | null>(null);

  // When the connected address changes, reset everything scoped to it. This is
  // React's documented "adjust state during render" pattern — cheaper and less
  // error-prone than a reset effect.
  if (boundScope !== scope) {
    setBoundScope(scope);
    setPolicyState(scope ? loadPolicy(scope) : DEFAULT_POLICY);
    setFee(null);
    setClaims([]);
    setLastEvaluation(null);
    setError("");
  }

  useEffect(() => {
    const activeScope = scope;
    // Refs are written here, not during render: the scheduler reads the policy
    // from `policyRef` so its injected signer always sees the latest value.
    policyRef.current = activeScope ? loadPolicy(activeScope) : DEFAULT_POLICY;
    feeRef.current = null;
    if (!activeScope) {
      schedulerRef.current = null;
      observerRef.current?.stop();
      observerRef.current = null;
      return;
    }

    const scheduler = new ClaimScheduler(
      activeScope,
      policyRef.current,
      {
        sign: async (claim) => {
          const prepared = await prepareWithdrawMax(
            claim.recipient,
            claim.streamId,
            policyRef.current.intentValiditySeconds
          );
          const signedXdr = await signPreparedIntent(prepared.xdr);
          return { signedXdr, signedValidUntil: prepared.validUntil };
        },
        submit: (signedXdr) => submitSignedIntent(signedXdr),
      },
      {
        onUpdate: (list) => setClaims([...list]),
        onEvaluation: (evaluation) => setLastEvaluation(evaluation),
        onError: (_claim, e) => setError(describeError(e)),
      }
    );
    schedulerRef.current = scheduler;

    const observer = new FeeObserver({
      rpcUrl: RPC_URL,
      onSnapshot: (snapshot) => {
        feeRef.current = snapshot;
        setFee(snapshot);
        void schedulerRef.current?.tick(snapshot);
      },
      onError: (e) => setError(describeError(e)),
    });
    observerRef.current = observer;
    observer.start();

    return () => {
      observer.stop();
    };
  }, [scope]);

  const updatePolicy = useCallback(
    (patch: Partial<SchedulerPolicy>) => {
      const next = { ...policyRef.current, ...patch };
      policyRef.current = next;
      schedulerRef.current?.setPolicy(next);
      if (scope) savePolicy(scope, next);
      setPolicyState(next);
      const snapshot = feeRef.current;
      if (next.enabled && snapshot) {
        void schedulerRef.current?.tick(snapshot);
      }
    },
    [scope]
  );

  const scheduleClaim = useCallback(
    async (stream: StreamView) => {
      const scheduler = schedulerRef.current;
      if (!scheduler || !address) {
        setError("Connect a wallet before scheduling a claim.");
        return;
      }
      setError("");
      const claim = buildQueuedClaim({
        streamId: stream.id,
        recipient: stream.recipient,
        streamStartTime: stream.startTime,
        streamEndTime: stream.endTime,
      });
      scheduler.enqueue(claim);
      await scheduler.refreshSignature(claim.id);
      const snapshot = feeRef.current;
      if (snapshot) await scheduler.tick(snapshot);
    },
    [address]
  );

  const cancelClaim = useCallback((id: string) => {
    schedulerRef.current?.remove(id);
  }, []);

  const resignClaim = useCallback(async (id: string) => {
    await schedulerRef.current?.refreshSignature(id);
  }, []);

  const submitNow = useCallback(async (id: string) => {
    await schedulerRef.current?.submitNow(id);
  }, []);

  // With no wallet there is no scope; report neutral values instead of stale
  // state from a previous address.
  const active = scope !== null;
  return {
    ready: active,
    policy: active ? policy : DEFAULT_POLICY,
    fee: active ? fee : null,
    claims: active ? claims : [],
    lastEvaluation: active ? lastEvaluation : null,
    error,
    updatePolicy,
    scheduleClaim,
    cancelClaim,
    resignClaim,
    submitNow,
  };
}
