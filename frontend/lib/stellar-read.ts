import "server-only";

import {
  Account,
  Address,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  Contract,
  xdr,
} from "@stellar/stellar-sdk";
import type { StreamPolicyView, StreamView } from "@/lib/stream-types";
// The `StreamPolicy` shape comes from the generated event-schema registry
// (schemas/events/registry.json), shared with the indexer (issue #213).
import type { StreamPolicy } from "@/lib/generated/events";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "";
const MAX_PAGE_SIZE = 50;

const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

function contract(): Contract {
  if (!CONTRACT_ID) {
    throw new Error(
      "NEXT_PUBLIC_STREAMING_CONTRACT_ID is not set — deploy the contract and put its id in frontend/.env.local"
    );
  }
  return new Contract(CONTRACT_ID);
}

function scAddr(value: string) {
  return nativeToScVal(new Address(value), { type: "address" });
}

function u64(id: string | number | bigint) {
  return nativeToScVal(BigInt(id), { type: "u64" });
}

function u32(value: number) {
  return nativeToScVal(BigInt(value), { type: "u32" });
}

async function simulateRead(
  method: string,
  args: xdr.ScVal[]
): Promise<xdr.ScVal | null> {
  const server = new rpc.Server(RPC_URL);
  const transaction = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(contract().call(method, ...args))
    .setTimeout(30)
    .build();
  const simulated = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulated)) return null;
  return simulated.result?.retval ?? null;
}

export async function readStream(streamId: string): Promise<StreamView> {
  const retval = await simulateRead("get_stream", [u64(streamId)]);
  if (!retval) {
    throw new Error(`Stream #${streamId} not found or RPC unavailable`);
  }
  const raw = scValToNative(retval) as Record<string, unknown>;
  return {
    id: String(raw.id),
    sender: String(raw.sender),
    recipient: String(raw.recipient),
    token: String(raw.token),
    deposit: String(raw.deposit),
    withdrawn: String(raw.withdrawn),
    startTime: Number(raw.start_time),
    endTime: Number(raw.end_time),
    cancelable: Boolean(raw.cancelable),
    status: String(raw.status),
  };
}

export async function readAvailable(streamId: string): Promise<bigint> {
  const retval = await simulateRead("available", [u64(streamId)]);
  if (!retval) {
    throw new Error(`Stream #${streamId} not found or RPC unavailable`);
  }
  return BigInt(scValToNative(retval) as bigint);
}

/**
 * The storage layout version a stream record carries, or `null` when the
 * contract refused to read it: `stream_record_version` fails closed with
 * `SchemaVersionUnsupported` on a layout this build does not understand, and a
 * simulation error is exactly that signal. `scripts/migrate_audit.ts` walks the
 * same view over an address's indexes.
 */
export async function readStreamRecordVersion(streamId: string): Promise<number | null> {
  const retval = await simulateRead("stream_record_version", [u64(streamId)]);
  return retval ? Number(scValToNative(retval) as number) : null;
}

/**
 * The address that receives the unstreamed remainder on cancel (issue #204), or
 * `null` when the read failed. The contract returns the sender for an unrouted
 * stream, so callers compare against `stream.sender` instead of testing for an
 * absent key.
 */
export async function readRefundTarget(streamId: string): Promise<string | null> {
  const retval = await simulateRead("refund_target", [u64(streamId)]);
  return retval ? String(scValToNative(retval)) : null;
}

export async function fetchStreamIdsPage(
  address: string,
  role: "recipient" | "sender",
  offset: number
): Promise<{ ids: string[]; hasMore: boolean }> {
  const view = role === "recipient" ? "recipient_streams" : "sender_streams";
  const retval = await simulateRead(view, [
    scAddr(address),
    u32(offset),
    u32(MAX_PAGE_SIZE),
  ]);
  const ids = retval
    ? ((scValToNative(retval) as bigint[]) ?? []).map((id) => String(id))
    : [];
  return {
    ids,
    hasMore: ids.length === MAX_PAGE_SIZE,
  };
}

export async function readStreamPolicy(
  token?: string
): Promise<StreamPolicyView | null> {
  try {
    const arg = token
      ? nativeToScVal(new Address(token), { type: "address" })
      : nativeToScVal(null);
    const retval = await simulateRead("get_stream_policy", [arg]);
    if (!retval) return null;
    const raw = scValToNative(retval) as StreamPolicy | null;
    if (!raw) return null;
    return {
      minDeposit: String(raw.min_deposit),
      minDuration: Number(raw.min_duration),
      maxDuration: Number(raw.max_duration),
      minRate: String(raw.min_rate),
      maxRate: String(raw.max_rate),
    };
  } catch {
    return null;
  }
}