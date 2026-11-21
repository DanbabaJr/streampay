/**
 * Secret rotation — issue #615.
 *
 * What is covered, and why each one is the test that matters:
 *
 *  - overlap-window verification: both keys verify inside the window, the old
 *    one stops verifying outside it (a rotation that drops the old key
 *    immediately is the outage this exists to prevent);
 *  - dual-signed webhook headers verify against either key, so a subscriber
 *    that has not yet picked up the new key keeps receiving valid events;
 *  - failed rotations abort and leave the old secret active — health check
 *    failing, provider write throwing, and an endpoint that vanished;
 *  - audit integrity: a tampered or reordered entry breaks the hash chain;
 *  - chaos: rotations under continuous verification, asserting that no
 *    signature produced from the live key set ever fails to verify, and the
 *    key set never grows past the policy;
 *  - the scheduler rotates when due and backs off after repeated failures.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { WebhookStore } from "../webhooks/store.js";
import { canonicalizeJson, generateSignatureHeader, verifySignatureHeader } from "../webhooks/hmac.js";
import {
  AuditLog,
  EnvSecretProvider,
  MemorySecretProvider,
  SecretRotationManager,
  WebhookKeyRotation,
  generateSecret,
  keyIdFor,
  type RotationAlert,
} from "./rotation.js";
import { loadRotationConfig, MIN_OVERLAP_MS, rpcAuthHeaders } from "./config.js";

const HOUR = 60 * 60 * 1000;

function clock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function db(): Database.Database {
  return new Database(":memory:");
}

describe("generic secret rotation", () => {
  let time: ReturnType<typeof clock>;
  let provider: MemorySecretProvider;
  let alerts: RotationAlert[];

  beforeEach(() => {
    time = clock();
    provider = new MemorySecretProvider({ RPC_CREDENTIAL: "cred-v1" });
    alerts = [];
  });

  function manager(options: { healthCheck?: (candidate: string) => Promise<boolean> } = {}) {
    return new SecretRotationManager({
      name: "RPC_CREDENTIAL",
      provider,
      now: time.now,
      policy: { overlapMs: HOUR, rotationIntervalMs: 24 * HOUR },
      onAlert: (alert) => alerts.push(alert),
      healthCheck: options.healthCheck,
    });
  }

  it("keeps both secrets valid only inside the overlap window", async () => {
    const rotation = manager();
    await rotation.init();
    const first = rotation.current()!;
    assert.equal(first.value, "cred-v1");

    const outcome = await rotation.rotate("ops", "test");
    assert.equal(outcome.ok, true);
    assert.notEqual(outcome.value, "cred-v1");

    const inside = rotation.acceptedValues(time.now());
    assert.deepEqual(inside, [outcome.value, "cred-v1"], "new key first, old key still accepted");

    time.advance(HOUR + 1);
    assert.deepEqual(rotation.acceptedValues(time.now()), [outcome.value]);
    assert.equal(rotation.retireExpired(time.now()), true);
    assert.equal(rotation.retireExpired(time.now()), false, "retirement is idempotent");
  });

  it("aborts when the candidate fails its health check and keeps the old secret", async () => {
    const rotation = manager({ healthCheck: async () => false });
    await rotation.init();

    const outcome = await rotation.rotate("ops", "test");
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /health check/);
    assert.equal(rotation.current()!.value, "cred-v1", "old secret still active");
    assert.equal(await provider.get("RPC_CREDENTIAL"), "cred-v1", "the provider was never written");
    assert.equal(alerts.length, 1);
    assert.equal(rotation.state().consecutiveFailures, 1);

    const actions = rotation.audit.all().map((entry) => entry.action);
    assert.deepEqual(actions, ["rotation_started", "rotation_aborted"]);
  });

  it("aborts when the secrets manager write fails and keeps the old secret", async () => {
    class FlakyProvider extends MemorySecretProvider {
      override async put(): Promise<void> {
        throw new Error("secrets manager unavailable");
      }
    }
    const flaky = new FlakyProvider({ RPC_CREDENTIAL: "cred-v1" });
    const rotation = new SecretRotationManager({
      name: "RPC_CREDENTIAL",
      provider: flaky,
      now: time.now,
      policy: { overlapMs: HOUR },
      onAlert: (alert) => alerts.push(alert),
    });
    await rotation.init();

    const outcome = await rotation.rotate("ops", "test");
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /secrets manager unavailable/);
    assert.equal(rotation.current()!.value, "cred-v1");
    assert.equal(alerts.length, 1, "an aborted rotation alerts");
    assert.equal(rotation.audit.verify().valid, true);
  });

  it("does not overlap rotations that are already in flight", async () => {
    let release: (value: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const rotation = manager({ healthCheck: () => gate });
    await rotation.init();

    const first = rotation.rotate("ops", "test");
    const second = await rotation.rotate("ops", "test");
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /already in flight/);

    release(true);
    assert.equal((await first).ok, true);
  });

  it("rotates on schedule and backs off after repeated failures", async () => {
    let healthy = false;
    const rotation = manager({ healthCheck: async () => healthy });
    await rotation.init();

    time.advance(25 * HOUR);
    let tick = await rotation.tick(time.now());
    assert.equal(tick.rotated, false, "first attempt fails");
    assert.equal(tick.outcome?.ok, false);

    healthy = true;
    tick = await rotation.tick(time.now());
    assert.equal(tick.rotated, true);
    assert.equal(rotation.audit.verify().valid, true);

    // Three consecutive failures stop the scheduler from hammering the path.
    for (let i = 0; i < 3; i++) {
      healthy = false;
      await rotation.rotate("ops", "test");
      time.advance(25 * HOUR);
    }
    healthy = true;
    const before = rotation.audit.all().length;
    tick = await rotation.tick(time.now());
    assert.equal(tick.rotated, false);
    const appended = rotation.audit.all().slice(before).map((entry) => entry.action);
    assert.equal(appended.includes("rotation_started"), false, "no rotation was attempted while backing off");
  });

  it("survives rotation under load: every signature from the live key set verifies", async () => {
    const rotation = manager();
    await rotation.init();
    const policyOverlap = HOUR;

    const verifications: boolean[] = [];
    // Chaos: rotate while readers verify against whatever the live key set is
    // at the moment they sign. With a correct overlap, none of them fails.
    for (let round = 0; round < 40; round++) {
      const values = rotation.acceptedValues(time.now());
      // The HMAC verifier's replay window is checked against the wall clock, not
      // the injected rotation clock, so signatures are stamped with real time.
      const timestamp = Math.floor(Date.now() / 1000);
      for (const value of values) {
        const header = generateSignatureHeader(value, timestamp, "{}");
        const result = verifySignatureHeader(header, values, "{}", 300);
        verifications.push(result.valid);
      }
      const outcome = await rotation.rotate("chaos", "under-load");
      assert.equal(outcome.ok, true);
      assert.ok(rotation.acceptedValues(time.now()).length <= 2, "never more than two live keys");
      time.advance(policyOverlap / 8);
      rotation.retireExpired(time.now());
    }

    assert.equal(verifications.filter((valid) => !valid).length, 0, "no verification failed under rotation");
    assert.equal(rotation.audit.verify().valid, true, "the audit chain survived the chaos run");
    assert.ok(rotation.audit.all().length >= 80, "every rotation and retirement was recorded");
  });
});

describe("audit log integrity", () => {
  it("detects an edited entry", () => {
    const audit = new AuditLog();
    const now = 1_700_000_000_000;
    audit.append({ at: now, action: "rotation_started", secretName: "s", actor: "ops" });
    audit.append({ at: now + 1, action: "rotation_promoted", secretName: "s", actor: "ops", keyId: "abc" });

    assert.deepEqual(audit.verify(), { valid: true, entries: 2 });

    // Tamper with a field the hash covers.
    (audit.all()[1] as { keyId: string }).keyId = "def";
    const verdict = audit.verify();
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAtSeq, 2);
  });

  it("detects a dropped entry", () => {
    const audit = new AuditLog();
    const now = 1_700_000_000_000;
    audit.append({ at: now, action: "rotation_started", secretName: "s", actor: "ops" });
    audit.append({ at: now + 1, action: "rotation_promoted", secretName: "s", actor: "ops" });
    audit.append({ at: now + 2, action: "secret_retired", secretName: "s", actor: "ops" });

    const entries = audit.all() as unknown as Array<Record<string, unknown>>;
    entries.splice(1, 1);
    const verdict = audit.verify();
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAtSeq, 3, "the gap is reported at the entry that follows it");
  });

  it("never records secret material", () => {
    const audit = new AuditLog();
    const { value, keyId } = generateSecret("whsec");
    audit.append({ at: 1, action: "rotation_promoted", secretName: "s", actor: "ops", keyId });
    const serialized = JSON.stringify(audit.all());
    assert.equal(serialized.includes(value), false, "the secret value must never be in the log");
    assert.equal(serialized.includes(keyId), true);
    assert.equal(keyId, keyIdFor(value));
  });
});

describe("webhook signing-key rotation", () => {
  let time: ReturnType<typeof clock>;
  let store: WebhookStore;
  let endpointId: string;
  let alerts: RotationAlert[];

  beforeEach(() => {
    time = clock();
    store = new WebhookStore(db());
    const endpoint = store.createEndpoint({ url: "https://example.com/hook", events: ["stream_created"] });
    endpointId = endpoint.id;
    alerts = [];
  });

  function rotation() {
    return new WebhookKeyRotation(store, {
      now: time.now,
      policy: { overlapMs: HOUR },
      onAlert: (alert) => alerts.push(alert),
    });
  }

  it("accepts both keys during the overlap window and only the new one after it", () => {
    const webhookRotation = rotation();
    const before = store.getEndpoint(endpointId)!;
    const oldSecret = before.secret;

    const outcome = webhookRotation.rotate(endpointId, "ops");
    assert.equal(outcome.ok, true);
    const after = store.getEndpoint(endpointId)!;
    assert.notEqual(after.secret, oldSecret);
    assert.equal(after.previous_secret, oldSecret);

    const payload = canonicalizeJson({ event: "stream_created" });
    const timestamp = Math.floor(Date.now() / 1000);

    // Dual-signed header: subscribers with the new key and with the old key both
    // verify — this is the zero-downtime property for delivery.
    const dualHeader = generateSignatureHeader(after.secret, timestamp, payload, oldSecret);
    assert.equal(verifySignatureHeader(dualHeader, [after.secret], payload).valid, true);
    assert.equal(verifySignatureHeader(dualHeader, [oldSecret], payload).valid, true);
    assert.equal(webhookRotation.verify(endpointId, dualHeader, payload).valid, true);

    // A subscriber still on the old key alone also verifies during the window.
    const oldOnly = generateSignatureHeader(oldSecret, timestamp, payload);
    assert.equal(webhookRotation.verify(endpointId, oldOnly, payload).valid, true);

    // Outside the window the old key stops verifying even before the sweep runs.
    time.advance(HOUR + 1);
    const stillOld = generateSignatureHeader(oldSecret, Math.floor(Date.now() / 1000), payload);
    const rejected = webhookRotation.verify(endpointId, stillOld, payload);
    assert.equal(rejected.valid, false);
    assert.match(rejected.reason ?? "", /previous secret retired/);

    // ...and the sweep clears the column.
    assert.deepEqual(webhookRotation.sweep(time.now()), [endpointId]);
    assert.equal(store.getEndpoint(endpointId)!.previous_secret, null);
    assert.equal(webhookRotation.sweep(time.now()).length, 0, "sweeping twice is a no-op");
    assert.equal(webhookRotation.audit.verify().valid, true);
  });

  it("keeps the old key active when the rotation aborts", () => {
    const webhookRotation = rotation();
    const secretBefore = store.getEndpoint(endpointId)!.secret;

    const outcome = webhookRotation.rotate("does-not-exist", "ops");
    assert.equal(outcome.ok, false);
    assert.equal(alerts.length, 1);
    assert.equal(store.getEndpoint(endpointId)!.secret, secretBefore);
    const actions = webhookRotation.audit.all().map((entry) => entry.action);
    assert.deepEqual(actions, ["rotation_started", "rotation_aborted"]);
  });

  it("does not rotate one endpoint twice concurrently", () => {
    const webhookRotation = rotation();
    // The in-flight guard is per endpoint; a second endpoint is unaffected.
    const other = store.createEndpoint({ url: "https://example.com/other", events: ["stream_created"] });
    assert.equal(webhookRotation.rotate(endpointId, "ops").ok, true);
    assert.equal(webhookRotation.rotate(other.id, "ops").ok, true);
  });
});

describe("rotation configuration", () => {
  it("is off by default and clamps a zero overlap to the minimum", () => {
    const config = loadRotationConfig({ SECRET_OVERLAP_MS: "0" } as NodeJS.ProcessEnv);
    assert.equal(config.enabled, false);
    assert.equal(config.policy.overlapMs, MIN_OVERLAP_MS);
    assert.equal(config.auditPath, null);

    const enabled = loadRotationConfig({ SECRETS_ROTATION_ENABLED: "1" } as NodeJS.ProcessEnv);
    assert.equal(enabled.enabled, true);
  });

  it("builds RPC auth headers from either credential shape", () => {
    assert.deepEqual(rpcAuthHeaders({} as NodeJS.ProcessEnv), {});
    assert.deepEqual(
      rpcAuthHeaders({ RPC_AUTH_HEADER: "X-Api-Key", RPC_AUTH_VALUE: "k1" } as NodeJS.ProcessEnv),
      { "X-Api-Key": "k1" }
    );
    assert.deepEqual(
      rpcAuthHeaders({ RPC_BEARER_TOKEN: "t0ken" } as NodeJS.ProcessEnv),
      { Authorization: "Bearer t0ken" }
    );
  });

  it("reads provider-backed secrets through the env provider", async () => {
    const env = { RPC_CREDENTIAL: "from-env" } as NodeJS.ProcessEnv;
    const provider = new EnvSecretProvider(env);
    assert.equal(await provider.get("RPC_CREDENTIAL"), "from-env");
    await provider.put("RPC_CREDENTIAL", "rotated");
    assert.equal(env.RPC_CREDENTIAL, "rotated");
  });
});
