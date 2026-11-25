#!/usr/bin/env node
/**
 * verify-fees.ts — open, public audit of StreamPay's protocol-fee ledger.
 *
 * Anyone can run this against a deployed StreamPay contract; no keys, no
 * privileged access, only a Soroban RPC endpoint. It reconciles the three
 * independent records of the treasury:
 *
 *   1. Stored totals     — `treasury_status(token)` (charged / withdrawn).
 *   2. Stored per-stream — the `verify_treasury` scan over the stream-id
 *                          space (Σ per-stream fees).
 *   3. Event trail       — `FeeCharged` / `FeeWithdrawn` events via RPC
 *                          `getEvents` (optional, needs --start-ledger).
 *
 * The core invariant (checked always): (1).charged_total == (2)'s sum, i.e.
 * the treasury totals provably equal the per-stream fees recorded at the
 * deposit boundary. With --start-ledger the event trail is folded in:
 * both stored totals must also equal the Σ of decoded events, and every
 * FeeCharged event's amount must equal the stream's stored fee.
 *
 * Usage (Node >= 22.6, no build step):
 *
 *   cd scripts && npm install
 *   npm run verify-fees -- --contract C... --token C... [options]
 *
 * Options:
 *   --contract <C...>     StreamPay contract id (required)
 *   --token <C...>        token whose treasury to verify (required)
 *   --rpc-url <url>       Soroban RPC endpoint (default: testnet RPC)
 *   --passphrase <str>    network passphrase for simulations
 *                         (default: Test SDF Network ; September 2015)
 *   --start-ledger <n>    earliest ledger to fetch events from — should be
 *                         the contract's deployment ledger for a complete
 *                         event cross-check. Omit to skip event checks
 *                         (stored-state invariant still runs).
 *   --max-pages <n>       safety bound on verification-scan pages (default 2000)
 *
 * Exit code 0 = every performed check passed; 1 = at least one failed.
 */
import {
  Account,
  Address,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

// ------------------------------------------------------------------ cli ----

interface Args {
  contract: string;
  token: string;
  rpcUrl: string;
  passphrase: string;
  startLedger?: number;
  maxPages: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const contract = get("contract");
  const token = get("token");
  if (!contract || !token) {
    console.error(
      "usage: verify-fees --contract <C...> --token <C...> [--rpc-url <url>] " +
        "[--passphrase <str>] [--start-ledger <n>] [--max-pages <n>]"
    );
    process.exit(2);
  }
  for (const c of [contract, token]) {
    try {
      Address.fromString(c);
    } catch {
      console.error(`invalid contract/token address: ${c}`);
      process.exit(2);
    }
  }
  const startRaw = get("start-ledger");
  return {
    contract,
    token,
    rpcUrl: get("rpc-url") || "https://soroban-testnet.stellar.org",
    passphrase: get("passphrase") || "Test SDF Network ; September 2015",
    startLedger: startRaw ? Number(startRaw) : undefined,
    maxPages: get("max-pages") ? Number(get("max-pages")) : 2000,
  };
}

const args = parseArgs(process.argv.slice(2));

// ------------------------------------------------------------------ rpc ----

const server = new rpc.Server(args.rpcUrl);
/** The ed25519 zero key: a syntactically valid source for simulations. */
const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

/** Read-only contract call via simulation; decodes the return ScVal. */
async function simulateRead(method: string, vals: xdr.ScVal[]): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: args.passphrase,
  })
    .addOperation(new Contract(args.contract).call(method, ...vals))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation of ${method} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  if (!retval) {
    throw new Error(`simulation of ${method} returned no value`);
  }
  return retval;
}

const scAddr = (s: string) => nativeToScVal(Address.fromString(s), { type: "address" });
const scU64 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" });
const scU32 = (v: number) => nativeToScVal(BigInt(v), { type: "u32" });
const scStr = (s: string) => nativeToScVal(s, { type: "string" });

// -------------------------------------------------------------- checks ----

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

interface TreasuryStatus {
  token: string;
  governor: string;
  pending_governor: string | null;
  fee_bps: number;
  max_fee_bps: number;
  charged_total: bigint;
  withdrawn_total: bigint;
  collectible: bigint;
}

interface FeeScan {
  token: string;
  start_id: bigint;
  scanned_count: number;
  fees_in_range: bigint;
  next_start: bigint;
  done: boolean;
}

// ---------------------------------------------------------------- main ----

