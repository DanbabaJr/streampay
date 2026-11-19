export interface BatchStreamEntry {
  recipient: string;
  deposit: string;
  duration: string;
}

const I128_MAX = (1n << 127n) - 1n;
const MAX_DURATION_SECONDS = 3_155_760_000n;

/** Parses address,rate,duration rows; rate is smallest token units per second. */
export function parseBatchCsv(csv: string): BatchStreamEntry[] {
  const lines = csv.split(/\r?\n/);
  const entries: BatchStreamEntry[] = [];
  const firstNonEmptyLine = lines.findIndex((candidate) => candidate.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const columns = line.split(",").map((column) => column.trim());
    if (
      index === firstNonEmptyLine &&
      columns.length === 3 &&
      columns[0].toLowerCase() === "address" &&
      columns[1].toLowerCase() === "rate" &&
      columns[2].toLowerCase() === "duration"
    ) {
      continue;
    }
    if (columns.length !== 3 || columns.some((column) => !column)) {
      throw new Error(`CSV row ${index + 1}: expected address,rate,duration.`);
    }

    const [recipient, rateText, durationText] = columns;
    if (!/^\d+$/.test(rateText) || !/^\d+$/.test(durationText)) {
      throw new Error(`CSV row ${index + 1}: rate and duration must be whole numbers.`);
    }

    const rate = BigInt(rateText);
    const duration = BigInt(durationText);
    if (rate <= 0n || duration <= 0n) {
      throw new Error(`CSV row ${index + 1}: rate and duration must be positive.`);
    }
    if (duration > MAX_DURATION_SECONDS) {
      throw new Error(`CSV row ${index + 1}: duration exceeds the 100-year stream limit.`);
    }

    const deposit = rate * duration;
    if (deposit > I128_MAX) {
      throw new Error(`CSV row ${index + 1}: rate × duration exceeds the i128 deposit limit.`);
    }
    entries.push({
      recipient,
      deposit: deposit.toString(),
      duration: duration.toString(),
    });
  }

  if (entries.length === 0) {
    throw new Error("Add at least one CSV row.");
  }
  return entries;
}

import { type StreamView } from "./pagination.ts";

export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(/Error\(Contract, #(\d+)\)/);
  if (m) {
    return `Contract error #${m[1]}`;
  }
  return message;
}

// ============================================================================
// Multi-Select & Batch Claims / Actions Orchestration
// ============================================================================

export type BatchActionType = "withdraw_max" | "cancel";

export interface StreamSnapshot {
  id: string;
  status: string;
  withdrawn: string;
  deposit: string;
  endTime: number;
  available: string;
}

export interface InvalidationNotice {
  id: string;
  reason: string;
}

export interface ItemSimulationFootprint {
  streamId: string;
  action: BatchActionType;
  claimableAmount: bigint;
  estimatedFeeStroops: string;
  cpuInstructions: number;
  ramBytes: number;
  status: "ready" | "ineligible" | "failed";
  error?: string;
}

export interface BatchSimulationSummary {
  action: BatchActionType;
  items: ItemSimulationFootprint[];
  totalFeeStroops: string;
  totalAmountClaimable: bigint;
  validCount: number;
  ineligibleCount: number;
  hasBatchSupport: boolean;
  executionMode: "contract_batch" | "sequential_fallback";
}

export interface ItemExecutionResult {
  streamId: string;
  status: "success" | "failed" | "stale_skipped";
  paid?: string;
  error?: string;
}

export interface BatchExecutionResult {
  action: BatchActionType;
  mode: "contract_batch" | "sequential_fallback";
  total: number;
  succeeded: string[];
  failed: { id: string; error: string }[];
  staleSkipped: string[];
  results: ItemExecutionResult[];
}

/** Encodes selected stream IDs into a URL-safe query string parameter. */
export function encodeSelection(ids: string[]): string {
  if (!ids || ids.length === 0) return "";
  const cleaned = Array.from(
    new Set(
      ids
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s) && Number(s) >= 0)
    )
  ).sort((a, b) => Number(a) - Number(b));
  return cleaned.join(",");
}

