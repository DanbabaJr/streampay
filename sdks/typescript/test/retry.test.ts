import assert from "node:assert/strict";
import { test } from "node:test";

import { Keypair, Networks, SorobanDataBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

import { StreamPayClient, signerFromKeypair } from "../src/client.js";
import { StreamPayError } from "../src/errors.js";
import {
  backoffCeiling,
  backoffDelay,
  isTransientError,
  resolveRetryPolicy,
  retryAfterMs,
  type Clock,
  type RetryAttemptInfo,
} from "../src/retry.js";

// ------------------------------------------------------------------ fixtures

const CONTRACT_ID = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

/** Fake clock: `sleep` advances `now` instantly and records every wait. */
function fakeClock(randomValues: number[] = [0.5]): Clock & { sleeps: number[]; t: number } {
  let i = 0;
  const clock = {
    t: 1_000_000,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
    random: () => randomValues[i++ % randomValues.length]!,
  };
  return clock;
}

function httpError(status: number, headers: Record<string, string> = {}): Error {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    response: { status: number; headers: Record<string, string> };
  };
  error.response = { status, headers };
  return error;
}

function networkError(code = "ECONNRESET"): Error {
  return Object.assign(new Error(`socket ${code}`), { code });
}

type Step<T> = T | Error;

/**
 * Mock transport. Each RPC method replays a script; the last entry repeats.
 * Records every call so tests can assert exactly what was sent.
 */
function mockServer(script: {
  getAccount?: Step<"ok">[];
  simulate?: Step<"ok">[];
  send?: Step<rpc.Api.SendTransactionStatus>[];
  get?: Step<rpc.Api.GetTransactionStatus>[];
}) {
  const calls = { getAccount: 0, simulate: 0, send: [] as string[], get: [] as string[] };
  const next = <T>(steps: Step<T>[] | undefined, index: number, fallback: T): T => {
    if (steps === undefined || steps.length === 0) return fallback;
    const step = steps[Math.min(index, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  };
  const server = {
    async getAccount(accountId: string) {
      next(script.getAccount, calls.getAccount++, "ok");
      const { Account } = await import("@stellar/stellar-sdk");
      return new Account(accountId, "41");
    },
    async simulateTransaction() {
      next(script.simulate, calls.simulate++, "ok");
      return {
        _parsed: true,
        id: "1",
        latestLedger: 100,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100",
        result: { auth: [], retval: xdr.ScVal.scvU32(7) },
      };
    },
    async sendTransaction(tx: { toXDR(): string; hash(): Buffer }) {
      calls.send.push(tx.toXDR());
      const status = next(script.send, calls.send.length - 1, "PENDING" as const);
      return {
        status,
        hash: tx.hash().toString("hex"),
        latestLedger: 100,
        latestLedgerCloseTime: 0,
        ...(status === "ERROR"
          ? { errorResult: { result: () => ({ switch: () => ({ name: "txBadSeq" }) }) } }
          : {}),
      };
    },
    async getTransaction(hash: string) {
      calls.get.push(hash);
      const status = next(script.get, calls.get.length - 1, rpc.Api.GetTransactionStatus.SUCCESS);
      return { status, returnValue: xdr.ScVal.scvU32(9), resultXdr: "AAAA" };
    },
  };
  return { server: server as unknown as rpc.Server, calls };
}

/** Exposes the protected pipeline with a trivial decoder. */
class TestClient extends StreamPayClient {
  invoke(): Promise<number> {
    return this.call("ping", [], true, (value) => Number(scValToNative(value)));
  }
}

function client(server: rpc.Server, clock: Clock, retry?: ConstructorParameters<typeof StreamPayClient>[0]["retry"]) {
  return new TestClient({
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    signer: signerFromKeypair(keypair),
    server,
    clock,
    pollIntervalMs: 10,
    pollTimeoutMs: 100,
    ...(retry === undefined ? {} : { retry }),
  });
}

// ------------------------------------------------------------- pure policy

test("retries are off unless the caller opts in", () => {
  assert.equal(resolveRetryPolicy(undefined).maxAttempts, 1);
  assert.equal(resolveRetryPolicy(false).maxAttempts, 1);
  const defaults = resolveRetryPolicy(true);
  assert.deepEqual(
    { ...defaults },
    { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5000, multiplier: 2, jitter: "full" }
  );
});

test("invalid policies are rejected up front", () => {
  assert.throws(() => resolveRetryPolicy({ maxAttempts: 0 }), RangeError);
  assert.throws(() => resolveRetryPolicy({ maxAttempts: 1.5 }), RangeError);
  assert.throws(() => resolveRetryPolicy({ baseDelayMs: 500, maxDelayMs: 100 }), RangeError);
  assert.throws(() => resolveRetryPolicy({ multiplier: 0.5 }), RangeError);
});

test("backoff grows exponentially up to the cap", () => {
  const policy = resolveRetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000, jitter: "none" });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffCeiling(policy, n)), [100, 200, 400, 800, 1000, 1000]);
});

