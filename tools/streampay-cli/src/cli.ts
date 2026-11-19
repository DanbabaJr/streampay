#!/usr/bin/env node
/**
 * Read-only StreamPay CLI.
 *
 * `status` / `get` print one decoded stream snapshot. With `--watch`, the CLI
 * polls `get_stream` and emits JSON Lines: one record per observed state
 * change plus a final summary on SIGINT. `--json` output (including every
 * watch line) is validated against `json-schema-v1.json`.
 */
import { pathToFileURL } from "node:url";
import {
  Account,
  Address,
  Contract,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  decodeStreamState,
  type NetworkLabel,
  type StreamCommand,
  type StreamState,
} from "./state.ts";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  watchStream,
} from "./watch.ts";

interface Options {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
  json: boolean;
  watch: boolean;
}

interface RunResult {
  value?: Record<string, unknown>;
  exitCode: number;
}

class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code: string, exitCode: number) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const DEFAULT_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);
const READ_COMMANDS = new Set(["status", "get"]);

function usage(): string {
  return `Usage:
  streampay [global options] <status|get> --stream-id <n> [--watch] [options]

Commands:
  status, get             Read and print one decoded stream snapshot

Options:
  --contract <C...>       StreamPay contract id (required)
  --stream-id <n>         Stream id (required)
  --network <testnet|mainnet> (default: testnet)
  --rpc-url <url>         Soroban RPC endpoint
  --json                  Emit one JSON object (schema v1)
  --watch                 Poll and emit JSON Lines, one line per state change
  --interval <ms>         Watch poll interval in milliseconds
                          (default: ${DEFAULT_WATCH_INTERVAL_MS}; minimum: ${MIN_WATCH_INTERVAL_MS})
  -h, --help              Show this help

Watch mode always emits JSON Lines, even without --json. It prints a baseline
line on the first successful poll, nothing for unchanged polls, and a final
summary line on SIGINT. The change key is the decoded stream state from
get_stream (id, parties, token, amounts, window, cancelable, status); RPC
metadata such as the latest ledger is ignored.`;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const booleanFlags = new Set(["--json", "--watch", "--help"]);
  const valueFlags = new Set([
    "--contract",
    "--stream-id",
    "--network",
    "--rpc-url",
    "--interval",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === undefined) continue;
    if (part === "-h") {
      flags.add("--help");
      continue;
    }
    if (!part.startsWith("--")) {
      positional.push(part);
      continue;
    }
    if (booleanFlags.has(part)) {
      flags.add(part);
      continue;
    }
    if (!valueFlags.has(part)) {
      throw new CliError(`unknown option: ${part}`, "USAGE", 2);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliError(`missing value for ${part}`, "USAGE", 2);
    }
    values.set(part.slice(2), value);
    index += 1;
  }

  if (positional.length > 1) {
    throw new CliError(`unexpected argument: ${positional[1]}`, "USAGE", 2);
  }
  return {
    command: flags.has("--help") ? "help" : positional[0] ?? "help",
    values,
    flags,
    json: flags.has("--json"),
    watch: flags.has("--watch"),
  };
}

function getOption(options: Options, name: string): string | undefined {
  return options.values.get(name);
}

function required(options: Options, name: string): string {
  const value = getOption(options, name);
  if (!value) throw new CliError(`missing required --${name}`, "USAGE", 2);
  return value;
}

function parseAddress(value: string, label: string): string {
  try {
    return Address.fromString(value).toString();
  } catch {
    throw new CliError(`invalid ${label} address`, "USAGE", 2);
  }
}

function parsePositiveInteger(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new CliError(`${label} must be a positive integer`, "USAGE", 2);
  }
  return BigInt(value);
}

function parseInterval(options: Options): number {
  const raw = getOption(options, "interval");
  if (raw === undefined) return DEFAULT_WATCH_INTERVAL_MS;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < MIN_WATCH_INTERVAL_MS) {
    throw new CliError(
      `--interval must be an integer number of milliseconds >= ${MIN_WATCH_INTERVAL_MS}`,
      "USAGE",
      2
    );
  }
  return Number(raw);
}

function networkConfig(options: Options): {
  passphrase: string;
  rpcUrl: string;
  label: NetworkLabel;
} {
  const network = getOption(options, "network") ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new CliError("--network must be testnet or mainnet", "USAGE", 2);
  }
  return {
    passphrase: network === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
    rpcUrl:
      getOption(options, "rpc-url") ??
      (network === "testnet" ? DEFAULT_TESTNET_RPC : DEFAULT_MAINNET_RPC),
    label: network,
  };
}