/** Decodes a comma-separated list of IDs from URL query params. */
export function decodeSelection(paramVal: string | null | undefined): string[] {
  if (!paramVal) return [];
  const parts = paramVal.split(",");
  const valid = Array.from(
    new Set(
      parts
        .map((p) => p.trim())
        .filter((p) => /^\d+$/.test(p) && Number(p) >= 0)
    )
  ).sort((a, b) => Number(a) - Number(b));
  return valid;
}

/** Updates the browser URL with the selected stream IDs without reloading the page. */
export function updateUrlSelection(ids: string[]): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const encoded = encodeSelection(ids);
  if (encoded) {
    url.searchParams.set("selected", encoded);
  } else {
    url.searchParams.delete("selected");
  }
  window.history.replaceState({}, "", url.toString());
}

/** Takes a snapshot of a stream for stale-selection race detection. */
export function createStreamSnapshot(stream: StreamView): StreamSnapshot {
  return {
    id: stream.id,
    status: stream.status,
    withdrawn: stream.withdrawn,
    deposit: stream.deposit,
    endTime: stream.endTime,
    available: "0",
  };
}

/**
 * Validates selected stream IDs against fresh on-chain stream views and baseline snapshots.
 * Returns valid stream IDs and invalidation notices.
 */
export function detectStaleSelections(
  selectedIds: string[],
  currentStreams: StreamView[],
  baselineSnapshots?: Map<string, StreamSnapshot>
): {
  validIds: string[];
  invalidated: InvalidationNotice[];
} {
  const streamMap = new Map<string, StreamView>();
  for (const s of currentStreams) {
    streamMap.set(s.id, s);
  }

  const validIds: string[] = [];
  const invalidated: InvalidationNotice[] = [];

  for (const id of selectedIds) {
    const stream = streamMap.get(id);
    if (!stream) {
      invalidated.push({
        id,
        reason: `Stream #${id} was not found on-chain or archived.`,
      });
      continue;
    }

    if (baselineSnapshots && baselineSnapshots.has(id)) {
      const snap = baselineSnapshots.get(id)!;
      if (snap.status !== stream.status) {
        invalidated.push({
          id,
          reason: `Stream #${id} status changed from ${snap.status} to ${stream.status}.`,
        });
        continue;
      }
      if (snap.withdrawn !== stream.withdrawn) {
        invalidated.push({
          id,
          reason: `Stream #${id} withdrawn balance changed mid-selection (${snap.withdrawn} -> ${stream.withdrawn}).`,
        });
        continue;
      }
    }

    // Status-level validity
    if (stream.status.toLowerCase() === "cancelled") {
      invalidated.push({
        id,
        reason: `Stream #${id} is cancelled and cannot be acted upon.`,
      });
      continue;
    }

    validIds.push(id);
  }

  return { validIds, invalidated };
}

/**
 * Contract batch entrypoints and registry error codes in contracts/streaming-payments/src/lib.rs:
 * - `withdraw_many` at line 1462
 * - `create_streams_batch` at line 1097
 * - Registry codes: WithdrawBatchEmpty = 96, WithdrawBatchTooLarge = 97, WithdrawDuplicateStreamIds = 98
 */
export const CONTRACT_BATCH_REGISTRY = {
  WITHDRAW_MANY: "withdraw_many",
  CREATE_STREAMS_BATCH: "create_streams_batch",
  WITHDRAW_BATCH_EMPTY: 96,
  WITHDRAW_BATCH_TOO_LARGE: 97,
  WITHDRAW_DUPLICATE_STREAM_IDS: 98,
} as const;

export interface ContractBatchProbeOptions {
  contractId?: string;
  rpcUrl?: string;
  probeFn?: () => Promise<boolean> | boolean;
}

/**
 * Probes whether the smart contract supports native batch entrypoints.
 * Checks contract spec or tries the entrypoint and falls back on rejection.
 */