test("full jitter stays within [0, ceiling] for every random draw", () => {
  const policy = resolveRetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000 });
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const ceiling = backoffCeiling(policy, attempt);
    for (const r of [0, 1e-9, 0.25, 0.5, 0.999999, 1, -1, Number.NaN]) {
      const delay = backoffDelay(policy, attempt, () => r);
      assert.ok(delay >= 0 && delay <= ceiling, `attempt ${attempt} r=${r} delay=${delay}`);
      assert.ok(Number.isInteger(delay));
    }
  }
  assert.equal(backoffDelay(policy, 1, () => 0), 0);
  assert.equal(backoffDelay(policy, 1, () => 0.999999), 100);
});

test("Retry-After raises the floor but never exceeds maxDelayMs", () => {
  const policy = resolveRetryPolicy({ baseDelayMs: 100, maxDelayMs: 2000 });
  assert.equal(backoffDelay(policy, 1, () => 0, 1500), 1500);
  assert.equal(backoffDelay(policy, 1, () => 0, 60_000), 2000);
  assert.equal(retryAfterMs(httpError(429, { "Retry-After": "3" }), 0), 3000);
  const headers = new Headers({ "retry-after": "2" });
  assert.equal(retryAfterMs({ response: { status: 503, headers } }, 0), 2000);
  const at = Date.parse("2026-11-21T10:00:05Z");
  assert.equal(retryAfterMs(httpError(503, { "retry-after": "Sat, 21 Nov 2026 10:00:05 GMT" }), at - 4000), 4000);
  assert.equal(retryAfterMs(new Error("x"), 0), undefined);
});

