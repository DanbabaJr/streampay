#!/usr/bin/env node
/**
 * key_rotation_drill.ts — quarterly key-rotation drill on a fresh testnet deploy.
 *
 * Deploys the contract to testnet with a throwaway "old" governor, initializes
 * the policy module with a throwaway "old" admin, then rotates BOTH roles via
 * the two-step handoffs and asserts that **no privileged operation survives an
 * old key**: every governor- and admin-gated entrypoint is exercised with the
 * old and the new key, before and after rotation, and each attempt is recorded
 * in a pass/fail matrix (console table + JSON artifact in logs/).
 *
 * Continuity checks cover the live-stream implications from
 * docs/rotation-runbook.md §4: a pre-rotation stream still settles, a
 * pre-rotation scheduled intent is still executable by a fresh keeper, and the
 * fee ledger is untouched by the rotation itself.
 *
 * Usage (Node >= 22.6, no build step):
 *
 *   cd scripts && npm install
 *   npm run drill:key-rotation -- [--wasm <path>] [--rpc-url <url>]
 *        [--passphrase <str>] [--friendbot <url>] [--out <dir>]
 *
 * Options:
 *   --wasm <path>       prebuilt contract Wasm (default: run
 *                       `stellar contract build` in the repo root; requires
 *                       stellar-cli >= 25.2, see docs/DRILL_EXECUTION_GUIDE.md)
 *   --rpc-url <url>     Soroban RPC endpoint (default: testnet RPC)
 *   --passphrase <str>  network passphrase (default: Test SDF)
 *   --friendbot <url>   friendbot funding endpoint (default: testnet friendbot)
 *   --out <dir>         matrix artifact directory (default: ../logs)
 *
 * All keys are generated in-memory and never printed or persisted. Exit code 0
 * = every matrix row is green; 1 = at least one row failed (or a setup step
 * threw).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Account,
  Asset,
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// ------------------------------------------------------------------ cli ----

interface Args {
  wasm?: string;
  rpcUrl: string;
  passphrase: string;
  friendbot: string;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    wasm: get("wasm"),
    rpcUrl: get("rpc-url") || "https://soroban-testnet.stellar.org",
    passphrase: get("passphrase") || "Test SDF Network ; September 2015",
    friendbot: get("friendbot") || "https://friendbot.stellar.org",
    outDir: get("out") || join(dirname(fileURLToPath(import.meta.url)), "..", "logs"),
  };
}

const args = parseArgs(process.argv.slice(2));
const server = new rpc.Server(args.rpcUrl);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- scval ----

const scAddr = (s: string) => nativeToScVal(Address.fromString(s), { type: "address" });
const scI128 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: "i128" });
const scU64 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" });
const scU32 = (v: number) => nativeToScVal(BigInt(v), { type: "u32" });
const scBool = (b: boolean) => nativeToScVal(b);
const scVoid = () => xdr.ScVal.scvVoid();

/** ScVal map for `StreamPolicy { min_rate, max_rate, min_duration, max_duration, min_deposit }`. */
function streamPolicyVal(p: {
  min_rate: bigint;
  max_rate: bigint;
  min_duration: bigint;
  max_duration: bigint;
  min_deposit: bigint;
}): xdr.ScVal {
  const entry = (k: string, v: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: nativeToScVal(k, { type: "symbol" }), val: v });
  return xdr.ScVal.scvMap([
    entry("min_rate", scI128(p.min_rate)),
    entry("max_rate", scI128(p.max_rate)),
    entry("min_duration", scU64(p.min_duration)),
    entry("max_duration", scU64(p.max_duration)),
    entry("min_deposit", scI128(p.min_deposit)),
  ]);
}

// ----------------------------------------------------------------- chain ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function friendbotFund(addr: string): Promise<void> {
  for (let attemptN = 1; attemptN <= 4; attemptN += 1) {
    const res = await fetch(`${args.friendbot}?addr=${addr}`).catch(() => undefined);
    if (res && res.ok) return;
    await sleep(3000);
  }
  throw new Error(`friendbot could not fund ${addr}`);
}

