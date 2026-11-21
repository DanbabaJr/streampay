import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { renderAlert } from "../alert.mjs";
import {
  createSenderKeypair,
  deriveRecipientKeypair,
  validateTestnetFriendbotUrl,
  validateTestnetRpcUrl,
  verifyTestnetPassphrase,
} from "../runner.ts";

const runnerPath = fileURLToPath(new URL("../runner.ts", import.meta.url));
const packagePath = fileURLToPath(new URL("..", import.meta.url));

test("recipient keypair is stable and distinct from the bot keypair", () => {
  const sender = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
  const first = deriveRecipientKeypair(sender);
  const second = deriveRecipientKeypair(sender);

  assert.equal(first.publicKey(), second.publicKey());
  assert.notEqual(first.publicKey(), sender.publicKey());
});

test("sender keypair is ephemeral unless an optional secret is configured", () => {
  const first = createSenderKeypair();
  const second = createSenderKeypair("  ");
  const configured = Keypair.random();

  assert.notEqual(first.publicKey(), second.publicKey());
  assert.equal(createSenderKeypair(configured.secret()).publicKey(), configured.publicKey());
  assert.throws(() => createSenderKeypair("not-a-secret"), {
    message: "STREAMPAY_CANARY_SECRET_KEY is not a valid Stellar secret key",
  });
});

test("only HTTPS RPC endpoints and the official testnet Friendbot are accepted", () => {
  assert.equal(
    validateTestnetRpcUrl("https://soroban-testnet.stellar.org"),
    "https://soroban-testnet.stellar.org/"
  );
  assert.throws(() => validateTestnetRpcUrl("http://soroban-testnet.stellar.org"));
  assert.equal(
    validateTestnetFriendbotUrl("https://friendbot.stellar.org/"),
    "https://friendbot.stellar.org"
  );
  assert.throws(() => validateTestnetFriendbotUrl("https://friendbot.example.com/"));
});

test("reported network is testnet only after its passphrase is verified", () => {
  assert.equal(
    verifyTestnetPassphrase(
      "Test SDF Network ; September 2015"
    ),
    "testnet"
  );
  assert.throws(() => verifyTestnetPassphrase("Public Global Stellar Network ; September 2015"));
});

test("forced failure writes alert-ready XDR evidence without network access", () => {
  const evidencePath = join(tmpdir(), `streampay-canary-${process.pid}-${Date.now()}.json`);
  try {
    const execution = spawnSync(
      process.execPath,
      ["--experimental-strip-types", runnerPath],
      {
        cwd: packagePath,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          STREAMPAY_CANARY_FORCE_FAILURE: "1",
          STREAMPAY_CANARY_EVIDENCE_PATH: evidencePath,
          GITHUB_SHA: "abc123",
          GITHUB_ACTOR: "canary-test",
          GITHUB_REPOSITORY: "example/streampay",
          GITHUB_RUN_ID: "42",
        },
      }
    );
    assert.equal(execution.status, 1, execution.stderr || execution.stdout);

    const result = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(result.failure.step, "forced failure: create stream simulation");
    assert.equal(result.failure.failureClass, "simulation");
    assert.equal(result.network, "unverified");
    assert.ok(result.failure.operationXdr);
    assert.match(renderAlert(result), /Commit: abc123/);
    assert.match(renderAlert(result), /actions\/runs\/42/);
    assert.match(renderAlert(result), /Operation XDR:/);
  } finally {
    try {
      unlinkSync(evidencePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});

test("the canary and the frontend lock the same @stellar/stellar-sdk build", () => {
  // runner.ts imports the operation builders out of frontend/lib/stellar-ops.ts
  // instead of copying them, and Node resolves a bare specifier from the importing
  // file upwards — so one process ends up holding two installs of the SDK: the
  // canary's own copy for its direct import, and the copy that the frontend module
  // loads for itself. buildTransaction() then hands an xdr.Operation built by one
  // copy to a TransactionBuilder from the other.
  //
  // That is only safe while both trees lock the identical version. Dependabot
  // bumps one tree at a time, and a silent cross-version canary is worse than a
  // red one — it reports the lifecycle as healthy while testing a combination that
  // ships nowhere. Pin the invariant so the drift fails at review time rather than
  // inside a scheduled job nobody is watching.
  const lockedSdkVersion = (lockPath) => {
    const { packages } = JSON.parse(readFileSync(lockPath, "utf8"));
    const entry = Object.entries(packages ?? {}).find(([name]) =>
      name.endsWith("node_modules/@stellar/stellar-sdk")
    );
    assert.ok(entry, `${lockPath} does not lock @stellar/stellar-sdk`);
    return entry[1].version;
  };

  const canaryVersion = lockedSdkVersion(join(packagePath, "package-lock.json"));
  const frontendVersion = lockedSdkVersion(
    resolve(packagePath, "../../frontend/package-lock.json")
  );
  assert.equal(
    canaryVersion,
    frontendVersion,
    `tools/canary locks @stellar/stellar-sdk ${canaryVersion} and frontend locks ${frontendVersion}; the canary executes frontend modules against its own copy, so bump both lockfiles together`
  );
});
