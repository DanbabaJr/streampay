import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import Database from "better-sqlite3";
import { canonicalizeJson, generateSignatureHeader, verifySignatureHeader } from "./webhooks/hmac.js";
import { validateWebhookUrl, isDisallowedIpv4, isDisallowedIpv6 } from "./webhooks/ssrf.js";
import { calculateNextRetryDelay, isTerminalAttempt, MAX_RETRY_ATTEMPTS } from "./webhooks/retry.js";
import { WebhookStore } from "./webhooks/store.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import { SSRF_BYPASS_FIXTURES, REDIRECT_ESCAPE_FIXTURES } from "./webhooks/ssrf-fixtures.js";

// =========================================================================
// Simulated DNS Resolution (no real network access in tests)
// =========================================================================
const simulatedDnsMap = new Map<string, Array<{ address: string; family: number }>>();

// Seed standard public test domains
simulatedDnsMap.set("example.com", [{ address: "93.184.216.34", family: 4 }]);
simulatedDnsMap.set("public.example.com", [{ address: "93.184.216.34", family: 4 }]);
simulatedDnsMap.set("webhook-source.example.com", [{ address: "93.184.216.34", family: 4 }]);

// Seed all simulated DNS records defined in the SSRF bypass fixture catalog
for (const fixture of SSRF_BYPASS_FIXTURES) {
  if (fixture.simulatedDnsRecords) {
    try {
      const u = new URL(fixture.target);
      simulatedDnsMap.set(u.hostname.toLowerCase(), fixture.simulatedDnsRecords);
    } catch {}
  }
}

