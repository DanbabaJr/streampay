import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { canonicalizeJson, generateSignatureHeader, verifySignatureHeader } from "./webhooks/hmac.js";
import { validateWebhookUrl } from "./webhooks/ssrf.js";
import { calculateNextRetryDelay, isTerminalAttempt, MAX_RETRY_ATTEMPTS } from "./webhooks/retry.js";
import { WebhookStore } from "./webhooks/store.js";

describe("Webhook System", () => {
  describe("HMAC Signing & Dual-Signature Rotation", () => {
    const secret1 = "whsec_primary_secret_0123456789";
    const secret2 = "whsec_rotated_secret_9876543210";
    const payload = {
      event_id: "evt_100",
      event_type: "stream_created",
      stream_id: "42",
      timestamp: 1700000000,
      payload: { deposit: "1000", recipient: "GBB...", sender: "GAA..." },
    };
    const canonicalPayload = canonicalizeJson(payload);

    it("produces deterministic canonical JSON with sorted keys", () => {
      const objA = { b: 2, a: 1, c: { y: 20, x: 10 } };
      const objB = { c: { x: 10, y: 20 }, a: 1, b: 2 };
      assert.strictEqual(canonicalizeJson(objA), canonicalizeJson(objB));
      assert.strictEqual(canonicalizeJson(objA), '{"a":1,"b":2,"c":{"x":10,"y":20}}');
    });

    it("generates and verifies standard single signature header", () => {
      const now = Math.floor(Date.now() / 1000);
      const header = generateSignatureHeader(secret1, now, canonicalPayload);
      assert.ok(header.startsWith(`t=${now},v1=`));

      const verification = verifySignatureHeader(header, secret1, canonicalPayload);
      assert.strictEqual(verification.valid, true);

      // Fails with wrong secret
      const badSecretVerification = verifySignatureHeader(header, "wrong_secret", canonicalPayload);
      assert.strictEqual(badSecretVerification.valid, false);

      // Fails with tampered payload
      const tamperedVerification = verifySignatureHeader(header, secret1, '{"tampered":true}');
      assert.strictEqual(tamperedVerification.valid, false);
    });

    it("enforces replay protection against stale timestamps", () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const header = generateSignatureHeader(secret1, oldTimestamp, canonicalPayload);
      const verification = verifySignatureHeader(header, secret1, canonicalPayload, 300);
      assert.strictEqual(verification.valid, false);
      assert.ok(verification.reason?.includes("out of bounds"));
    });

    it("supports dual-signature rotation with overlap window", () => {
      const now = Math.floor(Date.now() / 1000);
      // New primary is secret2, previous active secret is secret1
      const header = generateSignatureHeader(secret2, now, canonicalPayload, secret1);
      assert.ok(header.includes(",v1=")); // contains two v1 signatures

      // Client still using secret1 can verify successfully
      const verifyOld = verifySignatureHeader(header, secret1, canonicalPayload);
      assert.strictEqual(verifyOld.valid, true);

      // Client upgraded to secret2 can verify successfully
      const verifyNew = verifySignatureHeader(header, secret2, canonicalPayload);
      assert.strictEqual(verifyNew.valid, true);

      // Third party secret rejected
      const verifyUnknown = verifySignatureHeader(header, "secret3", canonicalPayload);
      assert.strictEqual(verifyUnknown.valid, false);
    });
  });

  describe("SSRF Protection Guard", () => {
    it("rejects loopback addresses", async () => {
      assert.strictEqual((await validateWebhookUrl("http://127.0.0.1:8080/webhook")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://localhost:3000/events")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://127.1.2.3/hook")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://[::1]:9000/hook")).safe, false);
    });

    it("rejects private RFC-1918 addresses", async () => {
      assert.strictEqual((await validateWebhookUrl("http://10.0.0.5/webhook")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://172.16.50.1/webhook")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://172.31.255.255/webhook")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://192.168.1.100/webhook")).safe, false);
    });

    it("rejects cloud metadata IP and internal hostnames", async () => {
      assert.strictEqual((await validateWebhookUrl("http://169.254.169.254/latest/meta-data")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://metadata.google.internal/computeMetadata/v1/")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://service.internal/webhook")).safe, false);
      assert.strictEqual((await validateWebhookUrl("http://service.local/webhook")).safe, false);
    });

    it("rejects non-HTTP protocols", async () => {
      assert.strictEqual((await validateWebhookUrl("ftp://example.com/file")).safe, false);
      assert.strictEqual((await validateWebhookUrl("file:///etc/passwd")).safe, false);
      assert.strictEqual((await validateWebhookUrl("gopher://example.com")).safe, false);
    });

    it("accepts valid public domain webhooks", async () => {
      const res = await validateWebhookUrl("https://example.com/webhook");
      assert.strictEqual(res.safe, true);
    });
  });

  describe("Retry Policy & Jitter Calculations", () => {
    it("enforces max 5 attempts", () => {
      assert.strictEqual(MAX_RETRY_ATTEMPTS, 5);
      assert.strictEqual(isTerminalAttempt(1), false);
      assert.strictEqual(isTerminalAttempt(4), false);
      assert.strictEqual(isTerminalAttempt(5), true);
      assert.strictEqual(isTerminalAttempt(6), true);
    });

    it("computes exponential backoff intervals within ±20% jitter bounds", () => {
      // Attempt 1: immediate
      assert.strictEqual(calculateNextRetryDelay(1), 0);

      // Attempt 2 base is 60,000ms: with ±20% jitter, must be in [48,000, 72,000]
      const minJitter = () => 0; // jitter factor 0.8
      const maxJitter = () => 1; // jitter factor 1.2
      const midJitter = () => 0.5; // jitter factor 1.0

      assert.strictEqual(calculateNextRetryDelay(2, minJitter), 48_000);
      assert.strictEqual(calculateNextRetryDelay(2, maxJitter), 72_000);
      assert.strictEqual(calculateNextRetryDelay(2, midJitter), 60_000);

      // Attempt 3 base is 300,000ms (5m) -> [240,000, 360,000]
      assert.strictEqual(calculateNextRetryDelay(3, minJitter), 240_000);
      assert.strictEqual(calculateNextRetryDelay(3, maxJitter), 360_000);

      // Attempt 4 base is 900,000ms (15m) -> [720,000, 1,080,000]
      assert.strictEqual(calculateNextRetryDelay(4, minJitter), 720_000);
      assert.strictEqual(calculateNextRetryDelay(4, maxJitter), 1_080_000);

      // Attempt 5 base is 1,800,000ms (30m) -> [1,440,000, 2,160,000]
      assert.strictEqual(calculateNextRetryDelay(5, minJitter), 1_440_000);
      assert.strictEqual(calculateNextRetryDelay(5, maxJitter), 2_160_000);
    });
  });

  describe("Webhook Store & Dead-Letter Queue (DLQ)", () => {
    let db: Database.Database;
    let store: WebhookStore;

    it("manages endpoint lifecycle and secret rotation", () => {
      db = new Database(":memory:");
      store = new WebhookStore(db);

      const ep = store.createEndpoint({
        url: "https://api.acme.corp/webhooks/streampay",
        events: ["stream_created", "withdrawn"],
      });

      assert.ok(ep.id.startsWith("wh_"));
      assert.ok(ep.secret.startsWith("whsec_"));
      assert.strictEqual(ep.previous_secret, null);
      assert.deepStrictEqual(ep.events, ["stream_created", "withdrawn"]);

      // Rotation
      const rotated = store.rotateEndpointSecret(ep.id);
      assert.notStrictEqual(rotated.secret, ep.secret);
      assert.strictEqual(rotated.previous_secret, ep.secret);

      const fetched = store.getEndpoint(ep.id);
      assert.strictEqual(fetched?.secret, rotated.secret);
      assert.strictEqual(fetched?.previous_secret, ep.secret);
    });

    it("queues event deliveries and handles DLQ transition on attempt 5", () => {
      const ep = store.createEndpoint({
        url: "https://api.acme.corp/webhooks/listener",
        events: ["*"],
      });

      const event = {
        id: "evt_test_1",
        name: "stream_created",
        streamId: "123",
        ledgerClosedAt: new Date().toISOString(),
        data: { deposit: "5000", token: "XLM" },
      };

      const queued = store.queueDeliveriesForEvent(event);
      assert.strictEqual(queued, 2); // 2 active endpoints in memory db

      const due = store.getDueDeliveries();
      const delivery = due.find((d) => d.endpoint_id === ep.id && d.event_id === event.id);
      assert.ok(delivery);
      assert.strictEqual(delivery?.attempt, 1);
      assert.strictEqual(delivery?.status, "pending");

      // Simulate 4 failures
      for (let attempt = 1; attempt <= 4; attempt++) {
        store.recordDeliveryFailure(delivery.id, 503, "Service Unavailable", 45);
        const current = store.getDelivery(delivery.id);
        assert.strictEqual(current?.attempt, attempt + 1);
        assert.strictEqual(current?.status, "pending");
      }

      // Attempt 5 failure: MUST transition to Dead-Letter Queue
      store.recordDeliveryFailure(delivery.id, 503, "Service Unavailable", 50);

      const terminalDelivery = store.getDelivery(delivery.id);
      assert.strictEqual(terminalDelivery?.status, "dead_letter");
      assert.strictEqual(terminalDelivery?.history.length, 5);

      // Verify item exists in DLQ
      const dlqItems = store.listDLQ();
      const dlqItem = dlqItems.find((item) => item.delivery_id === delivery.id);
      assert.ok(dlqItem);
      assert.strictEqual(dlqItem?.attempts_count, 5);
      assert.strictEqual(dlqItem?.last_status_code, 503);
      assert.strictEqual(dlqItem?.last_error, "Service Unavailable");

      // Replay DLQ item
      const replayed = store.replayDLQItem(dlqItem!.id);
      assert.strictEqual(replayed, true);

      // Verify fresh delivery queued with attempt 1
      const freshDue = store.getDueDeliveries();
      const replayedDelivery = freshDue.find(
        (d) => d.endpoint_id === ep.id && d.event_id === event.id && d.id !== delivery.id
      );
      assert.ok(replayedDelivery);
      assert.strictEqual(replayedDelivery?.attempt, 1);
      assert.strictEqual(replayedDelivery?.status, "pending");
    });
  });
});