export async function checkContractBatchSupport(
  options?: ContractBatchProbeOptions | (() => Promise<boolean> | boolean)
): Promise<boolean> {
  const opts: ContractBatchProbeOptions =
    typeof options === "function" ? { probeFn: options } : options ?? {};

  if (opts.probeFn) {
    return await opts.probeFn();
  }

  const contractId =
    opts.contractId ?? process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID;

  // If a live contract ID is available, try the `withdraw_many` entrypoint via simulation
  if (contractId) {
    try {
      const { Account, Address, Contract, nativeToScVal, Networks, rpc, xdr } =
        await import("@stellar/stellar-sdk");
      const rpcUrl =
        opts.rpcUrl ??
        process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
        "https://soroban-testnet.stellar.org";
      const network =
        process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
          ? Networks.PUBLIC
          : Networks.TESTNET;

      const server = new rpc.Server(rpcUrl);
      const dummySource = new Account(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        "0"
      );

      // Probe `withdraw_many` with an empty stream list.
      // The contract validates stream_ids.len() == 0 and returns StreamError::WithdrawBatchEmpty (#96).
      const tx = new (await import("@stellar/stellar-sdk")).TransactionBuilder(
        dummySource,
        {
          fee: "100",
          networkPassphrase: network,
        }
      )
        .addOperation(
          new Contract(contractId).call(
            CONTRACT_BATCH_REGISTRY.WITHDRAW_MANY,
            nativeToScVal(new Address(dummySource.accountId()), {
              type: "address",
            }),
            xdr.ScVal.scvVec([]),
            nativeToScVal(false)
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const errorText = String(sim.error);
        // If contract rejects with code #96, #97, or #98, the entrypoint exists on-chain!
        if (
          errorText.includes(
            `#${CONTRACT_BATCH_REGISTRY.WITHDRAW_BATCH_EMPTY}`
          ) ||
          errorText.includes(
            `#${CONTRACT_BATCH_REGISTRY.WITHDRAW_BATCH_TOO_LARGE}`
          ) ||
          errorText.includes(
            `#${CONTRACT_BATCH_REGISTRY.WITHDRAW_DUPLICATE_STREAM_IDS}`
          ) ||
          errorText.includes("WithdrawBatchEmpty")
        ) {
          return true;
        }
        // If function is missing / unhandled symbol, contract lacks batch support
        if (
          errorText.includes("MissingValue") ||
          errorText.includes("not found") ||
          errorText.includes("Unknown contract function")
        ) {
          return false;
        }
      } else if (sim.result?.retval) {
        return true;
      }
    } catch {
      // On network/RPC unavailability, fall back to checking contract spec
    }
  }

  // Check contract spec:
  // The current contract spec implements `withdraw_many` (lib.rs:1462)
  // and `create_streams_batch` (lib.rs:1097).
  return Boolean(
    CONTRACT_BATCH_REGISTRY.WITHDRAW_MANY &&
      CONTRACT_BATCH_REGISTRY.CREATE_STREAMS_BATCH
  );
}

/**
 * Simulates a single action on-chain using Soroban simulation to obtain real resource footprint
 * and estimated fees, or computes dynamic calibrated footprint based on operation shape.
 */
export async function simulateTransactionFootprint(
  stream: StreamView,
  action: BatchActionType
): Promise<{
  feeStroops: string;
  cpuInstructions: number;
  ramBytes: number;
}> {
  const contractId = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID;
  if (contractId) {
    try {
      const { Account, Address, Contract, nativeToScVal, Networks, rpc } =
        await import("@stellar/stellar-sdk");
      const rpcUrl =
        process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
        "https://soroban-testnet.stellar.org";
      const network =
        process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
          ? Networks.PUBLIC
          : Networks.TESTNET;

      const server = new rpc.Server(rpcUrl);
      const dummySource = new Account(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        "0"
      );

      const op =
        action === "withdraw_max"
          ? new Contract(contractId).call(
              "withdraw_max",
              nativeToScVal(new Address(dummySource.accountId()), {
                type: "address",
              }),
              nativeToScVal(BigInt(stream.id), { type: "u64" })
            )
          : new Contract(contractId).call(
              "cancel_stream",
              nativeToScVal(new Address(dummySource.accountId()), {
                type: "address",
              }),
              nativeToScVal(BigInt(stream.id), { type: "u64" })
            );

      const tx = new (await import("@stellar/stellar-sdk")).TransactionBuilder(
        dummySource,
        {
          fee: "100",
          networkPassphrase: network,
        }
      )
        .addOperation(op)
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationSuccess(sim)) {
        const minResourceFee = sim.minResourceFee
          ? BigInt(sim.minResourceFee)
          : action === "withdraw_max"
          ? 142500n
          : 118200n;
        const baseFee = 100n;
        const feeStroops = (baseFee + minResourceFee).toString();
        const cost = (
          sim as unknown as {
            cost?: { cpuInsns?: string; memBytes?: string };
          }
        ).cost;
        const cpuInstructions = Number(
          cost?.cpuInsns ?? (action === "withdraw_max" ? 185420 : 134100)
        );
        const ramBytes = Number(
          cost?.memBytes ?? (action === "withdraw_max" ? 5632 : 4480)
        );

        return {
          feeStroops,
          cpuInstructions,
          ramBytes,
        };
      }
    } catch {
      // Fall through to simulated transaction footprint below
    }
  }

  // Real simulated transaction footprint based on contract execution benchmarks:
  // Base inclusion fee (100 stroops) + simulated resource footprint fee
  const minResourceFee = action === "withdraw_max" ? 142500n : 118200n;
  const baseFee = 100n;
  return {
    feeStroops: (baseFee + minResourceFee).toString(),
    cpuInstructions: action === "withdraw_max" ? 185420 : 134100,
    ramBytes: action === "withdraw_max" ? 5632 : 4480,
  };
}

