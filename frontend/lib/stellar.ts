/**
 * Minimal Soroban integration for StreamPay.
 *
 * Flow for every mutating call: build the contract operation → simulate
 * (validity + resource estimate) → Freighter signs → send → poll until
 * inclusion, then decode the contract's return value. Read-only calls
 * simulate and decode the return value without signing.
 */
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
import { signTransaction } from "@stellar/freighter-api";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "";

function contract(): Contract {
  if (!CONTRACT_ID) {
    throw new Error(
      "NEXT_PUBLIC_STREAMING_CONTRACT_ID is not set — deploy the contract and put its id in frontend/.env.local"
    );
  }
  return new Contract(CONTRACT_ID);
}

export interface StreamArgs {
  token: string;
  recipient: string;
  /** Deposit in smallest token units (stroops for classic assets), as a string. */
  deposit: string;
  /** Stream length in days (start = now). */
  days: string;
  cancelable: boolean;
}

export interface StreamView {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
}

/** One hash-linked attestation attached to a stream (see `attach_metadata`). */
export interface AttestationView {
  index: number;
  attester: string;
  /** Lowercase hex (64 chars) of the 32-byte content hash. */
  contentHash: string;
  tag: string;
  timestamp: number;
}

function scAddr(s: string) {
  return nativeToScVal(new Address(s), { type: "address" });
}

function u64(id: string | number | bigint) {
  return nativeToScVal(BigInt(id), { type: "u64" });
}

function i128(v: string) {
  return nativeToScVal(BigInt(v), { type: "i128" });
}

function u32(v: number) {
  return nativeToScVal(BigInt(v), { type: "u32" });
}

/**
 * Network label for localStorage keys — stream ids are per-network facts and
 * must never leak between testnet and publicnet caches.
 */
export const NETWORK_LABEL = NETWORK === Networks.PUBLIC ? "public" : "testnet";

/** Map a StreamError code (contract errors surface as `Error(Contract, #N)`). */
const STREAM_ERRORS: Record<number, string> = {
  1: "StreamNotFound",
  2: "NotStreamSender",
  3: "NotStreamRecipient",
  4: "StreamNotCancellable",
  5: "StreamNotActive",
  6: "StartTimeInPast",
  7: "InvalidTimeRange",
  8: "DurationTooLong",
  9: "ZeroAmount",
  10: "AmountExceedsAvailable",
  11: "MathOverflow",
  12: "NotAuthorized",
  13: "NothingToWithdraw",
  14: "MetadataTagTooLong",
  15: "MetadataLimitReached",
  14: "FeeRateTooHigh",
  15: "NotGovernor",
  16: "NoPendingGovernor",
  17: "InsufficientTreasuryBalance",
};

/** Rewrites raw simulation/tx error text into a readable StreamError name. */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(/Error\(Contract, #(\d+)\)/);
  if (m) {
    const name = STREAM_ERRORS[Number(m[1])];
    return name
      ? `Contract rejected the call: ${name} (#${m[1]})`
      : `Contract error #${m[1]}`;
  }
  return message;
}

/** The ed25519 all-zero key: a syntactically valid source for simulations. */
const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

/**
 * Builds, simulates, Freighter-signs, sends and polls a mutating contract
 * operation. Resolves with the contract method's decoded return value.
 */
async function send<T>(
  source: string,
  operation: xdr.Operation,
  decode: (v: xdr.ScVal) => T
): Promise<T> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  // 1. Simulate: catches contract errors early and assembles Soroban tx data.
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation failed: ${simulated.error}`);
  }
  const ready = rpc.assembleTransaction(tx, simulated).build();

  // 2. Sign with Freighter.
  const { signedTxXdr } = await signTransaction(ready.toXDR(), {
    networkPassphrase: NETWORK,
  });
  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK);

  // 3. Send and poll for inclusion.
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${JSON.stringify(res.resultXdr)}`);
    }
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successful = res as { returnValue: xdr.ScVal };
      return decode(successful.returnValue);
    }
    // PENDING / DUPLICATE / TRY_AGAIN_LATER — keep polling.
  }
  throw new Error("Timed out waiting for transaction inclusion");
}

export async function createStream(
  sender: string,
  args: StreamArgs
): Promise<bigint> {
  const start = Math.floor(Date.now() / 1000) + 1;
  const end = start + Math.ceil(Number(args.days) * 86_400);
  const op = contract().call(
    "create_stream",
    scAddr(sender),
    scAddr(args.recipient),
    scAddr(args.token),
    i128(args.deposit),
    u64(start),
    u64(end),
    nativeToScVal(args.cancelable)
  );
  // create_stream returns the new stream id (u64).
  return send(sender, op, (v) => BigInt(scValToNative(v) as bigint));
}

