import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  buildCancelStreamOperation,
  buildCreateStreamOperation,
  buildWithdrawMaxOperation,
  buildWithdrawOperation,
  i128,
  scAddr,
  u32,
  u64,
} from "../../frontend/lib/stellar-ops.ts";

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_FRIENDBOT_URL = "https://friendbot.stellar.org";
const DEFAULT_NATIVE_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const FIXTURE_CONTRACT = "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL";
const FIXTURE_SENDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FIXTURE_RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF";
const DEPOSIT = 10_000_000n;
const STREAM_DURATION_SECONDS = 300n;
const START_DELAY_SECONDS = 45n;
const DUMMY_SOURCE = new Account(FIXTURE_SENDER, "0");
const EVIDENCE_PATH = resolve(process.env.STREAMPAY_CANARY_EVIDENCE_PATH ?? "canary-result.json");

type FailureClass = "configuration" | "funding" | "simulation" | "submission";

interface CanaryStep {
  name: string;
  status: "passed" | "failed";
  transactionHash?: string;
  result?: string;
  transactionXdr?: string;
  operationXdr?: string;
  failureClass?: FailureClass;
  rpcExcerpt?: string;
}

interface CanaryResult {
  schemaVersion: 1;
  status: "passed" | "failed";
  network: "unverified" | "testnet";
  contractId: string | null;
  tokenId: string | null;
  attribution: {
    commit: string | null;
    actor: string | null;
    repository: string | null;
    runUrl: string | null;
    event: string | null;
  };
  startedAt: string;
  completedAt?: string;
  steps: CanaryStep[];
  failure?: {
    step: string;
    failureClass: FailureClass;
    rpcExcerpt: string;
    transactionXdr?: string;
    operationXdr?: string;
  };
  cleanupFailure?: {
    step: string;
    failureClass: FailureClass;
    rpcExcerpt: string;
    transactionXdr?: string;
    operationXdr?: string;
  };
}

class CanaryFailure extends Error {
  readonly failureClass: FailureClass;
  readonly step: string;
  readonly transactionXdr?: string;
  readonly operationXdr?: string;

  constructor(
    message: string,
    failureClass: FailureClass,
    step: string,
    transactionXdr?: string,
    operationXdr?: string
  ) {
    super(message);
    this.failureClass = failureClass;
    this.step = step;
    this.transactionXdr = transactionXdr;
    this.operationXdr = operationXdr;
  }
}

function excerpt(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 1600);
}

function attribution() {
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY ?? null;
  const runId = process.env.GITHUB_RUN_ID;
  return {
    commit: process.env.GITHUB_SHA ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
    repository,
    runUrl: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  };
}

function newResult(contractId: string | null, tokenId: string | null): CanaryResult {
  return {
    schemaVersion: 1,
    status: "failed",
    network: "unverified",
    contractId,
    tokenId,
    attribution: attribution(),
    startedAt: new Date().toISOString(),
    steps: [],
  };
}

function persist(result: CanaryResult): void {
  result.completedAt = new Date().toISOString();
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

function addFailure(result: CanaryResult, failure: CanaryFailure): void {
  const rpcExcerpt = excerpt(failure);
  result.failure = {
    step: failure.step,
    failureClass: failure.failureClass,
    rpcExcerpt,
    ...(failure.transactionXdr ? { transactionXdr: failure.transactionXdr } : {}),
    ...(failure.operationXdr ? { operationXdr: failure.operationXdr } : {}),
  };
  result.steps.push({
    name: failure.step,
    status: "failed",
    failureClass: failure.failureClass,
    rpcExcerpt,
    ...(failure.transactionXdr ? { transactionXdr: failure.transactionXdr } : {}),
    ...(failure.operationXdr ? { operationXdr: failure.operationXdr } : {}),
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new CanaryFailure(`${name} is required`, "configuration", "configuration");
  return value;
}

function configurationFailure(message: string): CanaryFailure {
  return new CanaryFailure(message, "configuration", "configuration");
}

export function validateTestnetRpcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationFailure("STREAMPAY_CANARY_RPC_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw configurationFailure(
      "STREAMPAY_CANARY_RPC_URL must be an HTTPS URL without credentials or a fragment"
    );
  }
  return url.toString();
}

export function validateTestnetFriendbotUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationFailure(
      "STREAMPAY_CANARY_FRIENDBOT_URL must be https://friendbot.stellar.org/"
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "friendbot.stellar.org" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw configurationFailure(
      "STREAMPAY_CANARY_FRIENDBOT_URL must be https://friendbot.stellar.org/"
    );
  }
  return url.origin;
}

export function verifyTestnetPassphrase(passphrase: string): "testnet" {
  if (passphrase !== Networks.TESTNET) {
    throw configurationFailure(
      "Soroban RPC did not report the Stellar testnet network; refusing to run"
    );
  }
  return "testnet";
}

