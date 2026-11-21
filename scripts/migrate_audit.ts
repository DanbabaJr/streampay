#!/usr/bin/env node
/**
 * migrate_audit.ts — StreamPay's off-chain storage-migration planner.
 *
 * The contract tags every persisted stream record with an explicit layout
 * version and exposes `migrate_stream_version(stream_id)`: a permissionless,
 * idempotent, gas-bounded rewrite that lifts a legacy record onto the current
 * layout. Records of a layout this build does not understand are refused
 * (`SchemaVersionUnsupported`) rather than guessed at. This tool turns that
 * contract surface into an operational plan: which streams exist under the
 * addresses you care about, what layout each one is stored in, and which of
 * them still need a migration call.
 *
 * Two modes:
 *
 *   live     — walk `recipient_streams` / `sender_streams` over Soroban RPC and
 *              read each stream's record version with `stream_record_version`.
 *              Uses the same read path as `frontend/lib/stellar-read.ts`
 *              (simulateTransaction, no writes, no keys).
 *   snapshot — classify a captured set of decoded storage records
 *              (`tests/migration-audit/records.json`) from their bytes. Needs no
 *              network, no keys and no `node_modules`.
 *
 * Layout classification lives in `frontend/lib/migration-report.ts` so the
 * planner, the golden report under `docs/` and the frontend all agree on what
 * "legacy" versus "future" means.
 *
 * Usage (Node >= 22.6):
 *
 *   node --experimental-strip-types scripts/migrate_audit.ts \
 *     --contract C... --owner G... --owner G... [--rpc-url url] [--format md] [--out plan.md]
 *
 *   node --experimental-strip-types scripts/migrate_audit.ts \
 *     --snapshot tests/migration-audit/records.json [--format md] [--out plan.md]
 *
 * Options:
 *   --contract <C...>      StreamPay contract id (live mode)
 *   --owner <G...|C...>    address whose sender and recipient indexes to walk;
 *                          repeat the flag for several addresses
 *   --snapshot <file>      captured decoded records; switches to offline mode
 *   --record-version <n>   layout version this build writes (default 2)
 *   --rpc-url <url>        Soroban RPC endpoint (default: testnet RPC)
 *   --passphrase <str>     network passphrase (default: test net)
 *   --max-pages <n>        safety bound on index pages per address (default 200)
 *   --format table|md      output format (default table)
 *   --out <file>           write the report to a file instead of stdout
 *
 * Exit code 0 = the walk completed (the plan may still list blocked records);
 * 2 = bad arguments; 1 = the walk could not be completed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import {
  buildMigrationReport,
  buildReportFromVersions,
  renderReportMarkdown,
  renderReportTable,
  STREAM_RECORD_VERSION_V2,
  type MigrationReport,
  type ScValShape,
} from "../frontend/lib/migration-report.ts";

interface Args {
  contract: string;
  owners: string[];
  snapshot?: string;
  recordVersion: number;
  rpcUrl: string;
  passphrase: string;
  maxPages: number;
  format: "table" | "md";
  out?: string;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
/** `MAX_PAGE_SIZE` in the contract's paginated index readers. */
const PAGE_SIZE = 50;

function usage(message?: string): never {
  if (message) console.error(`migrate_audit: ${message}`);
  console.error(
    "usage: migrate_audit --contract <C...> --owner <address> [--owner ...] | --snapshot <file> " +
      "[--record-version <n>] [--rpc-url <url>] [--passphrase <str>] [--max-pages <n>] " +
      "[--format table|md] [--out <file>]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const repeatable = (name: string): string[] => {
    const values: string[] = [];
    for (let index = argv.indexOf(`--${name}`); index >= 0; index = argv.indexOf(`--${name}`, index + 1)) {
      const value = argv[index + 1];
      if (value) values.push(value);
    }
    return values;
  };

  const snapshot = flag("snapshot");
  const contract = flag("contract") ?? "";
  const owners = repeatable("owner");
  if (!snapshot && (!contract || owners.length === 0)) usage("live mode needs --contract and at least one --owner");
  if (snapshot && owners.length > 0) usage("--snapshot mode ignores --owner");

  const recordVersion = Number(flag("record-version") ?? STREAM_RECORD_VERSION_V2);
  if (!Number.isInteger(recordVersion) || recordVersion < 1) usage("--record-version must be a positive integer");
  const maxPages = Number(flag("max-pages") ?? 200);
  if (!Number.isInteger(maxPages) || maxPages < 1) usage("--max-pages must be a positive integer");
  const format = flag("format") ?? "table";
  if (format !== "table" && format !== "md") usage("--format is table or md");

  return {
    contract: contract || "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2ZMN",
    owners,
    snapshot,
    recordVersion,
    rpcUrl: flag("rpc-url") ?? TESTNET_RPC,
    passphrase: flag("passphrase") ?? TESTNET_PASSPHRASE,
    maxPages,
    format,
    out: flag("out"),
  };
}