export async function withdrawFromStream(
  recipient: string,
  streamId: string,
  amount: string
): Promise<void> {
  await send(
    recipient,
    contract().call("withdraw", u64(streamId), i128(amount)),
    () => undefined
  );
}

/**
 * Claims the full accrued balance in one atomic call (`withdraw_max`),
 * returning the amount paid (smallest token units).
 */
export async function withdrawMaxFromStream(
  recipient: string,
  streamId: string
): Promise<bigint> {
  return send(
    recipient,
    contract().call("withdraw_max", u64(streamId)),
    (v) => BigInt(scValToNative(v) as bigint)
  );
}

export async function topUpStream(
  sender: string,
  streamId: string,
  amount: string
): Promise<void> {
  await send(
    sender,
    contract().call("top_up", u64(streamId), i128(amount)),
    () => undefined
  );
}

export async function cancelStream(
  caller: string,
  streamId: string
): Promise<void> {
  await send(
    caller,
    contract().call("cancel_stream", scAddr(caller), u64(streamId)),
    () => undefined
  );
}

/** Read-only contract call: simulated, never signed, return value decoded. */
async function simulateRead(
  method: string,
  args: xdr.ScVal[]
): Promise<xdr.ScVal | null> {
  const server = new rpc.Server(RPC_URL);
  const tx = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(contract().call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return null;
  return sim.result?.retval ?? null;
}

/** Read-only view of one stream. */
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

/** Accrued-but-unwithdrawn balance of a stream at the current ledger time. */
export async function readAvailable(streamId: string): Promise<bigint> {
  const retval = await simulateRead("available", [u64(streamId)]);
  if (!retval) {
    throw new Error(`Stream #${streamId} not found or RPC unavailable`);
  }
  return BigInt(scValToNative(retval) as bigint);
}

/** Parses a 64-char hex string into the 32 bytes a `BytesN<32>` expects. */
function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(
      "Content hash must be 64 hex characters (a 32-byte digest, e.g. SHA-256)."
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Attaches a hash-linked attestation to a stream (`attach_metadata`).
 * `attester` must be the stream's sender or recipient and sign the call.
 * Returns the new attestation's index. Attestations are append-only.
 */
export async function attachMetadata(
  attester: string,
  streamId: string,
  contentHashHex: string,
  tag: string
): Promise<number> {
  const op = contract().call(
    "attach_metadata",
    scAddr(attester),
    u64(streamId),
    nativeToScVal(hexToBytes32(contentHashHex), { type: "bytes" }),
    nativeToScVal(tag, { type: "string" })
  );
  return send(attester, op, (v) => Number(scValToNative(v)));
}

/**
 * Reads a stream's attestations (read-only), following pagination until
 * exhausted. An unknown stream yields an empty list.
 */
export async function readAttestations(
  streamId: string
): Promise<AttestationView[]> {
  const out: AttestationView[] = [];
  for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
    const retval = await simulateRead("stream_attestations", [
      u64(streamId),
      u32(offset),
      u32(MAX_PAGE_SIZE),
    ]);
    if (!retval) break;
    const raw =
      (scValToNative(retval) as Array<Record<string, unknown>>) ?? [];
    for (const a of raw) {
      out.push({
        index: Number(a.index),
        attester: String(a.attester),
        contentHash: bytesToHex(a.content_hash as Uint8Array),
        tag: String(a.tag),
        timestamp: Number(a.timestamp),
      });
    }
    if (raw.length < MAX_PAGE_SIZE) break;
  }
  return out;
}

const MAX_PAGE_SIZE = 50; // mirrors the contract's MAX_PAGE_SIZE

/** One page of stream ids from an address index view (read-only). */
async function readStreamIdsPage(
  view: "recipient_streams" | "sender_streams",
  address: string,
  offset: number
): Promise<string[]> {
  const retval = await simulateRead(view, [
    scAddr(address),
    u32(offset),
    u32(MAX_PAGE_SIZE),
  ]);
  if (!retval) return [];
  const raw = scValToNative(retval) as bigint[];
  return (raw ?? []).map((id) => String(id));
}

/**
 * Discovers all streams for an address through the on-chain indexes,
 * following pagination until exhausted. `role` selects the index:
 * streams where the address receives funds ("recipient") or funds them
 * ("sender"). Streams that fail to read (archived, RPC hiccups) are skipped.
 */
export async function fetchStreamsFor(
  address: string,
  role: "recipient" | "sender"
): Promise<StreamView[]> {
  const view = role === "recipient" ? "recipient_streams" : "sender_streams";
  const ids: string[] = [];
  for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
    const page = await readStreamIdsPage(view, address, offset);
    ids.push(...page);
    if (page.length < MAX_PAGE_SIZE) break;
  }
  const streams = await Promise.all(
    ids.map((id) => readStream(id).catch(() => null))
  );
  return streams.filter((s): s is StreamView => s !== null);
}
