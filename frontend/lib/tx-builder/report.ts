/**
 * Response summaries for the transaction builder output panes.
 *
 * Keep this module free of React and RPC calls: it takes the SDK response
 * objects the page already has and produces JSON-safe, display-ready data,
 * including the simulation footprint (the part integrators usually have to
 * dig out of the raw response).
 */
import {
  humanizeEvents,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";

export interface FootprintReport {
  readOnly: string[];
  readWrite: string[];
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
}

export interface SimulationReport {
  ok: boolean;
  error?: string;
  latestLedger: number;
  minResourceFee?: string;
  transactionDataXdr?: string;
  footprint?: FootprintReport;
  returnValue?: unknown;
  returnValueXdr?: string;
  events: unknown[];
  rawEventCount: number;
  needsRestore: boolean;
}

export interface ExecutionReport {
  status: string;
  hash: string;
  ledger?: number;
  returnValue?: unknown;
  returnValueXdr?: string;
  resultXdr?: string;
  events: unknown[];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON.stringify cannot represent bigint or Uint8Array; make both readable. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    if (value instanceof Map) {
      return Object.fromEntries(
        [...value.entries()].map(([key, entry]) => [String(key), jsonSafe(entry)]),
      );
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        jsonSafe(entry),
      ]),
    );
  }
  return value;
}

function safeHumanize(
  events: Parameters<typeof humanizeEvents>[0],
): unknown[] {
  try {
    return jsonSafe(humanizeEvents(events)) as unknown[];
  } catch {
    return [];
  }
}

function decodeRetval(retval: xdr.ScVal | undefined): unknown {
  if (!retval) return undefined;
  try {
    return jsonSafe(scValToNative(retval));
  } catch {
    return { xdr: retval.toXDR("base64") };
  }
}

export function summarizeSimulation(
  sim: rpc.Api.SimulateTransactionResponse,
): SimulationReport {
  const rawEvents = sim.events ?? [];
  if (rpc.Api.isSimulationError(sim)) {
    return {
      ok: false,
      error: sim.error,
      latestLedger: sim.latestLedger,
      events: safeHumanize(rawEvents),
      rawEventCount: rawEvents.length,
      needsRestore: false,
    };
  }

  const data = sim.transactionData.build();
  const resources = data.resources;
  return {
    ok: true,
    latestLedger: sim.latestLedger,
    minResourceFee: sim.minResourceFee,
    transactionDataXdr: data.toXDR("base64"),
    footprint: {
      readOnly: resources.footprint.readOnly.map((key) => key.toXDR("base64")),
      readWrite: resources.footprint.readWrite.map((key) => key.toXDR("base64")),
      instructions: resources.instructions,
      diskReadBytes: resources.diskReadBytes,
      writeBytes: resources.writeBytes,
    },
    returnValue: decodeRetval(sim.result?.retval),
    returnValueXdr: sim.result?.retval.toXDR("base64"),
    events: safeHumanize(rawEvents),
    rawEventCount: rawEvents.length,
    needsRestore: rpc.Api.isSimulationRestore(sim),
  };
}

export function summarizeExecution(
  result: rpc.Api.GetTransactionResponse,
): ExecutionReport {
  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return { status: result.status, hash: result.txHash, events: [] };
  }

  const success = result.status === rpc.Api.GetTransactionStatus.SUCCESS;
  const retval = success ? result.returnValue : undefined;
  return {
    status: result.status,
    hash: result.txHash,
    ledger: result.ledger,
    returnValue: decodeRetval(retval),
    returnValueXdr: retval?.toXDR("base64"),
    resultXdr: result.resultXdr.toXDR("base64"),
    events: safeHumanize(result.events.contractEventsXdr.flat()),
  };
}