function createServer(rpcUrl: string): rpc.Server {
  // `allowHttp` is required by the SDK for local mock/dev RPC endpoints.
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readStreamState(
  server: rpc.Server,
  contractId: string,
  passphrase: string,
  streamId: string
): Promise<StreamState> {
  let transaction: ReturnType<TransactionBuilder["build"]>;
  try {
    transaction = new TransactionBuilder(DUMMY_SOURCE, {
      fee: "100",
      networkPassphrase: passphrase,
    })
      .addOperation(
        new Contract(contractId).call(
          "get_stream",
          nativeToScVal(BigInt(streamId), { type: "u64" })
        )
      )
      .setTimeout(30)
      .build();
  } catch (error) {
    throw new CliError(`could not build get_stream simulation: ${errorMessage(error)}`, "RPC", 1);
  }

  let simulation: Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;
  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (error) {
    throw new CliError(`Soroban RPC simulation failed: ${errorMessage(error)}`, "RPC", 1);
  }
  if (rpc.Api.isSimulationError(simulation)) {
    throw new CliError(`simulation of get_stream failed: ${simulation.error}`, "SIMULATION", 4);
  }
  const retval = simulation.result?.retval;
  if (!retval) {
    throw new CliError("simulation of get_stream returned no value", "SIMULATION", 4);
  }
  try {
    return decodeStreamState(scValToNative(retval));
  } catch (error) {
    throw new CliError(`could not decode get_stream result: ${errorMessage(error)}`, "SIMULATION", 4);
  }
}

function snapshotRecord(
  command: StreamCommand,
  network: NetworkLabel,
  contract: string,
  stream: StreamState
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ok: true,
    command,
    network,
    contract,
    stream,
  };
}

function printText(stream: StreamState): void {
  console.log(`Stream #${stream.id}: ${stream.status}`);
  console.log(`  sender:     ${stream.sender}`);
  console.log(`  recipient:  ${stream.recipient}`);
  console.log(`  token:      ${stream.token}`);
  console.log(`  deposit:    ${stream.deposit}`);
  console.log(`  withdrawn:  ${stream.withdrawn}`);
  console.log(`  start:      ${stream.startTime}`);
  console.log(`  end:        ${stream.endTime}`);
  console.log(`  cancelable: ${stream.cancelable}`);
}

function printResult(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  if (value.help) {
    console.log(String(value.help));
    return;
  }
  printText(value.stream as StreamState);
}

/** Resolves once buffered stdout writes have flushed (SIGINT path). */
function flushStdout(): Promise<void> {
  if (process.stdout.writableLength === 0) return Promise.resolve();
  return new Promise((resolve) => process.stdout.write("", () => resolve()));
}

async function run(options: Options): Promise<RunResult> {
  if (options.command === "help") {
    return { value: { schemaVersion: 1, ok: true, help: usage() }, exitCode: 0 };
  }
  if (!READ_COMMANDS.has(options.command)) {
    throw new CliError(`unknown command: ${options.command}`, "USAGE", 2);
  }

  const command = options.command as StreamCommand;
  const contractId = parseAddress(required(options, "contract"), "contract");
  const streamId = parsePositiveInteger(
    required(options, "stream-id"),
    "stream-id"
  ).toString();
  const network = networkConfig(options);
  const intervalMs = parseInterval(options);
  const server = createServer(network.rpcUrl);
  const read = () =>
    readStreamState(server, contractId, network.passphrase, streamId);

  if (options.watch) {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      await watchStream({
        command,
        network: network.label,
        contract: contractId,
        intervalMs,
        readStream: read,
        writeLine: (line) => console.log(JSON.stringify(line)),
        signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    // Flush the summary before exiting; a still-pending RPC socket must not
    // keep the process alive after the operator pressed Ctrl-C.
    await flushStdout();
    process.exit(0);
  }

  const stream = await read();
  return {
    value: snapshotRecord(command, network.label, contractId, stream),
    exitCode: 0,
  };
}

async function main(): Promise<void> {
  let options: Options = {
    command: "help",
    values: new Map(),
    flags: new Set(),
    json: false,
    watch: false,
  };
  try {
    options = parseArgs(process.argv.slice(2));
    const result = await run(options);
    if (result.value) {
      printResult(result.value, options.json);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    const failure =
      error instanceof CliError ? error : new CliError(errorMessage(error), "RPC", 1);
    if (options.json || options.watch || process.argv.includes("--json")) {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: { code: failure.code, message: failure.message },
        })
      );
    } else {
      console.error(`streampay: ${failure.message}`);
    }
    process.exitCode = failure.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