// Intercept dns.lookup to use simulated DNS records
mock.method(dns, "lookup", async (hostname: string, _options?: any) => {
  const normHost = hostname.toLowerCase();
  const records = simulatedDnsMap.get(normHost);
  if (records) {
    return records;
  }
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  (err as any).code = "ENOTFOUND";
  throw err;
});

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
    // Original test cases preserved
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

    // -------------------------------------------------------------
    // Extended Modern SSRF Bypass Fixtures
    // -------------------------------------------------------------
    it("rejects expanded IPv6 loopback and unspecified representations", async () => {
      const loopbackCases = [
        "http://[::1]:9000/hook",
        "http://[0:0:0:0:0:0:0:1]:8080/hook",
        "http://[0000:0000:0000:0000:0000:0000:0000:0001]/hook",
        "http://[::0001]/hook",
        "http://[::]/hook",
        "http://[0:0:0:0:0:0:0:0]/hook",
      ];
      for (const target of loopbackCases) {
        const res = await validateWebhookUrl(target);
        assert.strictEqual(res.safe, false, `Expected ${target} to be rejected`);
      }
    });

    it("rejects IPv6 link-local, unique-local (ULA), and multicast variants", async () => {
      const v6Cases = [
        "http://[fe80::1]/hook",
        "http://[fe80:0:0:0:200:5efe:127.0.0.1]/hook",
        "http://[feb0::1]/hook",
        "http://[fc00::1]/hook",
        "http://[fd00::1]/hook",
        "http://[fd12:3456:789a::1]/hook",
        "http://[ff02::1]/hook",
      ];
      for (const target of v6Cases) {
        const res = await validateWebhookUrl(target);
        assert.strictEqual(res.safe, false, `Expected ${target} to be rejected`);
      }
    });

    it("rejects IPv4-mapped IPv6, IPv4-compatible IPv6, and 6to4 addresses", async () => {
      const mappedCases = [
        "http://[::ffff:127.0.0.1]:8080/webhook",
        "http://[::ffff:7f00:1]:8080/webhook",
        "http://[::ffff:10.0.0.1]/webhook",
        "http://[::ffff:a00:1]/webhook",
        "http://[::ffff:169.254.169.254]/latest/meta-data",
        "http://[::ffff:a9fe:a9fe]/computeMetadata/v1/",
        "http://[::ffff:192.168.1.1]/webhook",
        "http://[::ffff:c0a8:101]/webhook",
        "http://[::ffff:172.16.0.1]/webhook",
        "http://[0:0:0:0:0:ffff:127.0.0.1]/webhook",
        "http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/webhook",
        "http://[::127.0.0.1]/webhook",
        "http://[2002:7f00:0001::]/webhook",
        "http://[2002:a9fe:a9fe::]/webhook",
      ];
      for (const target of mappedCases) {
        const res = await validateWebhookUrl(target);
        assert.strictEqual(res.safe, false, `Expected ${target} to be rejected`);
      }
    });

    it("rejects decimal, octal, hex, and shorthand IPv4 encodings", async () => {
      const encodingCases = [
        "http://2130706433/webhook",
        "http://0177.0.0.1/webhook",
        "http://017700000001/webhook",
        "http://0x7f000001/webhook",
        "http://0x7f.0.0.1/webhook",
        "http://127.1/webhook",
        "http://127.0.1/webhook",
        "http://0/webhook",
        "http://2852039166/latest/meta-data",
        "http://0xa9fea9fe/latest/meta-data",
        "http://0251.0376.0251.0376/latest/meta-data",
        "http://025177524776/latest/meta-data",
        "http://167772161/webhook",
        "http://012.0.0.1/webhook",
        "http://0x0a000001/webhook",
        "http://2886729729/webhook",
        "http://3232235521/webhook",
        "http://0300.0250.0.1/webhook",
        "http://0xc0a80001/webhook",
      ];
      for (const target of encodingCases) {
        const res = await validateWebhookUrl(target);
        assert.strictEqual(res.safe, false, `Expected ${target} to be rejected`);
      }
    });

    it("rejects hostnames resolving to private, loopback, or metadata ranges via simulated DNS", async () => {
      const dnsCases = [
        "http://simulated-loopback.internal-test/webhook",
        "http://simulated-private-10.internal-test/webhook",
        "http://simulated-private-172.internal-test/webhook",
        "http://simulated-private-192.internal-test/webhook",
        "http://simulated-metadata.internal-test/webhook",
        "http://simulated-cgnat.internal-test/webhook",
        "http://simulated-v6-loopback.internal-test/webhook",
        "http://simulated-v6-linklocal.internal-test/webhook",
        "http://simulated-v6-ula.internal-test/webhook",
        "http://simulated-v6-mapped.internal-test/webhook",
        "http://simulated-v6-mapped-hex.internal-test/webhook",
        "http://simulated-rebind-multihomed.internal-test/webhook",
        "http://simulated-rebind-v6.internal-test/webhook",
      ];
      for (const target of dnsCases) {
        const res = await validateWebhookUrl(target);
        assert.strictEqual(res.safe, false, `Expected ${target} to be rejected`);
      }
    });

    it("validates all entries in the modern SSRF fixture catalog", async () => {
      for (const fixture of SSRF_BYPASS_FIXTURES) {
        const res = await validateWebhookUrl(fixture.target);
        assert.strictEqual(
          res.safe,
          fixture.expectedSafe,
          `Fixture failed for target: ${fixture.target} (${fixture.description})`
        );
      }
    });
  });

  describe("Redirect-Based Escape Prevention (Dispatcher)", () => {
    let db: Database.Database;
    let store: WebhookStore;
    let dispatcher: WebhookDispatcher;

    it("rejects HTTP 3xx redirect escapes before any request is made to the target", async () => {
      for (const fixture of REDIRECT_ESCAPE_FIXTURES) {
        db = new Database(":memory:");
        store = new WebhookStore(db);
        dispatcher = new WebhookDispatcher(store);

        const ep = store.createEndpoint({
          url: "https://webhook-source.example.com/events",
          events: ["*"],
        });

        const event = {
          id: `evt_redir_${Date.now()}`,
          name: "stream_created",
          streamId: "99",
          ledgerClosedAt: new Date().toISOString(),
          data: { test: true },
        };
        store.queueDeliveriesForEvent(event);
        const due = store.getDueDeliveries();
        const delivery = due.find((d) => d.endpoint_id === ep.id);
        assert.ok(delivery);

        // Track all HTTP requests made
        const dispatchedUrls: string[] = [];

        // Mock global fetch to return 302 redirect on first request
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          dispatchedUrls.push(urlStr);

          // Return redirect to the fixture target
          return new Response("", {
            status: 302,
            headers: { Location: fixture.target },
          });
        }) as typeof fetch;

        try {
          const outcome = await dispatcher.deliverSingle(delivery);

          // Assert the delivery was blocked
          assert.strictEqual(outcome.success, false);
          assert.ok(
            outcome.statusCode === 403 || outcome.error?.includes("Disallowed protocol"),
            `Expected 403 or disallowed protocol for ${fixture.target}, got ${outcome.statusCode}`
          );

          // CRITICAL ASSERTION: The escaped target must NEVER have been called!
          // Only the initial safe webhook URL was dispatched.
          assert.strictEqual(
            dispatchedUrls.length,
            1,
            `Expected exactly 1 request to initial URL, but requests were made to: ${dispatchedUrls.join(", ")}`
          );
          assert.strictEqual(
            dispatchedUrls[0],
            "https://webhook-source.example.com/events",
            `Initial URL mismatch: ${dispatchedUrls[0]}`
          );
        } finally {
          globalThis.fetch = originalFetch;
        }
      }
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