// --------------------------------------------------------------- snapshot ----

interface SnapshotFile {
  schemaVersion: number;
  contract: string;
  writtenVersion: number;
  records: { streamId: string; shape: ScValShape }[];
}

function reportFromSnapshot(path: string, recordVersion: number): MigrationReport {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`unsupported snapshot schemaVersion ${parsed.schemaVersion}`);
  }
  // The tag the *audited build* writes is a property of that build, not of the
  // capture: pass it in rather than trusting the file's copy.
  return buildMigrationReport(parsed.contract, recordVersion, parsed.records);
}

// -------------------------------------------------------------------- live ----

/**
 * Simulate a read-only contract call and decode its return value. Mirrors
 * `frontend/lib/stellar-read.ts`: a dummy source account, no fee bump, no
 * signature — reads cost nothing and need no keys.
 */
async function simulateRead(
  sdk: typeof import("@stellar/stellar-sdk"),
  args: Args,
  method: string,
  scArgs: unknown[],
): Promise<unknown | null> {
  const { Account, Contract, TransactionBuilder, rpc } = sdk;
  const dummySource = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0",
  );
  const transaction = new TransactionBuilder(dummySource, {
    fee: "100",
    networkPassphrase: args.passphrase,
  })
    .addOperation(new Contract(args.contract).call(method, ...(scArgs as never[])))
    .setTimeout(30)
    .build();
  const simulated = await new rpc.Server(args.rpcUrl).simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulated)) return null;
  const retval = simulated.result?.retval;
  return retval ? sdk.scValToNative(retval) : null;
}

/** Paginate one address index until a short page ends it. */
async function walkIndex(
  sdk: typeof import("@stellar/stellar-sdk"),
  args: Args,
  method: string,
  owner: string,
): Promise<string[]> {
  const { Address, nativeToScVal } = sdk;
  const ids: string[] = [];
  for (let page = 0; page < args.maxPages; page += 1) {
    const scArgs = [
      nativeToScVal(new Address(owner), { type: "address" }),
      nativeToScVal(BigInt(page * PAGE_SIZE), { type: "u32" }),
      nativeToScVal(BigInt(PAGE_SIZE), { type: "u32" }),
    ];
    const batch = (await simulateRead(sdk, args, method, scArgs)) as bigint[] | null;
    if (!batch) break;
    ids.push(...batch.map((id) => String(id)));
    if (batch.length < PAGE_SIZE) break;
  }
  return ids;
}

async function reportFromChain(args: Args): Promise<MigrationReport> {
  const sdk = await import("@stellar/stellar-sdk");
  const streamIds = new Set<string>();
  for (const owner of args.owners) {
    for (const method of ["recipient_streams", "sender_streams"]) {
      for (const id of await walkIndex(sdk, args, method, owner)) streamIds.add(id);
    }
  }
  const versions: { streamId: string; version: number | null }[] = [];
  for (const streamId of streamIds) {
    const { nativeToScVal } = sdk;
    const version = (await simulateRead(sdk, args, "stream_record_version", [
      nativeToScVal(BigInt(streamId), { type: "u64" }),
    ])) as bigint | null;
    // `null` means the simulation failed — including the fail-closed rejection
    // of an unknown layout — which is reported as "no readable version tag".
    versions.push({ streamId, version: version === null ? null : Number(version) });
  }
  versions.sort((a, b) => Number(BigInt(a.streamId) - BigInt(b.streamId)));
  return buildReportFromVersions(args.contract, args.recordVersion, versions);
}

// ------------------------------------------------------------------- main ----

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = args.snapshot
    ? reportFromSnapshot(args.snapshot, args.recordVersion)
    : await reportFromChain(args);
  const rendered = args.format === "md" ? renderReportMarkdown(report) : renderReportTable(report);
  if (args.out) writeFileSync(args.out, rendered, "utf8");
  else process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

await main().catch((error: unknown) => {
  console.error(`migrate_audit: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
