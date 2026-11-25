// Deterministic stand-in for a mainnet-sized StreamPay event archive.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The generator emits real Soroban SCVal XDR so the benchmark exercises the
// production decoder, not a stub of it. Resolved from the indexer's own
// dependency tree because perf/ installs nothing.
const requireFromIndexer = createRequire(resolve(here, "../../indexer/package.json"));
const { nativeToScVal, Keypair } = requireFromIndexer("@stellar/stellar-sdk");

/** mulberry32: reproducible across machines, so the published table can be re-run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mainnet account address, derived from the stream id so it is stable per seed. */
function accountAddress(index) {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(index, 0);
  return Keypair.fromRawEd25519Seed(seed).publicKey();
}

function symbol(name) {
  return nativeToScVal(name, { type: "symbol" }).toXDR("base64");
}

/** The contract emits account/contract fields as SCVal addresses, not strings. */
function address(strkey) {
  return nativeToScVal(strkey, { type: "address" });
}

/**
 * One stream lifecycle, spread over `span` ledgers.
 *
 * Shapes mirror the contract's emits: a create, several partial withdrawals,
 * a top-up and a cancel. Two of them intentionally land in the same ledger,
 * because a ledger can hold several events for one stream and an ingester must
 * still apply them in order.
 */
function lifecycle(streamId, createLedger, random, contractId) {
  const sender = accountAddress(streamId);
  const recipient = accountAddress(streamId + 1_000_000);
  const deposit = 15_000_000n + BigInt(streamId % 97) * 1_000_000n;
  const rows = [];
  let ledger = createLedger;
  let withdrawn = 0n;

  const push = (name, value, at) => {
    ledger = at;
    rows.push({ name, ledger, value });
  };

  push("stream_created", {
    sender: address(sender),
    recipient: address(recipient),
    token: address(contractId),
    deposit,
    start_time: BigInt(ledger * 5),
    end_time: BigInt(ledger * 5 + 86_400),
    cancelable: true,
  }, ledger);

  const withdrawals = 2 + (random() < 0.35 ? 1 : 0);
  for (let i = 0; i < withdrawals; i += 1) {
    withdrawn += deposit / BigInt(4 * withdrawals);
    ledger += 1 + Math.floor(random() * 40);
    push("withdrawn", { withdrawn_total: withdrawn }, ledger);
  }

  // Same-ledger pair: an ordering bug shows up as a wrong `deposit` projection.
  ledger += 3;
  push("stream_topped_up", { new_deposit: deposit + 5_000_000n }, ledger);
  push("stream_cancelled", {
    cancelled_by: address(sender),
    recipient_amount: deposit - withdrawn,
    sender_amount: 0n,
  }, ledger);

  return rows;
}

/**
 * @returns {{ events: object[], ledgerSpan: number, startLedger: number }}
 *   Events in the order an RPC would page them: ascending ledger, then id.
 */
export function generateSyntheticArchive(options = {}) {
  const streamCount = options.streamCount ?? 5_000;
  const ledgerSpan = options.ledgerSpan ?? 10_000;
  const startLedger = options.startLedger ?? 50_000_000;
  const seed = options.seed ?? 20261017;
  const contractId = options.contractId ?? "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";

  const random = rng(seed);
  const draft = [];
  for (let i = 0; i < streamCount; i += 1) {
    const streamId = i + 1;
    const createLedger = startLedger + Math.floor((i / streamCount) * ledgerSpan) + Math.floor(random() * 4);
    for (const row of lifecycle(streamId, createLedger, random, contractId)) {
      draft.push({ ...row, streamId });
    }
  }

  draft.sort((a, b) => a.ledger - b.ledger || a.streamId - b.streamId);
  const events = draft.map((row, index) => ({
    id: `${String(row.ledger).padStart(8, "0")}-${String(index).padStart(10, "0")}`,
    pagingToken: `${String(row.ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`,
    type: "contract",
    ledger: row.ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + row.ledger * 5_000).toISOString(),
    contractId,
    topic: [symbol(row.name), nativeToScVal(BigInt(row.streamId)).toXDR("base64")],
    value: nativeToScVal(row.value).toXDR("base64"),
  }));

  const last = events[events.length - 1];
  return { events, tip: last ? last.ledger : startLedger, startLedger, ledgerSpan };
}