async function main() {
  console.log(`StreamPay fee verification`);
  console.log(`  contract : ${args.contract}`);
  console.log(`  token    : ${args.token}`);
  console.log(`  rpc      : ${args.rpcUrl}\n`);

  // ---- 1. stored totals -------------------------------------------------
  const statusRaw = scValToNative(
    await simulateRead("treasury_status", [scAddr(args.token)])
  ) as Record<string, unknown>;
  const status: TreasuryStatus = {
    token: String(statusRaw.token),
    governor: String(statusRaw.governor),
    pending_governor:
      statusRaw.pending_governor == null ? null : String(statusRaw.pending_governor),
    fee_bps: Number(statusRaw.fee_bps),
    max_fee_bps: Number(statusRaw.max_fee_bps),
    charged_total: BigInt(statusRaw.charged_total as string | bigint | number),
    withdrawn_total: BigInt(statusRaw.withdrawn_total as string | bigint | number),
    collectible: BigInt(statusRaw.collectible as string | bigint | number),
  };

  console.log(`Treasury status:`);
  console.log(`  governor        : ${status.governor}`);
  console.log(`  pending governor: ${status.pending_governor ?? "(none)"}`);
  console.log(`  fee rate        : ${status.fee_bps} / ${status.max_fee_bps} bps`);
  console.log(`  charged total   : ${status.charged_total}`);
  console.log(`  withdrawn total : ${status.withdrawn_total}`);
  console.log(`  collectible     : ${status.collectible}\n`);

  check(
    status.collectible === status.charged_total - status.withdrawn_total,
    "collectible == charged - withdrawn"
  );

  // ---- 2. per-stream fee scan (the on-chain invariant) ------------------
  const totalStreams = BigInt(
    scValToNative(await simulateRead("total_streams", [])) as bigint
  );
  console.log(`\nStored per-stream fee scan (${totalStreams} streams):`);
  let scanSum = 0n;
  let start = 1n;
  let pages = 0;
  for (;;) {
    const scan = scValToNative(
      await simulateRead("verify_treasury", [
        scAddr(args.token),
        scU64(start),
        scU32(50),
      ])
    ) as unknown as FeeScan;
    scanSum += scan.fees_in_range;
    pages += 1;
    if (scan.done) break;
    if (scan.next_start <= start) {
      check(false, "scan pagination advances", `stalled at id ${start}`);
      break;
    }
    if (pages > args.maxPages) {
      check(false, "scan pagination terminates", `exceeded --max-pages`);
      break;
    }
    start = scan.next_start;
  }
  console.log(`  pages=${pages}  Σ per-stream fees=${scanSum}`);
  check(
    scanSum === status.charged_total,
    "core invariant: Σ per-stream fees == charged_total",
    `scan ${scanSum} vs stored ${status.charged_total}`
  );

  // ---- 3. event trail (optional, needs --start-ledger) ------------------
  if (args.startLedger === undefined) {
    console.log(
      `\nEvent cross-check skipped (pass --start-ledger <deployment ledger> ` +
        `to reconcile against FeeCharged / FeeWithdrawn events).`
    );
  } else {
    console.log(`\nEvent trail from ledger ${args.startLedger}:`);
    // Event topics are base64-encoded ScVal XDR; the event symbol is topic 0.
    const topicSym = (sym: string): string[][] => [[scStr(sym).toXDR("base64")]];
    const startLedger = args.startLedger;
    const fetchEvents = async (topics: string[][]): Promise<rpc.Api.EventResponse[]> => {
      const out: rpc.Api.EventResponse[] = [];
      let cursor: string | undefined;
      for (;;) {
        const filters: rpc.Api.EventFilter[] = [
          { type: "contract", contractIds: [args.contract], topics },
        ];
        const req: rpc.Api.GetEventsRequest = cursor
          ? { filters, cursor }
          : { filters, startLedger };
        const page = await server.getEvents(req);
        out.push(...page.events);
        if (page.events.length === 0) break;
        cursor = page.cursor;
      }
      return out;
    };

    const feeCharged = await fetchEvents(topicSym("fee_charged"));
    const feeWithdrawn = await fetchEvents(topicSym("fee_withdrawn"));

    // Every FeeCharged event must match the stored per-stream fee for the
    // requested token (events for other tokens share the id space).
    let eventCharged = 0n;
    let chargedEventsForToken = 0;
    let mismatches = 0;
    for (const ev of feeCharged) {
      const data = scValToNative(ev.value) as Record<string, unknown>;
      if (String(data.token) !== args.token) continue;
      chargedEventsForToken += 1;
      const streamId = BigInt(scValToNative(ev.topic[1]) as bigint);
      const amount = BigInt(data.amount as string | bigint | number);
      eventCharged += amount;
      const stored = BigInt(
        scValToNative(await simulateRead("stream_fee", [scU64(streamId)])) as bigint
      );
      if (stored !== amount) {
        mismatches += 1;
        console.log(
          `  [FAIL] FeeCharged stream ${streamId}: event ${amount} != stored ${stored}`
        );
      }
    }
    failures += mismatches;
    console.log(`  FeeCharged events (this token): ${chargedEventsForToken}`);
    check(
      eventCharged === status.charged_total,
      "Σ FeeCharged events == charged_total",
      `events ${eventCharged} vs stored ${status.charged_total}`
    );

    let eventWithdrawn = 0n;
    let withdrawnEventsForToken = 0;
    for (const ev of feeWithdrawn) {
      // FeeWithdrawn is keyed by token as its first topic.
      if (String(scValToNative(ev.topic[1])) !== args.token) continue;
      withdrawnEventsForToken += 1;
      const data = scValToNative(ev.value) as Record<string, unknown>;
      eventWithdrawn += BigInt(data.amount as string | bigint | number);
    }
    console.log(`  FeeWithdrawn events (this token): ${withdrawnEventsForToken}`);
    check(
      eventWithdrawn === status.withdrawn_total,
      "Σ FeeWithdrawn events == withdrawn_total",
      `events ${eventWithdrawn} vs stored ${status.withdrawn_total}`
    );
  }

  console.log(
    `\n${failures === 0 ? "All performed checks passed." : `${failures} check(s) FAILED.`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-fees: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