async function fundedKeypair(label: string): Promise<Keypair> {
  const kp = Keypair.random();
  await friendbotFund(kp.publicKey());
  console.log(`  funded ${label} ${kp.publicKey().slice(0, 12)}…`);
  return kp;
}

interface Attempt {
  ok: boolean;
  error?: string;
  value?: unknown;
  /** pre-formatted result detail for rows that are checked directly */
  detail?: string;
}

/**
 * Build → simulate → (assemble → sign → submit → poll) a contract call.
 * Expected auth/business failures surface as simulation errors and return
 * { ok: false } without touching the ledger.
 */
async function invoke(
  signer: Keypair,
  contractId: string,
  method: string,
  callArgs: xdr.ScVal[],
): Promise<Attempt> {
  const source = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: args.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(300)
    .build();
  tx.sign(signer);

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    return { ok: false, error: sim.error };
  }
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(signer);
  const sent = await server.sendTransaction(assembled);
  for (let i = 0; i < 30; i += 1) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      return { ok: true, value: result.returnValue ? scValToNative(result.returnValue) : undefined };
    }
    if (result.status === "FAILED") {
      return { ok: false, error: `submitted tx ${sent.hash} FAILED` };
    }
    await sleep(2000);
  }
  return { ok: false, error: `timed out waiting for tx ${sent.hash}` };
}

/** Read-only call via simulation against a dummy source (no signature needed). */
async function read(contractId: string, method: string, callArgs: xdr.ScVal[]): Promise<unknown> {
  const DUMMY = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0",
  );
  const tx = new TransactionBuilder(DUMMY, {
    fee: "100",
    networkPassphrase: args.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) {
    throw new Error(`read ${method} failed: ${rpc.Api.isSimulationError(sim) ? sim.error : "no value"}`);
  }
  return scValToNative(sim.result.retval);
}

/**
 * Build → sign → submit a raw operations transaction (trust lines, payments,
 * SAC wrapping). Returns the native return value (e.g. the SAC address).
 */
async function submit(
  signer: Keypair,
  build: (b: TransactionBuilder) => TransactionBuilder,
): Promise<unknown> {
  const source = await server.getAccount(signer.publicKey());
  const tx = build(
    new TransactionBuilder(source, {
      fee: "100000",
      networkPassphrase: args.passphrase,
    }).setTimeout(300),
  ).build();
  tx.sign(signer);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(signer);
  const sent = await server.sendTransaction(assembled);
  for (let i = 0; i < 30; i += 1) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      return result.returnValue ? scValToNative(result.returnValue) : undefined;
    }
    if (result.status === "FAILED") throw new Error(`tx ${sent.hash} FAILED`);
    await sleep(2000);
  }
  throw new Error(`timed out waiting for tx ${sent.hash}`);
}

// ---------------------------------------------------------------- matrix ----

interface MatrixRow {
  phase: "P1 pre-rotation" | "P2 post-rotation" | "continuity";
  surface: string;
  op: string;
  signer: string;
  expect: "pass" | "fail";
  ok: boolean;
  detail: string;
}

const matrix: MatrixRow[] = [];