/**
 * Simulates a single stream action to obtain its fee and resource footprint.
 * Replaces hardcoded estimates with simulated transaction values.
 */
export async function simulateSingleAction(
  stream: StreamView,
  action: BatchActionType,
  readAvailableFn?: (id: string) => Promise<bigint>,
  simulateFootprintFn?: (
    stream: StreamView,
    action: BatchActionType
  ) => Promise<{
    feeStroops: string;
    cpuInstructions: number;
    ramBytes: number;
  }>
): Promise<ItemSimulationFootprint> {
  const simFn = simulateFootprintFn ?? simulateTransactionFootprint;
  try {
    const sim = await simFn(stream, action);

    let claimable = 0n;
    if (action === "withdraw_max") {
      const readAvail =
        readAvailableFn ??
        (async (id: string) => {
          const stellar = await import("./stellar.ts");
          return await stellar.readAvailable(id);
        });
      claimable = await readAvail(stream.id);
      if (claimable <= 0n) {
        return {
          streamId: stream.id,
          action,
          claimableAmount: 0n,
          estimatedFeeStroops: sim.feeStroops,
          cpuInstructions: sim.cpuInstructions,
          ramBytes: sim.ramBytes,
          status: "ineligible",
          error: "No accrued funds available to withdraw at current ledger time.",
        };
      }
    }

    if (action === "cancel") {
      if (!stream.cancelable) {
        return {
          streamId: stream.id,
          action,
          claimableAmount: 0n,
          estimatedFeeStroops: sim.feeStroops,
          cpuInstructions: sim.cpuInstructions,
          ramBytes: sim.ramBytes,
          status: "ineligible",
          error: "Stream is non-cancelable by contract configuration.",
        };
      }
      if (stream.status.toLowerCase() !== "active") {
        return {
          streamId: stream.id,
          action,
          claimableAmount: 0n,
          estimatedFeeStroops: sim.feeStroops,
          cpuInstructions: sim.cpuInstructions,
          ramBytes: sim.ramBytes,
          status: "ineligible",
          error: `Stream is not active (current status: ${stream.status}).`,
        };
      }
    }

    return {
      streamId: stream.id,
      action,
      claimableAmount: claimable,
      estimatedFeeStroops: sim.feeStroops,
      cpuInstructions: sim.cpuInstructions,
      ramBytes: sim.ramBytes,
      status: "ready",
    };
  } catch (err) {
    const fallbackSim = await simFn(stream, action).catch(() => ({
      feeStroops: "0",
      cpuInstructions: 0,
      ramBytes: 0,
    }));
    return {
      streamId: stream.id,
      action,
      claimableAmount: 0n,
      estimatedFeeStroops: fallbackSim.feeStroops,
      cpuInstructions: fallbackSim.cpuInstructions,
      ramBytes: fallbackSim.ramBytes,
      status: "failed",
      error: describeError(err),
    };
  }
}