test("only clearly transient failures are classified as retryable", () => {
  for (const error of [
    httpError(429),
    httpError(408),
    httpError(500),
    httpError(502),
    httpError(503),
    httpError(504),
    networkError("ECONNRESET"),
    networkError("ETIMEDOUT"),
    networkError("EAI_AGAIN"),
    new Error("timeout of 30000ms exceeded"),
    Object.assign(new Error("Timeout"), { name: "TimeoutError" }),
    Object.assign(new TypeError("fetch failed"), { cause: networkError("UND_ERR_SOCKET") }),
  ]) {
    assert.equal(isTransientError(error), true, String((error as Error).message));
  }
  for (const error of [
    httpError(400),
    httpError(401),
    httpError(404),
    httpError(501),
    new Error("HostError: Error(Contract, #10)"),
    new StreamPayError("submission failed", "submission"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    "ECONNRESET",
    null,
  ]) {
    assert.equal(isTransientError(error), false, String(error));
  }
});

// ------------------------------------------------------- client, mocked RPC

test("default client: a transient send failure surfaces immediately, untouched", async () => {
  const boom = httpError(503);
  const { server, calls } = mockServer({ send: [boom] });
  const clock = fakeClock();
  await assert.rejects(client(server, clock).invoke(), (error) => error === boom);
  assert.equal(calls.send.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test("transient failure then success: retries with backoff and resolves", async () => {
  const { server, calls } = mockServer({
    send: [httpError(503), networkError(), "PENDING"],
    get: [rpc.Api.GetTransactionStatus.NOT_FOUND, rpc.Api.GetTransactionStatus.NOT_FOUND, rpc.Api.GetTransactionStatus.SUCCESS],
  });
  const clock = fakeClock([0.5]);
  const seen: RetryAttemptInfo[] = [];
  const result = await client(server, clock, {
    baseDelayMs: 100,
    maxDelayMs: 1000,
    onRetry: (info) => seen.push(info),
  }).invoke();

  assert.equal(result, 9);
  assert.equal(calls.send.length, 3);
  assert.deepEqual(seen.map((s) => [s.stage, s.attempt, s.delayMs]), [
    ["submission", 1, 50],
    ["submission", 2, 100],
  ]);
});

test("every retry resends the byte-identical signed envelope", async () => {
  const { server, calls } = mockServer({
    send: [networkError(), networkError(), "PENDING"],
    get: [rpc.Api.GetTransactionStatus.NOT_FOUND, rpc.Api.GetTransactionStatus.NOT_FOUND, rpc.Api.GetTransactionStatus.SUCCESS],
  });
  await client(server, fakeClock(), { maxAttempts: 3 }).invoke();
  assert.equal(calls.send.length, 3);
  assert.equal(new Set(calls.send).size, 1, "no rebuild, no re-sign, no new sequence number");
});

test("a lost response whose transaction already landed is not resent", async () => {
  const { server, calls } = mockServer({
    send: [networkError("ETIMEDOUT")],
    get: [rpc.Api.GetTransactionStatus.SUCCESS],
  });
  const result = await client(server, fakeClock(), true).invoke();
  assert.equal(result, 9);
  assert.equal(calls.send.length, 1, "idempotency check found the hash; no second send");
});

test("a bad-seq rejection after an unanswered send resolves to our own transaction", async () => {
  const { server, calls } = mockServer({
    send: [networkError(), "ERROR"],
    get: [
      rpc.Api.GetTransactionStatus.NOT_FOUND, // checked before the resend
      rpc.Api.GetTransactionStatus.SUCCESS, // the first send did land after all
    ],
  });
  const result = await client(server, fakeClock(), true).invoke();
  assert.equal(result, 9);
  assert.equal(calls.send.length, 2);
});

test("permanent failure surfaces immediately even with a policy", async () => {
  const { server, calls } = mockServer({ send: ["ERROR"] });
  const clock = fakeClock();
  await assert.rejects(client(server, clock, { maxAttempts: 5 }).invoke(), (error: unknown) => {
    assert.ok(error instanceof StreamPayError);
    assert.equal(error.kind, "submission");
    return true;
  });
  assert.equal(calls.send.length, 1);
  assert.deepEqual(clock.sleeps, []);

  const bad = httpError(400);
  const second = mockServer({ send: [bad] });
  await assert.rejects(client(second.server, fakeClock(), { maxAttempts: 5 }).invoke(), (e) => e === bad);
  assert.equal(second.calls.send.length, 1);
});

test("attempts are bounded and the last transient error is rethrown", async () => {
  const last = httpError(502);
  const { server, calls } = mockServer({
    send: [httpError(503), httpError(504), last],
    get: [rpc.Api.GetTransactionStatus.NOT_FOUND],
  });
  const clock = fakeClock();
  await assert.rejects(client(server, clock, { maxAttempts: 3 }).invoke(), (e) => e === last);
  assert.equal(calls.send.length, 3);
  assert.equal(clock.sleeps.length, 2);
});

test("TRY_AGAIN_LATER is retried, and reported as a submission error when it never clears", async () => {
  const ok = mockServer({ send: ["TRY_AGAIN_LATER", "PENDING"] });
  assert.equal(await client(ok.server, fakeClock(), true).invoke(), 9);
  assert.equal(ok.calls.send.length, 2);

  const stuck = mockServer({ send: ["TRY_AGAIN_LATER"] });
  await assert.rejects(client(stuck.server, fakeClock(), { maxAttempts: 2 }).invoke(), (error: unknown) => {
    assert.ok(error instanceof StreamPayError);
    assert.equal(error.kind, "submission");
    assert.match(error.message, /TRY_AGAIN_LATER after 2 attempts/);
    return true;
  });
  assert.equal(stuck.calls.send.length, 2);
});

test("ambiguous timeout: submitted but unconfirmed is never resubmitted", async () => {
  const { server, calls } = mockServer({ get: [rpc.Api.GetTransactionStatus.NOT_FOUND] });
  const clock = fakeClock();
  await assert.rejects(client(server, clock, { maxAttempts: 5 }).invoke(), (error: unknown) => {
    assert.ok(error instanceof StreamPayError);
    assert.equal(error.kind, "inclusion");
    assert.match(error.message, /timed out after 100ms/);
    assert.equal(error.transactionHash, calls.get[0], "hash returned for reconciliation");
    return true;
  });
  assert.equal(calls.send.length, 1);
  assert.equal(clock.t - 1_000_000, 100, "polling stops at the deadline on the fake clock");
});

test("transient status reads keep polling instead of failing the call", async () => {
  const { server, calls } = mockServer({
    get: [httpError(503), networkError(), rpc.Api.GetTransactionStatus.SUCCESS],
  });
  assert.equal(await client(server, fakeClock(), true).invoke(), 9);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.get.length, 3);
});

test("preflight stages retry transient failures before anything is signed", async () => {
  const { server, calls } = mockServer({
    getAccount: [networkError(), "ok"],
    simulate: [httpError(429, { "retry-after": "1" }), "ok"],
  });
  const clock = fakeClock([0]);
  const stages: string[] = [];
  await client(server, clock, { maxDelayMs: 5000, onRetry: (i) => stages.push(i.stage) }).invoke();
  assert.equal(calls.getAccount, 2);
  assert.equal(calls.simulate, 2);
  assert.deepEqual(stages, ["account", "simulation"]);
  assert.equal(clock.sleeps[1], 1000, "Retry-After honoured");
});