export function createSenderKeypair(secretKey?: string): Keypair {
  const secret = secretKey?.trim();
  if (!secret) return Keypair.random();
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw configurationFailure("STREAMPAY_CANARY_SECRET_KEY is not a valid Stellar secret key");
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitUntil(epochSeconds: bigint): Promise<void> {
  const delay = Number(epochSeconds - BigInt(Math.floor(Date.now() / 1000))) * 1000;
  if (delay > 0) await wait(delay);
}

function buildTransaction(account: Account, operation: xdr.Operation): Transaction {
  return new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
}

async function fundAccount(
  result: CanaryResult,
  server: rpc.Server,
  publicKey: string,
  stepName: string,
  friendbotUrl: string
): Promise<void> {
  try {
    await server.getAccount(publicKey);
    result.steps.push({ name: stepName, status: "passed", result: "account already funded" });
    return;
  } catch {
    // First-run accounts are expected to be absent; verify again after Friendbot.
  }

  let response: Response;
  try {
    response = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`);
  } catch (error) {
    throw new CanaryFailure(
      `Friendbot request failed: ${excerpt(error)}`,
      "funding",
      stepName
    );
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1200);
    try {
      await server.getAccount(publicKey);
      result.steps.push({ name: stepName, status: "passed", result: "account already funded" });
      return;
    } catch {
      throw new CanaryFailure(
        `Friendbot returned HTTP ${response.status}: ${body}`,
        "funding",
        stepName
      );
    }
  }
  try {
    await server.getAccount(publicKey);
    result.steps.push({ name: stepName, status: "passed", result: "funded by Friendbot" });
  } catch (error) {
    throw new CanaryFailure(
      `Friendbot succeeded but account is unavailable through Soroban RPC: ${excerpt(error)}`,
      "funding",
      stepName
    );
  }
}

export function deriveRecipientKeypair(sender: Keypair): Keypair {
  const seed = createHash("sha256")
    .update(sender.rawSecretKey())
    .update("streampay-testnet-canary-recipient-v1")
    .digest();
  return Keypair.fromRawEd25519Seed(seed);
}

async function transact(
  result: CanaryResult,
  server: rpc.Server,
  keypair: Keypair,
  stepName: string,
  operation: xdr.Operation
): Promise<string> {
  const operationXdr = operation.toXDR("base64");
  let tx: Transaction;
  try {
    const account = await server.getAccount(keypair.publicKey());
    tx = buildTransaction(account, operation);
  } catch (error) {
    throw new CanaryFailure(
      `Could not build transaction: ${excerpt(error)}`,
      "simulation",
      stepName,
      undefined,
      operationXdr
    );
  }
  let transactionXdr = tx.toXDR();

  let simulation: Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;
  try {
    simulation = await server.simulateTransaction(tx);
  } catch (error) {
    throw new CanaryFailure(
      `Soroban simulation RPC failed: ${excerpt(error)}`,
      "simulation",
      stepName,
      transactionXdr,
      operationXdr
    );
  }
  if (rpc.Api.isSimulationError(simulation)) {
    throw new CanaryFailure(
      `Soroban simulation rejected the operation: ${simulation.error}`,
      "simulation",
      stepName,
      transactionXdr,
      operationXdr
    );
  }

  const prepared = rpc.assembleTransaction(tx, simulation).build();
  transactionXdr = prepared.toXDR();
  prepared.sign(keypair);
  let sent: Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
  try {
    sent = await server.sendTransaction(prepared);
  } catch (error) {
    throw new CanaryFailure(
      `Soroban submission RPC failed: ${excerpt(error)}`,
      "submission",
      stepName,
      transactionXdr,
      operationXdr
    );
  }
  if (sent.status === "ERROR") {
    throw new CanaryFailure(
      `Soroban submission returned ERROR: ${JSON.stringify(sent.errorResult)}`,
      "submission",
      stepName,
      transactionXdr,
      operationXdr
    );
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(1500);
    let transaction: Awaited<ReturnType<rpc.Server["getTransaction"]>>;
    try {
      transaction = await server.getTransaction(sent.hash);
    } catch (error) {
      throw new CanaryFailure(
        `Could not poll transaction ${sent.hash}: ${excerpt(error)}`,
        "submission",
        stepName,
        transactionXdr,
        operationXdr
      );
    }
    if (transaction.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new CanaryFailure(
        `Transaction ${sent.hash} failed: ${String(transaction.resultXdr ?? "no result XDR")}`,
        "submission",
        stepName,
        transactionXdr,
        operationXdr
      );
    }
    if (transaction.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const returnValue =
        "returnValue" in transaction && transaction.returnValue
          ? String(scValToNative(transaction.returnValue))
          : undefined;
      result.steps.push({
        name: stepName,
        status: "passed",
        transactionHash: sent.hash,
        ...(returnValue ? { result: returnValue } : {}),
        transactionXdr,
        operationXdr,
      });
      return returnValue ?? "";
    }
  }
  throw new CanaryFailure(
    `Timed out waiting for transaction ${sent.hash} inclusion`,
    "submission",
    stepName,
    transactionXdr,
    operationXdr
  );
}

async function readAvailable(
  result: CanaryResult,
  server: rpc.Server,
  contractId: string,
  streamId: bigint,
  stepName: string
): Promise<bigint> {
  const operation = new Contract(contractId).call("available", u64(streamId));
  const operationXdr = operation.toXDR("base64");
  let transaction: Transaction;
  try {
    transaction = buildTransaction(DUMMY_SOURCE, operation);
  } catch (error) {
    throw new CanaryFailure(
      `Could not build read call: ${excerpt(error)}`,
      "simulation",
      stepName,
      undefined,
      operationXdr
    );
  }
  try {
    const simulation = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new CanaryFailure(
        `Read simulation rejected the call: ${simulation.error}`,
        "simulation",
        stepName,
        transaction.toXDR(),
        operationXdr
      );
    }
    if (!simulation.result?.retval) {
      throw new CanaryFailure(
        "Read simulation returned no available balance",
        "simulation",
        stepName,
        transaction.toXDR(),
        operationXdr
      );
    }
    const available = BigInt(scValToNative(simulation.result.retval) as bigint);
    result.steps.push({
      name: stepName,
      status: "passed",
      result: available.toString(),
      transactionXdr: transaction.toXDR(),
      operationXdr,
    });
    return available;
  } catch (error) {
    if (error instanceof CanaryFailure) throw error;
    throw new CanaryFailure(
      `Read simulation RPC failed: ${excerpt(error)}`,
      "simulation",
      stepName,
      transaction.toXDR(),
      operationXdr
    );
  }
}

function forcedFailure(result: CanaryResult, contractId: string, tokenId: string): void {
  const operation = buildCreateStreamOperation(
    contractId,
    FIXTURE_SENDER,
    FIXTURE_RECIPIENT,
    tokenId,
    "1000000",
    1_800_000_000n,
    1_800_000_300n,
    true
  );
  addFailure(
    result,
    new CanaryFailure(
      "Forced simulation failure requested by workflow_dispatch; no network request or transaction was made.",
      "simulation",
      "forced failure: create stream simulation",
      undefined,
      operation.toXDR("base64")
    )
  );
  persist(result);
}

export async function runCanary(): Promise<void> {
  const contractId = process.env.STREAMPAY_CANARY_CONTRACT_ID?.trim() || null;
  const tokenId = process.env.STREAMPAY_CANARY_TOKEN_ID?.trim() || DEFAULT_NATIVE_TOKEN;
  const result = newResult(contractId, tokenId);
  let server: rpc.Server | undefined;
  let keypair: Keypair | undefined;
  let streamId: bigint | undefined;
  let streamCancelled = false;

  try {
    if (process.env.STREAMPAY_CANARY_FORCE_FAILURE === "1") {
      result.contractId ??= FIXTURE_CONTRACT;
      forcedFailure(result, result.contractId, tokenId);
      return;
    }

    const configuredContract = required("STREAMPAY_CANARY_CONTRACT_ID");
    if (!/^C[A-Z2-7]{55}$/.test(configuredContract)) {
      throw configurationFailure(
        "STREAMPAY_CANARY_CONTRACT_ID must be a C-prefixed Stellar contract id"
      );
    }
    result.contractId = configuredContract;

    const configuredToken = process.env.STREAMPAY_CANARY_TOKEN_ID?.trim();
    if (configuredToken && !/^C[A-Z2-7]{55}$/.test(configuredToken)) {
      throw configurationFailure(
        "STREAMPAY_CANARY_TOKEN_ID must be a C-prefixed Stellar contract id"
      );
    }
    const secret = process.env.STREAMPAY_CANARY_SECRET_KEY;
    keypair = createSenderKeypair(secret);

    const rpcUrl = validateTestnetRpcUrl(
      process.env.STREAMPAY_CANARY_RPC_URL?.trim() || DEFAULT_RPC_URL
    );
    const friendbotUrl = validateTestnetFriendbotUrl(
      process.env.STREAMPAY_CANARY_FRIENDBOT_URL?.trim() || DEFAULT_FRIENDBOT_URL
    );
    server = new rpc.Server(rpcUrl);
    try {
      result.network = verifyTestnetPassphrase((await server.getNetwork()).passphrase);
    } catch (error) {
      if (error instanceof CanaryFailure) throw error;
      throw new CanaryFailure(
        `Could not verify Soroban RPC network: ${excerpt(error)}`,
        "configuration",
        "configuration"
      );
    }
    await fundAccount(
      result,
      server,
      keypair.publicKey(),
      "fund sender with testnet Friendbot",
      friendbotUrl
    );

    const recipient = deriveRecipientKeypair(keypair);
    await fundAccount(
      result,
      server,
      recipient.publicKey(),
      "fund recipient with testnet Friendbot",
      friendbotUrl
    );

    const expirationLedger = (await server.getLatestLedger()).sequence + 10_000;
    const approve = new Contract(tokenId).call(
      "approve",
      scAddr(keypair.publicKey()),
      scAddr(configuredContract),
      i128(DEPOSIT.toString()),
      u32(expirationLedger)
    );
    await transact(result, server, keypair, "approve token deposit", approve);

    const startTime = BigInt(Math.floor(Date.now() / 1000)) + START_DELAY_SECONDS;
    const create = buildCreateStreamOperation(
      configuredContract,
      keypair.publicKey(),
      recipient.publicKey(),
      tokenId,
      DEPOSIT.toString(),
      startTime,
      startTime + STREAM_DURATION_SECONDS,
      true
    );
    const createdStreamId = BigInt(
      await transact(result, server, keypair, "create stream", create)
    );
    if (createdStreamId <= 0n) {
      throw new CanaryFailure(
        "create_stream returned an invalid stream id",
        "submission",
        "create stream",
        undefined,
        create.toXDR("base64")
      );
    }
    streamId = createdStreamId;

    await waitUntil(startTime + 20n);
    const available = await readAvailable(
      result,
      server,
      configuredContract,
      createdStreamId,
      "read accrued balance before partial claim"
    );
    if (available < 2n) {
      throw new CanaryFailure(
        `Expected at least 2 token units to claim, found ${available}`,
        "simulation",
        "read accrued balance before partial claim"
      );
    }
    const partialAmount = (available / 2n).toString();
    await transact(
      result,
      server,
      recipient,
      "claim partial amount",
      buildWithdrawOperation(configuredContract, createdStreamId.toString(), partialAmount)
    );

    await wait(15_000);
    const claimedMax = await transact(
      result,
      server,
      recipient,
      "claim maximum accrued amount",
      buildWithdrawMaxOperation(configuredContract, createdStreamId.toString())
    );
    if (BigInt(claimedMax) <= 0n) {
      throw new CanaryFailure(
        `withdraw_max returned a non-positive amount: ${claimedMax}`,
        "submission",
        "claim maximum accrued amount"
      );
    }

    await transact(
      result,
      server,
      keypair,
      "cancel stream",
      buildCancelStreamOperation(configuredContract, keypair.publicKey(), createdStreamId.toString())
    );
    streamCancelled = true;
    result.status = "passed";
    persist(result);
  } catch (error) {
    const failure = error instanceof CanaryFailure
      ? error
      : new CanaryFailure(excerpt(error), "configuration", "canary setup");
    addFailure(result, failure);
    if (streamId !== undefined && !streamCancelled && server && keypair && result.contractId) {
      try {
        await transact(
          result,
          server,
          keypair,
          "cleanup: cancel stream",
          buildCancelStreamOperation(result.contractId, keypair.publicKey(), streamId.toString())
        );
      } catch (cleanupError) {
        const cleanupFailure = cleanupError instanceof CanaryFailure
          ? cleanupError
          : new CanaryFailure(excerpt(cleanupError), "submission", "cleanup: cancel stream");
        result.cleanupFailure = {
          step: cleanupFailure.step,
          failureClass: cleanupFailure.failureClass,
          rpcExcerpt: excerpt(cleanupFailure),
          ...(cleanupFailure.transactionXdr ? { transactionXdr: cleanupFailure.transactionXdr } : {}),
          ...(cleanupFailure.operationXdr ? { operationXdr: cleanupFailure.operationXdr } : {}),
        };
        result.steps.push({
          name: cleanupFailure.step,
          status: "failed",
          failureClass: cleanupFailure.failureClass,
          rpcExcerpt: excerpt(cleanupFailure),
          ...(cleanupFailure.transactionXdr ? { transactionXdr: cleanupFailure.transactionXdr } : {}),
          ...(cleanupFailure.operationXdr ? { operationXdr: cleanupFailure.operationXdr } : {}),
        });
      }
    }
    persist(result);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCanary();
  const result = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as CanaryResult;
  if (result.status !== "passed") {
    console.error(`Canary failed at "${result.failure?.step}": ${result.failure?.rpcExcerpt}`);
    process.exitCode = 1;
  } else {
    console.log(`Canary passed through all ${result.steps.length} recorded steps.`);
  }
}
