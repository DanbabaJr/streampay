import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createVerificationChallenge,
  verifySignatureChallenge,
  checkRateLimit,
} from "./challenge.ts";
import { SubscriptionStore } from "./store.ts";
import {
  WebhookNotifier,
  EmailNotifier,
  TelegramNotifier,
  MockSinkNotifier,
  type FetchFunction,
} from "./notifiers.ts";
import {
  NotificationDispatcher,
  computeExponentialBackoff,
} from "./dispatcher.ts";
import type { StreamEvent, OutgoingNotification } from "./types.ts";

describe("Notifications System", () => {
  let store: SubscriptionStore;

  beforeEach(() => {
    store = new SubscriptionStore();
  });

  describe("Abuse Controls & Signature Verification", () => {
    it("generates and verifies ed25519 signed challenges", () => {
      const keypair = Keypair.random();
      const address = keypair.publicKey();

      const challenge = createVerificationChallenge(address, 300);
      assert.ok(challenge.message.includes(address));
      assert.ok(challenge.nonce.length > 0);

      // Sign challenge using account private key
      const signature = keypair.sign(Buffer.from(challenge.message, "utf8"));
      const result = verifySignatureChallenge(
        challenge.message,
        signature,
        address
      );

      assert.equal(result.valid, true);
    });

    it("rejects challenge signed by wrong keypair or tampered message", () => {
      const legitKeypair = Keypair.random();
      const attackerKeypair = Keypair.random();
      const address = legitKeypair.publicKey();

      const challenge = createVerificationChallenge(address, 300);

      // Attacker signs the message intended for legitKeypair
      const attackerSig = attackerKeypair.sign(
        Buffer.from(challenge.message, "utf8")
      );
      const result = verifySignatureChallenge(
        challenge.message,
        attackerSig,
        address
      );

      assert.equal(result.valid, false);
      assert.ok(result.reason?.includes("failed") || result.reason?.includes("verification"));
    });

    it("enforces replay protection by consuming nonces", () => {
      const keypair = Keypair.random();
      const address = keypair.publicKey();

      const challenge = createVerificationChallenge(address, 300);
      const signature = keypair.sign(Buffer.from(challenge.message, "utf8"));

      // First verification succeeds and consumes nonce
      const first = verifySignatureChallenge(challenge.message, signature, address);
      assert.equal(first.valid, true);

      // Replay attack with same challenge fails
      const replay = verifySignatureChallenge(challenge.message, signature, address);
      assert.equal(replay.valid, false);
      assert.ok(replay.reason?.includes("nonce"));
    });

    it("enforces rate limits per address", () => {
      const testAddr = "G_RATE_LIMIT_TEST";
      // Allow up to 3 attempts in test window
      for (let i = 0; i < 3; i++) {
        assert.equal(checkRateLimit(testAddr, 3, 60), true);
      }
      // 4th attempt should be blocked
      assert.equal(checkRateLimit(testAddr, 3, 60), false);
    });
  });

  describe("Subscription Store", () => {
    it("registers and queries subscriptions by address and event type", async () => {
      const address = "GBZ...STAKEHOLDER";
      const sub = await store.addSubscription({
        address,
        channel: "webhook",
        config: { webhook: { url: "https://example.com/webhook", secret: "sec123" } },
        eventTypes: ["claim", "cancel"],
        digest: "instant",
      });

      assert.ok(sub.id.startsWith("sub_"));
      assert.equal(sub.status, "active");

      const userSubs = await store.getSubscriptionsForAddress(address);
      assert.equal(userSubs.length, 1);
      assert.equal(userSubs[0].id, sub.id);

      // Matching event
      const claimEvent: StreamEvent = {
        id: "evt_1",
        type: "claim",
        address,
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
          streamId: "42",
          sender: "GBZ...SENDER",
          recipient: address,
          token: "CAS...USDC",
          deposit: "1000",
          amount: "250",
        },
      };

      const matched = await store.findSubscriptionsForEvent(claimEvent);
      assert.equal(matched.length, 1);
      assert.equal(matched[0].id, sub.id);

      // Non-matching event type
      const createdEvent: StreamEvent = {
        ...claimEvent,
        type: "created",
      };
      const notMatched = await store.findSubscriptionsForEvent(createdEvent);
      assert.equal(notMatched.length, 0);
    });

    it("prevents unauthorized deletion of subscriptions", async () => {
      const owner = "GBZ...OWNER";
      const imposter = "GBZ...IMPOSTER";

      const sub = await store.addSubscription({
        address: owner,
        channel: "email",
        config: { email: { email: "alice@example.com", digest: "instant" } },
        eventTypes: ["cancel"],
      });

      // Imposter fails to delete
      const deletedByImposter = await store.removeSubscription(sub.id, imposter);
      assert.equal(deletedByImposter, false);

      // Owner successfully deletes
      const deletedByOwner = await store.removeSubscription(sub.id, owner);
      assert.equal(deletedByOwner, true);
    });
  });

  describe("Dispatch Worker & Retry-Math Semantics", () => {
    it("strictly bounds exponential backoff math and jitter", () => {
      // Config: base 1000ms, max 32000ms, jitter 0.2 (+/- 20%)
      const config = { baseDelayMs: 1000, maxDelayMs: 32000, maxRetries: 5, jitterFactor: 0.2 };

      for (let attempt = 0; attempt <= 6; attempt++) {
        const delay = computeExponentialBackoff(attempt, config);
        const expectedCenter = Math.min(32000, 1000 * Math.pow(2, attempt));
        const minExpected = expectedCenter * 0.8;
        const maxExpected = expectedCenter * 1.2;

        assert.ok(
          delay >= minExpected && delay <= maxExpected,
          `Attempt ${attempt}: delay ${delay} outside expected bounds [${minExpected}, ${maxExpected}]`
        );
      }
    });

    it("dispatches events with at-least-once guarantee and idempotency keys", async () => {
      const address = "GBZ...RECIPIENT";
      const sink = new MockSinkNotifier("webhook");
      const dispatcher = new NotificationDispatcher(store, {
        baseDelayMs: 10,
        maxDelayMs: 50,
        maxRetries: 2,
        jitterFactor: 0,
      });
      dispatcher.registerNotifier(sink);

      await store.addSubscription({
        address,
        channel: "webhook",
        config: { webhook: { url: "https://mock.local/events", secret: "test_secret" } },
        eventTypes: ["claim"],
      });

      const event: StreamEvent = {
        id: "evt_claim_999",
        type: "claim",
        address,
        timestamp: 1700000000,
        payload: {
          streamId: "99",
          sender: "GBZ...SENDER",
          recipient: address,
          token: "CAS...XLM",
          deposit: "50000",
          amount: "5000",
        },
      };

      const result = await dispatcher.dispatchStreamEvent(event);
      assert.equal(result.dispatchedCount, 1);
      assert.equal(result.successCount, 1);
      assert.equal(result.failureCount, 0);

      assert.equal(sink.delivered.length, 1);
      const delivery = sink.delivered[0];
      assert.equal(delivery.idempotencyKey.includes("evt_claim_999"), true);
      assert.equal(delivery.event.payload.streamId, "99");
    });

    it("retries on transient failures and succeeds after backoff", async () => {
      const address = "GBZ...RETRY_TEST";
      const sink = new MockSinkNotifier("webhook");
      sink.failAttempts = 2; // Fails twice then succeeds on attempt 3

      const dispatcher = new NotificationDispatcher(store, {
        baseDelayMs: 10,
        maxDelayMs: 50,
        maxRetries: 3,
        jitterFactor: 0,
      });
      dispatcher.registerNotifier(sink);

      await store.addSubscription({
        address,
        channel: "webhook",
        config: { webhook: { url: "https://mock.local/retry", secret: "secret" } },
        eventTypes: ["liveness"],
      });

      const event: StreamEvent = {
        id: "evt_live_1",
        type: "liveness",
        address,
        timestamp: 1700000000,
        payload: {
          streamId: "12",
          sender: address,
          recipient: "GBZ...OTHER",
          token: "CAS...TOKEN",
          deposit: "1000",
          remainingLedgers: 4000,
          reason: "TTL below critical threshold (cliff reached)",
        },
      };

      const result = await dispatcher.dispatchStreamEvent(event);
      assert.equal(result.successCount, 1);
      assert.equal(sink.delivered.length, 1);

      // Success resets failure counters on subscription
      const updated = await store.getSubscriptionsForAddress(address);
      assert.equal(updated[0].consecutiveFailures, 0);
    });

    it("detects email hard bounces and marks subscription bounced", async () => {
      const address = "GBZ...BOUNCE_TEST";
      const sink = new MockSinkNotifier("email");
      sink.isBounce = true;

      const dispatcher = new NotificationDispatcher(store, {
        baseDelayMs: 10,
        maxDelayMs: 50,
        maxRetries: 2,
        jitterFactor: 0,
      });
      dispatcher.registerNotifier(sink);

      await store.addSubscription({
        address,
        channel: "email",
        config: { email: { email: "nonexistent@nowhere.xyz", digest: "instant" } },
        eventTypes: ["cancel"],
      });

      const event: StreamEvent = {
        id: "evt_cancel_1",
        type: "cancel",
        address,
        timestamp: 1700000000,
        payload: {
          streamId: "15",
          sender: address,
          recipient: "GBZ...OTHER",
          token: "CAS...USDC",
          deposit: "5000",
          reason: "Stream cancelled by sender.",
        },
      };

      const result = await dispatcher.dispatchStreamEvent(event);
      assert.equal(result.failureCount, 1);

      const updated = await store.getSubscriptionsForAddress(address);
      assert.equal(updated[0].status, "bounced");
      assert.ok(updated[0].bounceReason?.includes("550"));
    });

    it("verifies webhook headers include HMAC signature and Idempotency-Key", async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = "";

      const mockFetch: FetchFunction = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        capturedBody = String(init?.body || "");
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }) as FetchFunction;

      const webhookNotifier = new WebhookNotifier(mockFetch);
      const notification: OutgoingNotification = {
        id: "notif_header_test",
        idempotencyKey: "evt_test:sub_test",
        subscriptionId: "sub_test",
        address: "GBZ...TEST",
        channel: "webhook",
        event: {
          id: "evt_test",
          type: "claim",
          address: "GBZ...TEST",
          timestamp: 1700000000,
          payload: {
            streamId: "77",
            sender: "GBZ...SENDER",
            recipient: "GBZ...TEST",
            token: "CAS...USDC",
            deposit: "1000",
          },
        },
        config: {
          webhook: {
            url: "https://webhook.site/test",
            secret: "my_super_secret_key",
          },
        },
        attempt: 0,
        createdAt: 1700000000,
      };

      const res = await webhookNotifier.deliver(notification);
      assert.equal(res.success, true);
      assert.equal(capturedHeaders["Idempotency-Key"], "evt_test:sub_test");
      assert.ok(capturedHeaders["X-StreamPay-Signature"].startsWith("t="));
      assert.ok(capturedHeaders["X-StreamPay-Signature"].includes("v1="));
      assert.ok(capturedBody.includes("evt_test"));
    });

    it("tests email and telegram notifier adapters", async () => {
      let emailSent = false;
      const emailNotifier = new EmailNotifier({
        send: async () => {
          emailSent = true;
          return { ok: true };
        },
      });

      let telegramSent = false;
      const telegramNotifier = new TelegramNotifier({
        sendMessage: async () => {
          telegramSent = true;
          return { ok: true };
        },
      });

      const notification: OutgoingNotification = {
        id: "notif_adapter_test",
        idempotencyKey: "evt_adapt:sub_adapt",
        subscriptionId: "sub_adapt",
        address: "GBZ...TEST",
        channel: "email",
        event: {
          id: "evt_adapt",
          type: "claim",
          address: "GBZ...TEST",
          timestamp: 1700000000,
          payload: {
            streamId: "123",
            sender: "GBZ...SENDER",
            recipient: "GBZ...TEST",
            token: "CAS...USDC",
            deposit: "1000",
            amount: "100",
          },
        },
        config: {
          email: { email: "user@example.com", digest: "instant" },
          telegram: { chatId: "12345" },
        },
        attempt: 0,
        createdAt: 1700000000,
      };

      const emailResult = await emailNotifier.deliver(notification);
      assert.equal(emailResult.success, true);
      assert.equal(emailSent, true);

      const telegramResult = await telegramNotifier.deliver({
        ...notification,
        channel: "telegram",
      });
      assert.equal(telegramResult.success, true);
      assert.equal(telegramSent, true);
    });
  });
});