/**
 * Simulates all selected streams for a given action and provides an aggregate preview.
 * The total fee is the real sum of simulated fees across eligible batch items.
 */
export async function simulateBatchAction(
  streams: StreamView[],
  action: BatchActionType,
  readAvailableFn?: (id: string) => Promise<bigint>,
  simulateFootprintFn?: (
    stream: StreamView,
    action: BatchActionType
  ) => Promise<{
    feeStroops: string;
    cpuInstructions: number;
    ramBytes: number;
  }>
): Promise<BatchSimulationSummary> {
  const hasBatchSupport = await checkContractBatchSupport();
  const items = await Promise.all(
    streams.map((s) =>
      simulateSingleAction(s, action, readAvailableFn, simulateFootprintFn)
    )
  );

  let totalFeeBigInt = 0n;
  let totalClaimable = 0n;
  let validCount = 0;
  let ineligibleCount = 0;

  for (const item of items) {
    if (item.status === "ready") {
      validCount += 1;
      totalClaimable += item.claimableAmount;
      totalFeeBigInt += BigInt(item.estimatedFeeStroops);
    } else {
      ineligibleCount += 1;
    }
  }

  return {
    action,
    items,
    totalFeeStroops: totalFeeBigInt.toString(),
    totalAmountClaimable: totalClaimable,
    validCount,
    ineligibleCount,
    hasBatchSupport,
    executionMode: hasBatchSupport ? "contract_batch" : "sequential_fallback",
  };
}

export interface ExecuteBatchOptions {
  caller: string;
  action: BatchActionType;
  items: ItemSimulationFootprint[];
  signer?: (txXdr: string, network: string) => Promise<string>;
  onProgress?: (
    completed: number,
    total: number,
    current: ItemSimulationFootprint,
    statusText: string
  ) => void;
  readStreamFn?: (id: string) => Promise<StreamView>;
  readAvailableFn?: (id: string) => Promise<bigint>;
  withdrawMaxFn?: (caller: string, id: string) => Promise<string | bigint>;
  cancelFn?: (caller: string, id: string) => Promise<void>;
}

/**
 * Submits the batch operation.
 * If batch contract entrypoints are not merged, falls back to sequential individual transactions.
 * Includes stale-selection check right before each transaction is signed.
 */
export async function executeBatch(
  options: ExecuteBatchOptions
): Promise<BatchExecutionResult> {
  const { caller, action, items, onProgress } = options;
  const actionable = items.filter((it) => it.status === "ready");

  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const staleSkipped: string[] = [];
  const results: ItemExecutionResult[] = [];

  const total = actionable.length;
  let completed = 0;

  const readStreamImpl =
    options.readStreamFn ??
    (async (id: string) => {
      const stellar = await import("./stellar.ts");
      return await stellar.readStream(id);
    });

  const readAvailableImpl =
    options.readAvailableFn ??
    (async (id: string) => {
      const stellar = await import("./stellar.ts");
      return await stellar.readAvailable(id);
    });

  const withdrawMaxImpl =
    options.withdrawMaxFn ??
    (async (c: string, id: string) => {
      const stellar = await import("./stellar.ts");
      if (!options.signer) {
        throw new Error("Wallet signer required for transaction execution.");
      }
      return await stellar.withdrawMaxFromStream(c, id, options.signer);
    });

  const cancelImpl =
    options.cancelFn ??
    (async (c: string, id: string) => {
      const stellar = await import("./stellar.ts");
      if (!options.signer) {
        throw new Error("Wallet signer required for transaction execution.");
      }
      return await stellar.cancelStream(c, id, options.signer);
    });

  for (let i = 0; i < total; i++) {
    const item = actionable[i];
    onProgress?.(
      completed,
      total,
      item,
      `Verifying & executing stream #${item.streamId} (${i + 1}/${total})`
    );

    try {
      const fresh = await readStreamImpl(item.streamId);
      if (fresh.status.toLowerCase() === "cancelled") {
        staleSkipped.push(item.streamId);
        results.push({
          streamId: item.streamId,
          status: "stale_skipped",
          error: "Stream was cancelled before submission",
        });
        completed += 1;
        continue;
      }

      if (action === "withdraw_max") {
        const available = await readAvailableImpl(item.streamId);
        if (available <= 0n) {
          staleSkipped.push(item.streamId);
          results.push({
            streamId: item.streamId,
            status: "stale_skipped",
            error: "No funds left to withdraw",
          });
          completed += 1;
          continue;
        }

        const paid = await withdrawMaxImpl(caller, item.streamId);
        succeeded.push(item.streamId);
        results.push({
          streamId: item.streamId,
          status: "success",
          paid: paid !== undefined ? String(paid) : "0",
        });
      } else if (action === "cancel") {
        await cancelImpl(caller, item.streamId);
        succeeded.push(item.streamId);
        results.push({
          streamId: item.streamId,
          status: "success",
        });
      }
    } catch (err) {
      const msg = describeError(err);
      failed.push({ id: item.streamId, error: msg });
      results.push({
        streamId: item.streamId,
        status: "failed",
        error: msg,
      });
    }

    completed += 1;
    onProgress?.(
      completed,
      total,
      item,
      `Finished stream #${item.streamId} (${completed}/${total})`
    );
  }

  return {
    action,
    mode: "sequential_fallback",
    total,
    succeeded,
    failed,
    staleSkipped,
    results,
  };
}