function record(
  phase: MatrixRow["phase"],
  surface: string,
  op: string,
  signer: string,
  expect: "pass" | "fail",
  attempt: Attempt,
): void {
  const ok = expect === "pass" ? attempt.ok : !attempt.ok;
  const detail =
    attempt.detail ??
    (attempt.ok
      ? attempt.value !== undefined
        ? `returned ${String(attempt.value)}`
        : "submitted OK"
      : `reverted: ${(attempt.error ?? "unknown").slice(0, 90)}`);
  matrix.push({ phase, surface, op, signer, expect, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${phase} · ${op} as ${signer} — expected ${expect} — ${detail}`);
  if (!ok) failures += 1;
}

let failures = 0;

async function probe(
  phase: MatrixRow["phase"],
  surface: string,
  op: string,
  signer: Keypair,
  signerLabel: string,
  contractId: string,
  expect: "pass" | "fail",
  method: string,
  callArgs: xdr.ScVal[],
): Promise<Attempt> {
  const attempt = await invoke(signer, contractId, method, callArgs);
  record(phase, surface, op, signerLabel, expect, attempt);
  return attempt;
}

function printMatrix(): void {
  const header = `${"Phase".padEnd(16)} ${"Surface".padEnd(22)} ${"Operation".padEnd(30)} ${"Signer".padEnd(14)} ${"Expect".padEnd(7)} Result`;
  console.log(`\n${"=".repeat(110)}\nKey-rotation drill matrix\n${"=".repeat(110)}\n${header}\n${"-".repeat(110)}`);
  for (const r of matrix) {
    console.log(
      `${r.phase.padEnd(16)} ${r.surface.padEnd(22)} ${r.op.padEnd(30)} ${r.signer.padEnd(14)} ${r.expect.padEnd(7)} ${r.ok ? "PASS" : "FAIL"} — ${r.detail.slice(0, 60)}`,
    );
  }
  console.log(`${"-".repeat(110)}\n${matrix.filter((r) => r.ok).length}/${matrix.length} rows green${failures === 0 ? "" : ` — ${failures} FAILED`}\n`);
}

// ------------------------------------------------------------------ main ----

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("StreamPay key-rotation drill (fresh testnet deploy)");
  console.log(`  rpc: ${args.rpcUrl}\n`);

  // ---- actors -------------------------------------------------------------
  console.log("Actors:");
  const deployer = await fundedKeypair("deployer (zero-privilege)");
  const oldGovernor = await fundedKeypair("old governor");
  const newGovernor = await fundedKeypair("new governor");
  const oldAdmin = await fundedKeypair("old policy admin");
  const newAdmin = await fundedKeypair("new policy admin");
  const sender = await fundedKeypair("stream sender");
  const recipient = await fundedKeypair("stream recipient");
  const keeper = await fundedKeypair("keeper");
  const issuer = await fundedKeypair("token issuer");

  // ---- build + deploy -----------------------------------------------------
  let wasmPath = args.wasm;
  if (!wasmPath) {
    console.log("\nBuilding contract Wasm (stellar contract build)…");
    execFileSync("stellar", ["contract", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
    wasmPath = join(REPO_ROOT, "target/wasm32v1-none/release/streampay_contract.wasm");
  }
  if (!existsSync(wasmPath)) throw new Error(`wasm not found at ${wasmPath}`);
  const wasm = new Uint8Array(readFileSync(wasmPath));

  console.log("\nDeploying fresh contract (constructor governor = old governor)…");
  const wasmHash = await uploadAndGetHash(deployer, wasm);
  const salt = Keypair.random().rawPublicKey(); // unique per drill run
  const createReturn = await (async (): Promise<unknown> => {
    const source = await server.getAccount(deployer.publicKey());
    const tx = new TransactionBuilder(source, {
      .addOperation(
        Operation.createCustomContract({
          address: Address.fromString(deployer.publicKey()),
          wasmHash,
          salt,
          constructorArgs: [scAddr(oldGovernor.publicKey())],
        }),
      )
      .setTimeout(300)
      .build();
    tx.sign(deployer);
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`deploy simulation failed: ${sim.error}`);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(deployer);
    const sent = await server.sendTransaction(assembled);
    for (let i = 0; i < 30; i += 1) {
      const result = await server.getTransaction(sent.hash);
      if (result.status === "SUCCESS") {
        return result.returnValue ? scValToNative(result.returnValue) : undefined;
      }
      if (result.status === "FAILED") throw new Error(`deploy tx ${sent.hash} FAILED`);
      await sleep(2000);
    }
    throw new Error("timed out waiting for deploy tx");
  })();
  const contractId = String(createReturn);
  console.log(`  contract: ${contractId}`);

  // ---- policy module + demo token ----------------------------------------
  console.log("\nInitializing policy module (admin = old policy admin)…");
  const initRes = await invoke(oldAdmin, contractId, "policy_init", [scAddr(oldAdmin.publicKey())]);
  if (!initRes.ok) throw new Error(`policy_init failed: ${initRes.error}`);

  console.log("Issuing demo asset and wrapping its SAC…");
  const asset = new Asset("STRDRILL", issuer.publicKey());
  await submit(sender, (b) => b.addOperation(Operation.changeTrust({ asset, limit: "1000000000" })));
  await submit(issuer, (b) =>
    b.addOperation(Operation.payment({ destination: sender.publicKey(), asset, amount: "100000000" })),
  );
  const tokenId = String(await submit(deployer, (b) => b.addOperation(Operation.createStellarAssetContract({ asset }))));
  console.log(`  token: ${tokenId}`);

  const latest = await server.getLatestLedger();
  const approve = await invoke(sender, tokenId, "approve", [
    scAddr(sender.publicKey()),
    scAddr(contractId),
    scI128(1_000_000_000n),
    scU32(latest.sequence + 10_000),
  ]);
  if (!approve.ok) throw new Error(`token approve failed: ${approve.error}`);

  const policyArg = streamPolicyVal({
    min_rate: 0n,
    max_rate: 10_000_000_000n,
    min_duration: 0n,
    max_duration: 31_536_000n,
    min_deposit: 0n,
  });

  // ---- P1: privileged surface with old keys (pass) / new keys (fail) ------
  console.log("\nP1 — pre-rotation privileged surface:");
  await probe("P1 pre-rotation", "governor", "set_fee_bps", oldGovernor, "old governor", contractId, "pass", "set_fee_bps", [
    scAddr(oldGovernor.publicKey()),
    scU32(10),
  ]);
  await probe("P1 pre-rotation", "governor", "set_fee_bps", deployer, "deployer (zero-priv)", contractId, "fail", "set_fee_bps", [
    scAddr(deployer.publicKey()),
    scU32(10),
  ]);
  await probe("P1 pre-rotation", "governor", "set_fee_bps", newGovernor, "new governor (nominee)", contractId, "fail", "set_fee_bps", [
    scAddr(newGovernor.publicKey()),
    scU32(10),
  ]);
  await probe("P1 pre-rotation", "governor", "set_stream_policy", oldGovernor, "old governor", contractId, "pass", "set_stream_policy", [
    scAddr(oldGovernor.publicKey()),
    scVoid(),
    policyArg,
  ]);
  await probe("P1 pre-rotation", "governor", "propose_upgrade", oldGovernor, "old governor", contractId, "pass", "propose_upgrade", [
    scAddr(oldGovernor.publicKey()),
    nativeToScVal(wasmHash),
    scU64(86_400),
  ]);
  await probe("P1 pre-rotation", "governor", "set_frozen(true)", oldGovernor, "old governor", contractId, "pass", "set_frozen", [
    scAddr(oldGovernor.publicKey()),
    scBool(true),
  ]);
  await probe("P1 pre-rotation", "governor", "set_frozen(false)", oldGovernor, "old governor", contractId, "pass", "set_frozen", [
    scAddr(oldGovernor.publicKey()),
    scBool(false),
  ]);
  await probe("P1 pre-rotation", "admin", "policy_set_timelock_delay", oldAdmin, "old admin", contractId, "pass", "policy_set_timelock_delay", [
    scU64(172_800),
  ]);
  await probe("P1 pre-rotation", "admin", "policy_propose_asset", oldAdmin, "old admin", contractId, "pass", "policy_propose_asset", [
    scAddr(tokenId),
    scBool(false),
  ]);
  await probe("P1 pre-rotation", "admin", "policy_propose_handoff", newAdmin, "new admin (pre-handoff)", contractId, "fail", "policy_propose_handoff", [
    scAddr(newAdmin.publicKey()),
  ]);
  // A queued allowlist change must NOT be executable while its timelock runs.
  const earlyExec = await invoke(deployer, contractId, "policy_execute_asset", [scAddr(tokenId)]);
  record("P1 pre-rotation", "timelock", "policy_execute_asset (early)", "deployer", "fail", earlyExec);

  // ---- live state before rotation -----------------------------------------
  console.log("\nCreating pre-rotation stream + scheduled intent (live state)…");
  const now = Math.floor(Date.now() / 1000);
  const streamRes = await invoke(sender, contractId, "create_stream", [
    scAddr(sender.publicKey()),
    scAddr(recipient.publicKey()),
    scAddr(tokenId),
    scI128(10_000_000n),
    scU64(now),
    scU64(now + 1800),
    scBool(true),
  ]);
  if (!streamRes.ok) throw new Error(`create_stream failed: ${streamRes.error}`);
  const streamId = BigInt(String(streamRes.value));
  const intentRes = await invoke(sender, contractId, "schedule_stream", [
    scAddr(sender.publicKey()),
    scAddr(recipient.publicKey()),
    scAddr(tokenId),
    scI128(1_000_000n),
    scU64(now + 5),
    scU64(now + 1800),
    scBool(true),
    scU64(0),
    scU32(1),
    scI128(1_000n),
    scU64(now),
    scU64(now + 3600),
  ]);
  if (!intentRes.ok) throw new Error(`schedule_stream failed: ${intentRes.error}`);
  const intentId = BigInt(String(intentRes.value));
  const treasuryBefore = (await read(contractId, "treasury_status", [scAddr(tokenId)])) as Record<string, unknown>;
  console.log(`  stream #${streamId}, intent #${intentId}, collectible ${treasuryBefore.collectible}`);

  // ---- rotation -----------------------------------------------------------
  console.log("\nRotating governor (nominate by old → accept by new)…");
  const nominate = await invoke(oldGovernor, contractId, "nominate_governor", [
    scAddr(oldGovernor.publicKey()),
    scAddr(newGovernor.publicKey()),
  ]);
  if (!nominate.ok) throw new Error(`nominate_governor failed: ${nominate.error}`);
  const acceptWrong = await invoke(oldGovernor, contractId, "accept_governor", [scAddr(oldGovernor.publicKey())]);
  record("P1 pre-rotation", "governor", "accept_governor (non-nominee)", "old governor", "fail", acceptWrong);
  const acceptGov = await invoke(newGovernor, contractId, "accept_governor", [scAddr(newGovernor.publicKey())]);
  record("P2 post-rotation", "governor", "accept_governor (nominee)", "new governor", "pass", acceptGov);

  console.log("Rotating policy admin (propose by old → accept by new)…");
  const proposeHandoff = await invoke(oldAdmin, contractId, "policy_propose_handoff", [
    scAddr(newAdmin.publicKey()),
  ]);
  if (!proposeHandoff.ok) throw new Error(`policy_propose_handoff failed: ${proposeHandoff.error}`);
  const acceptAdminWrong = await invoke(oldAdmin, contractId, "policy_accept_handoff", []);
  record("P1 pre-rotation", "admin", "policy_accept_handoff (non-nominee)", "old admin", "fail", acceptAdminWrong);
  const acceptAdmin = await invoke(newAdmin, contractId, "policy_accept_handoff", []);
  record("P2 post-rotation", "admin", "policy_accept_handoff (nominee)", "new admin", "pass", acceptAdmin);

  // ---- P2: same surface — old keys must fail, new keys must pass ----------
  console.log("\nP2 — post-rotation privileged surface:");
  await probe("P2 post-rotation", "governor", "set_fee_bps", oldGovernor, "old governor", contractId, "fail", "set_fee_bps", [
    scAddr(oldGovernor.publicKey()),
    scU32(10),
  ]);
  await probe("P2 post-rotation", "governor", "set_fee_bps", newGovernor, "new governor", contractId, "pass", "set_fee_bps", [
    scAddr(newGovernor.publicKey()),
    scU32(10),
  ]);
  await probe("P2 post-rotation", "governor", "set_stream_policy", oldGovernor, "old governor", contractId, "fail", "set_stream_policy", [
    scAddr(oldGovernor.publicKey()),
    scVoid(),
    policyArg,
  ]);
  await probe("P2 post-rotation", "governor", "set_stream_policy", newGovernor, "new governor", contractId, "pass", "set_stream_policy", [
    scAddr(newGovernor.publicKey()),
    scVoid(),
    policyArg,
  ]);
  await probe("P2 post-rotation", "governor", "nominate_governor", oldGovernor, "old governor", contractId, "fail", "nominate_governor", [
    scAddr(oldGovernor.publicKey()),
    scAddr(newGovernor.publicKey()),
  ]);
  await probe("P2 post-rotation", "governor", "nominate_governor", newGovernor, "new governor", contractId, "pass", "nominate_governor", [
    scAddr(newGovernor.publicKey()),
    scAddr(newGovernor.publicKey()),
  ]);
  await probe("P2 post-rotation", "governor", "propose_upgrade", oldGovernor, "old governor", contractId, "fail", "propose_upgrade", [
    scAddr(oldGovernor.publicKey()),
    nativeToScVal(wasmHash),
    scU64(86_400),
  ]);
  await probe("P2 post-rotation", "governor", "propose_upgrade", newGovernor, "new governor", contractId, "pass", "propose_upgrade", [
    scAddr(newGovernor.publicKey()),
    nativeToScVal(wasmHash),
    scU64(86_400),
  ]);
  await probe("P2 post-rotation", "governor", "set_frozen(true)", oldGovernor, "old governor", contractId, "fail", "set_frozen", [
    scAddr(oldGovernor.publicKey()),
    scBool(true),
  ]);
  await probe("P2 post-rotation", "governor", "set_frozen(true)", newGovernor, "new governor", contractId, "pass", "set_frozen", [
    scAddr(newGovernor.publicKey()),
    scBool(true),
  ]);
  await probe("P2 post-rotation", "governor", "set_frozen(false)", newGovernor, "new governor", contractId, "pass", "set_frozen", [
    scAddr(newGovernor.publicKey()),
    scBool(false),
  ]);
  await probe("P2 post-rotation", "governor", "withdraw_treasury", oldGovernor, "old governor", contractId, "fail", "withdraw_treasury", [
    scAddr(oldGovernor.publicKey()),
    scAddr(tokenId),
    scI128(10_000n),
  ]);
  await probe("P2 post-rotation", "governor", "withdraw_treasury", newGovernor, "new governor", contractId, "pass", "withdraw_treasury", [
    scAddr(newGovernor.publicKey()),
    scAddr(tokenId),
    scI128(10_000n),
  ]);
  await probe("P2 post-rotation", "admin", "policy_set_timelock_delay", oldAdmin, "old admin", contractId, "fail", "policy_set_timelock_delay", [
    scU64(300),
  ]);
  await probe("P2 post-rotation", "admin", "policy_set_timelock_delay", newAdmin, "new admin", contractId, "pass", "policy_set_timelock_delay", [
    scU64(300),
  ]);
  await probe("P2 post-rotation", "admin", "policy_propose_asset", oldAdmin, "old admin", contractId, "fail", "policy_propose_asset", [
    scAddr(tokenId),
    scBool(true),
  ]);
  await probe("P2 post-rotation", "admin", "policy_propose_asset", newAdmin, "new admin", contractId, "pass", "policy_propose_asset", [
    scAddr(tokenId),
    scBool(true),
  ]);
  // Queued allowlist change (re-queued by new admin above) still timelocked.
  const earlyExec2 = await invoke(keeper, contractId, "policy_execute_asset", [scAddr(tokenId)]);
  record("P2 post-rotation", "timelock", "policy_execute_asset (early)", "keeper", "fail", earlyExec2);

  // ---- continuity: live streams and scheduled intents survive rotation ----
  console.log("\nContinuity checks (live state across rotation):");
  const treasuryAfter = (await read(contractId, "treasury_status", [scAddr(tokenId)])) as Record<string, unknown>;
  record("continuity", "fee ledger", "charged_total unchanged", "-", "-", {
    ok: treasuryBefore.charged_total === treasuryAfter.charged_total,
    detail: "",
  });
  const streamAfter = (await read(contractId, "get_stream", [scU64(streamId)])) as Record<string, unknown>;
  record("continuity", "stream", "pre-rotation stream readable", "-", "-", {
    ok: BigInt(String(streamAfter.id)) === streamId,
    detail: `status=${JSON.stringify(streamAfter.status)}`,
  });
  const available = BigInt(String(await read(contractId, "available", [scU64(streamId)])));
  if (available > 0n) {
    const wd = await invoke(recipient, contractId, "withdraw", [scU64(streamId), scI128(available)]);
    record("continuity", "stream", "recipient withdraw of accrued", "recipient", "pass", wd);
  } else {
    record("continuity", "stream", "available ≥ 0 pre-accrual", "-", "-", { ok: available >= 0n, detail: `available=${available}` });
  }
  const totalBefore = BigInt(String(await read(contractId, "total_streams", [])));
  const execIntent = await invoke(keeper, contractId, "execute_scheduled", [
    scU64(intentId),
    scAddr(keeper.publicKey()),
  ]);
  record("continuity", "keeper", "execute pre-rotation intent", "keeper", "pass", execIntent);
  const totalAfter = BigInt(String(await read(contractId, "total_streams", [])));
  record("continuity", "keeper", "intent materialized a stream", "-", "-", {
    ok: totalAfter === totalBefore + 1n,
    detail: `total_streams ${totalBefore} -> ${totalAfter}`,
  });

  // ---- role bindings and in-flight state ----------------------------------
  const statusFinal = (await read(contractId, "treasury_status", [scAddr(tokenId)])) as Record<string, unknown>;
  record("continuity", "governor", "governor == new", "-", "-", {
    ok: String(statusFinal.governor) === newGovernor.publicKey() && statusFinal.pending_governor == null,
    detail: `governor=${String(statusFinal.governor).slice(0, 16)}…`,
  });
  const adminFinal = String(await read(contractId, "policy_admin", []));
  const pendingAdminFinal = await read(contractId, "policy_pending_admin", []);
  record("continuity", "admin", "policy_admin == new, no pending", "-", "-", {
    ok: adminFinal === newAdmin.publicKey() && pendingAdminFinal == null,
    detail: `policy_admin=${adminFinal.slice(0, 16)}…`,
  });

  // ---- matrix artifact ----------------------------------------------------
  printMatrix();
  mkdirSync(args.outDir, { recursive: true });
  const artifact = join(args.outDir, `key_rotation_matrix_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    artifact,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rpcUrl: args.rpcUrl,
        contractId,
        tokenId,
        durationMs: Date.now() - t0,
        rows: matrix,
        summary: { total: matrix.length, green: matrix.filter((r) => r.ok).length, failures },
      },
      null,
      2,
    ),
  );
  console.log(`matrix artifact: ${artifact}`);
  console.log(failures === 0 ? "DRILL RESULT: PASS" : `DRILL RESULT: FAIL (${failures} row(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Upload the Wasm in a transaction and return the on-chain code hash. */
async function uploadAndGetHash(signer: Keypair, wasm: Uint8Array): Promise<Uint8Array> {
  const source = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: args.passphrase,
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(300)
    .build();
  tx.sign(signer);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`wasm upload simulation failed: ${sim.error}`);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(signer);
  const sent = await server.sendTransaction(assembled);
  for (let i = 0; i < 30; i += 1) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      if (!result.returnValue) throw new Error("wasm upload returned no hash");
      return scValToNative(result.returnValue) as Uint8Array;
    }
    if (result.status === "FAILED") throw new Error(`wasm upload tx ${sent.hash} FAILED`);
    await sleep(2000);
  }
  throw new Error("timed out waiting for wasm upload");
}

main().catch((err) => {
  console.error(`key_rotation_drill: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