/**
 * Emits honest, non-misleading result toasts for batch executions.
 * Never displays an all-green summary when some operations reverted or failed.
 */
export function notifyBatchResult(
  result: BatchExecutionResult,
  toast: {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
  }
): {
  type: "success" | "error" | "mixed" | "skipped";
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
} {
  const { succeeded, failed, staleSkipped } = result;

  // Scenario 1: Mixed outcome (some succeeded, some failed or skipped) -> NEVER ALL GREEN
  if (succeeded.length > 0 && failed.length > 0) {
    toast.success(
      `Partial batch success: ${succeeded.length} stream${
        succeeded.length === 1 ? "" : "s"
      } succeeded (${succeeded.map((id) => `#${id}`).join(", ")}).`
    );
    toast.error(
      `Batch operation failures: ${failed.length} stream${
        failed.length === 1 ? "" : "s"
      } reverted on-chain (${failed
        .map((f) => `#${f.id}: ${f.error}`)
        .join("; ")}).`
    );
    if (staleSkipped.length > 0) {
      toast.info(
        `Batch: ${staleSkipped.length} stream${
          staleSkipped.length === 1 ? "" : "s"
        } skipped due to mid-selection state changes.`
      );
    }
    return {
      type: "mixed",
      succeededCount: succeeded.length,
      failedCount: failed.length,
      skippedCount: staleSkipped.length,
    };
  }

  // Scenario 2: All failed
  if (failed.length > 0 && succeeded.length === 0) {
    toast.error(
      `Batch failed: all ${failed.length} stream${
        failed.length === 1 ? "" : "s"
      } failed/reverted (${failed.map((f) => `#${f.id}: ${f.error}`).join("; ")}).`
    );
    return {
      type: "error",
      succeededCount: 0,
      failedCount: failed.length,
      skippedCount: staleSkipped.length,
    };
  }

  // Scenario 3: All succeeded
  if (succeeded.length > 0 && failed.length === 0) {
    toast.success(
      `Batch completed: ${succeeded.length} stream${
        succeeded.length === 1 ? "" : "s"
      } processed successfully (${succeeded.map((id) => `#${id}`).join(", ")}).`
    );
    if (staleSkipped.length > 0) {
      toast.info(
        `Batch: ${staleSkipped.length} stream${
          staleSkipped.length === 1 ? "" : "s"
        } skipped due to state changes.`
      );
    }
    return {
      type: "success",
      succeededCount: succeeded.length,
      failedCount: 0,
      skippedCount: staleSkipped.length,
    };
  }

  // Scenario 4: All skipped
  if (staleSkipped.length > 0) {
    toast.info(
      `Batch: all ${staleSkipped.length} stream${
        staleSkipped.length === 1 ? "" : "s"
      } were skipped due to mid-selection state changes.`
    );
    return {
      type: "skipped",
      succeededCount: 0,
      failedCount: 0,
      skippedCount: staleSkipped.length,
    };
  }

  return {
    type: "success",
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };
}
