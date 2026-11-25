/**
 * Privacy redaction regression matrix for the indexer API boundary.
 *
 * Pins the exact redaction behavior implemented in `privacy.ts` and
 * `redaction.ts` across every exposure surface:
 *   1. Public listing (`GetStream`, `GetStreamsByRecipient`,
 *      `GetStreamWithRelations`, `ListWebhookSubscriptions`)
 *   2. Address reads (`GetAddressStreams`, `GET /address/:addr/streams`)
 *   3. Event feed (`GetStreamHistory`, `GetStreamEvents`,
 *      `GET /streams/:id/history`, `GET /streams/:id/events`)
 *
 * Every API-boundary assertion inspects the raw serialized JSON wire payload
 * (not just the in-memory redaction helper) so a serializer or route that
 * bypasses redaction fails this suite immediately.
 *
 * Documented doc-vs-code discrepancies (pinned to current code behavior;
 * no policy changes made here):
 *   - `docs/discovery-privacy.md` specifies a Discovery Directory allowlist
 *     that omits `streamId`, `deposit`, `withdrawn`, `start_time`, `end_time`,
 *     `txHash`, and `ledger` and omits `sender`/`recipient` unless both
 *     parties opt in. That directory lives in `frontend/lib/discovery/`.
 *   - The indexer (`privacy.ts` + `redaction.ts`) enforces the Telemetry
 *     Privacy Line (`docs/PRIVACY.md`) and shared read-API redaction:
 *       * `redactStream` truncates `sender`, `recipient`, `refund_target`,
 *         and `cancelled_by` to an 8-char prefix (`GAAAAAAA...`) rather than
 *         omitting them, and passes through `streamId`, `token`, `deposit`,
 *         `withdrawn`, `startTime`, `endTime`, `lastLedger`, and `updatedAt`.
 *       * `redactEvent` / `redactValue` truncates `token` inside event
 *         payloads (`"token"` is in `ADDRESS_KEYS` and matches
 *         `STELLAR_ADDRESS_REGEX`), whereas `redactStream` leaves
 *         `stream.token` unredacted.
 *       * REST routes (`/streams/:id`, `/address/:addr/streams`,
 *         `/streams/:id/history`, `/streams/:id/events`) are unredacted by
 *         default; redaction is enabled on GraphQL via `redactAddresses: true`
 *         (`GRAPHQL_REDACT_ADDRESSES=1` / `REDACT_ADDRESSES=1`).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { StreamStore } from "./store.js";
import { createApp } from "./index.js";
import {
  sanitizeAddress,
  sanitizeWebhookUrl,
  sanitizeEmail,
  sanitizeTelegramChatId,
  sanitizeError,
  sanitizeAttributes,
} from "./privacy.js";
import { ADDRESS_KEYS, redactValue } from "./redaction.js";
import type { DecodedEvent } from "./types.js";

const SENDER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RECIPIENT_A = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const REFUND_TARGET = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const CANCELLED_BY = "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const TOKEN_ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";
const SECRET_SEED = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WEBHOOK_URL = "https://hooks.example.com/v1/notify?token=super_secret_token";
const WEBHOOK_SECRET = "whsec_test_secret_value_12345";

function seedPrivacyStore(): StreamStore {
  const store = new StreamStore(":memory:");
  const events: DecodedEvent[] = [
    {
      id: "evt-1",
      pagingToken: "1",
      ledger: 100,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      contractId: TOKEN_ADDR,
      name: "stream_created",
      streamId: "1",
      data: {
        sender: SENDER_A,
        recipient: RECIPIENT_A,
        token: TOKEN_ADDR,
        deposit: 1000n,
        start_time: 1000n,
        end_time: 2000n,
        cancelable: true,
      },
    },
    {
      id: "evt-2",
      pagingToken: "2",
      ledger: 101,
      ledgerClosedAt: "2026-01-01T00:01:00Z",
      contractId: TOKEN_ADDR,
      name: "withdrawn",
      streamId: "1",
      data: {
        recipient: RECIPIENT_A,
        amount: 250n,
        withdrawn_total: 250n,
      },
    },
    {
      id: "evt-3",
      pagingToken: "3",
      ledger: 102,
      ledgerClosedAt: "2026-01-01T00:02:00Z",
      contractId: TOKEN_ADDR,
      name: "refund_target_changed",
      streamId: "1",
      data: {
        new_target: REFUND_TARGET,
        changed_by: SENDER_A,
      },
    },
    {
      id: "evt-4",
      pagingToken: "4",
      ledger: 103,
      ledgerClosedAt: "2026-01-01T00:03:00Z",
      contractId: TOKEN_ADDR,
      name: "stream_cancelled",
      streamId: "1",
      data: {
        cancelled_by: CANCELLED_BY,
        recipient_amount: 250n,
        sender_amount: 750n,
      },
    },
  ];
  store.ingestPage(events, "4", 103);
  store.webhooks.createEndpoint({
    url: WEBHOOK_URL,
    events: ["stream_created"],
    secret: WEBHOOK_SECRET,
  });
  return store;
}

interface HttpResult {
  status: number;
  rawJson: string;
  data: any;
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let rawJson = "";
        res.on("data", (chunk) => {
          rawJson += chunk;
        });
        res.on("end", () => {
          let data: any = rawJson;
          try {
            data = JSON.parse(rawJson);
          } catch {
            // Leave raw text when response is not JSON
          }
          resolve({ status: res.statusCode ?? 0, rawJson, data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer<T>(
  store: StreamStore,
  redactAddresses: boolean,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const app = createApp(
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { redactAddresses },
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const postGraphQL = (
  port: number,
  queryId: string,
  variables: Record<string, unknown> = {},
) => httpRequest(port, "POST", "/graphql", { queryId, variables, tenant: "privacy-test" });

// ---------------------------------------------------------------------------
// 1. Named rule matrix for `indexer/src/privacy.ts` & `indexer/src/redaction.ts`
// ---------------------------------------------------------------------------

describe("privacy.ts redaction rule matrix", () => {
  const addressRows: Array<{ name: string; input: string | null | undefined; expected: string }> = [
    { name: "full G... Stellar address -> 8-char prefix + ellipsis", input: SENDER_A, expected: "GAAAAAAA..." },
    { name: "full C... contract address -> 8-char prefix + ellipsis", input: TOKEN_ADDR, expected: "CAAAAAAA..." },
    { name: "short string <= 8 chars -> unchanged", input: "SHORT123", expected: "SHORT123" },
    { name: "null address -> unknown", input: null, expected: "unknown" },
    { name: "undefined address -> unknown", input: undefined, expected: "unknown" },
  ];

  for (const row of addressRows) {
    test(`sanitizeAddress: ${row.name}`, () => {
      assert.equal(sanitizeAddress(row.input), row.expected);
    });
  }

  const webhookRows: Array<{ name: string; input: string | null | undefined; expected: string }> = [
    { name: "masks path and query secret to origin/***", input: WEBHOOK_URL, expected: "https://hooks.example.com/***" },
    { name: "invalid URL -> invalid_url", input: "not-a-url", expected: "invalid_url" },
    { name: "null URL -> unknown", input: null, expected: "unknown" },
  ];

  for (const row of webhookRows) {
    test(`sanitizeWebhookUrl: ${row.name}`, () => {
      assert.equal(sanitizeWebhookUrl(row.input), row.expected);
    });
  }

  const emailRows: Array<{ name: string; input: string | null | undefined; expected: string }> = [
    { name: "masks local part and keeps domain", input: "alice@streampay.org", expected: "***@streampay.org" },
    { name: "missing @ -> unknown", input: "not-an-email", expected: "unknown" },
    { name: "null email -> unknown", input: null, expected: "unknown" },
  ];

  for (const row of emailRows) {
    test(`sanitizeEmail: ${row.name}`, () => {
      assert.equal(sanitizeEmail(row.input), row.expected);
    });
  }

  const telegramRows: Array<{ name: string; input: string | number | null | undefined; expected: string }> = [
    { name: "preserves only last 4 digits", input: "987654321", expected: "chat_***4321" },
    { name: "short chat id <= 4 chars -> chat_***", input: "1234", expected: "chat_***" },
    { name: "null chat id -> unknown", input: null, expected: "unknown" },
  ];

  for (const row of telegramRows) {
    test(`sanitizeTelegramChatId: ${row.name}`, () => {
      assert.equal(sanitizeTelegramChatId(row.input), row.expected);
    });
  }

  test("sanitizeError: redacts Stellar secret seeds and Bearer tokens", () => {
    const err = new Error(`Failed with seed ${SECRET_SEED} and header Bearer tok_abc123.xyz==`);
    const out = sanitizeError(err);
    assert.equal(out.includes(SECRET_SEED), false);
    assert.equal(out.includes("tok_abc123"), false);
    assert.match(out, /\[REDACTED_SECRET_KEY\]/);
    assert.match(out, /Bearer \[REDACTED_TOKEN\]/);
  });

  const attributeRows: Array<{
    name: string;
    input: Record<string, unknown>;
    present: Record<string, string | number | boolean>;
    omitted: string[];
  }> = [
    {
      name: "omits financial amount keys (amount, *.amount, balance, deposit, withdrawn)",
      input: {
        amount: "1000",
        "stream.amount": "500",
        account_balance: "9999",
        stream_deposit: "1000",
        withdrawn_total: "250",
        stream_id: "1",
      },
      present: { stream_id: "1" },
      omitted: ["amount", "stream.amount", "account_balance", "stream_deposit", "withdrawn_total"],
    },
    {
      name: "masks address, sender, recipient, wallet keys",
      input: {
        address: SENDER_A,
        sender: SENDER_A,
        recipient: RECIPIENT_A,
        wallet: REFUND_TARGET,
      },
      present: {
        address: "GAAAAAAA...",
        sender: "GAAAAAAA...",
        recipient: "GCCCCCCC...",
        wallet: "GDDDDDDD...",
      },
      omitted: [],
    },
    {
      name: "masks webhook, url, email, telegram, chat_id keys",
      input: {
        webhook_target: WEBHOOK_URL,
        callback_url: WEBHOOK_URL,
        user_email: "bob@example.com",
        telegram_id: "987654321",
        chat_id: "12345678",
      },
      present: {
        webhook_target: "https://hooks.example.com/***",
        callback_url: "https://hooks.example.com/***",
        user_email: "***@example.com",
        telegram_id: "chat_***4321",
        chat_id: "chat_***5678",
      },
      omitted: [],
    },
    {
      name: "masks direct full Stellar address under arbitrary key name",
      input: { arbitrary_field: SENDER_A, ok_flag: true, ledger: 100 },
      present: { arbitrary_field: "GAAAAAAA...", ok_flag: true, ledger: 100 },
      omitted: [],
    },
  ];

  for (const row of attributeRows) {
    test(`sanitizeAttributes: ${row.name}`, () => {
      const out = sanitizeAttributes(row.input);
      for (const [k, v] of Object.entries(row.present)) {
        assert.equal(out[k], v, `expected ${k} to be ${v}`);
      }
      for (const k of row.omitted) {
        assert.equal(k in out, false, `expected ${k} to be omitted`);
      }
    });
  }

  test("redactValue: every ADDRESS_KEYS entry is truncated when enabled and untouched when disabled", () => {
    const sample: Record<string, string> = {};
    for (const key of ADDRESS_KEYS) {
      sample[key] = "GPARTIAL_ADDRESS_VALUE";
    }
    const redacted = redactValue(sample, true) as Record<string, string>;
    const unredacted = redactValue(sample, false) as Record<string, string>;
    for (const key of ADDRESS_KEYS) {
      assert.equal(redacted[key], "GPARTIAL...", `ADDRESS_KEYS.${key} must be truncated`);
      assert.equal(unredacted[key], "GPARTIAL_ADDRESS_VALUE", `ADDRESS_KEYS.${key} must be untouched when disabled`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Exposure Surface 1: Public Listing (API boundary serialized JSON)
// ---------------------------------------------------------------------------

describe("API boundary redaction matrix: public listing", () => {
  test("GetStream (redacted): truncates wallet fields, preserves non-wallet fields, zero full-address leaks in JSON", async () => {
    const store = seedPrivacyStore();
    try {
      await withServer(store, true, async (port) => {
        const res = await postGraphQL(port, "GetStream", { id: "1" });
        assert.equal(res.status, 200);
        const s = res.data.data.stream;

        // Redacted fields
        assert.equal(s.sender, "GAAAAAAA...");
        assert.equal(s.recipient, "GCCCCCCC...");
        assert.equal(s.refundTarget, "GDDDDDDD...");
        assert.equal(s.cancelledBy, "GEEEEEEE...");

        // Non-redacted fields (pinned to current redactStream behavior)
        assert.equal(s.streamId, "1");
        assert.equal(s.token, TOKEN_ADDR);
        assert.equal(s.deposit, "1000");
        assert.equal(s.withdrawn, "250");
        assert.equal(s.startTime, "1000");
        assert.equal(s.endTime, "2000");
        assert.equal(s.status, "cancelled");

        // Wire-level JSON leak check
        for (const leaked of [SENDER_A, RECIPIENT_A, REFUND_TARGET, CANCELLED_BY]) {
          assert.equal(res.rawJson.includes(leaked), false, `serialized JSON leaked ${leaked}`);
        }
      });
    } finally {
      store.close();
    }
  });

  test("GetStream (opt-in unredacted): exposes exact consented wallet fields", async () => {
    const store = seedPrivacyStore();
    try {
      await withServer(store, false, async (port) => {
        const res = await postGraphQL(port, "GetStream", { id: "1" });
        assert.equal(res.status, 200);
        const s = res.data.data.stream;
        assert.equal(s.sender, SENDER_A);
        assert.equal(s.recipient, RECIPIENT_A);
        assert.equal(s.refundTarget, REFUND_TARGET);
        assert.equal(s.cancelledBy, CANCELLED_BY);
        assert.equal(s.token, TOKEN_ADDR);
      });
    } finally {
      store.close();
    }
  });

  test("GetStreamsByRecipient & GetStreamWithRelations (redacted vs opt-in)", async () => {
    const store = seedPrivacyStore();
    try {
      await withServer(store, true, async (port) => {
        const listRes = await postGraphQL(port, "GetStreamsByRecipient", { recipient: RECIPIENT_A, first: 10 });
        assert.equal(listRes.status, 200);
        const node = listRes.data.data.streamsByRecipient.edges[0].node;
        assert.equal(node.sender, "GAAAAAAA...");
        assert.equal(node.recipient, "GCCCCCCC...");
        assert.equal(listRes.rawJson.includes(SENDER_A), false);
        assert.equal(listRes.rawJson.includes(RECIPIENT_A), false);

        const relRes = await postGraphQL(port, "GetStreamWithRelations", { id: "1" });
        assert.equal(relRes.status, 200);
        const rel = relRes.data.data.stream;
        assert.equal(rel.senderAddress.address, "GAAAAAAA...");
        assert.equal(rel.recipientAddress.address, "GCCCCCCC...");
        assert.equal(relRes.rawJson.includes(SENDER_A), false);
        assert.equal(relRes.rawJson.includes(RECIPIENT_A), false);
      });

      await withServer(store, false, async (port) => {
        const relRes = await postGraphQL(port, "GetStreamWithRelations", { id: "1" });
        assert.equal(relRes.status, 200);
        const rel = relRes.data.data.stream;
        assert.equal(rel.senderAddress.address, SENDER_A);
        assert.equal(rel.recipientAddress.address, RECIPIENT_A);
      });
    } finally {
      store.close();
    }
  });

  test("ListWebhookSubscriptions: masks URL when redacted, never leaks secret in either mode", async () => {
    const store = seedPrivacyStore();
    try {
      await withServer(store, true, async (port) => {
        const res = await postGraphQL(port, "ListWebhookSubscriptions", {});
        assert.equal(res.status, 200);
        const sub = res.data.data.webhookSubscriptions[0];
        assert.equal(sub.url, "https://hooks.example.com/***");
        assert.equal("secret" in sub, false);
        assert.equal(res.rawJson.includes("super_secret_token"), false);
        assert.equal(res.rawJson.includes(WEBHOOK_SECRET), false);
      });

      await withServer(store, false, async (port) => {
        const res = await postGraphQL(port, "ListWebhookSubscriptions", {});
        assert.equal(res.status, 200);
        const sub = res.data.data.webhookSubscriptions[0];
        assert.equal(sub.url, WEBHOOK_URL);
        assert.equal("secret" in sub, false);
        assert.equal(res.rawJson.includes(WEBHOOK_SECRET), false);
      });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Exposure Surface 2: Address Reads (API boundary serialized JSON)
// ---------------------------------------------------------------------------

describe("API boundary redaction matrix: address reads", () => {
  test("GraphQL GetAddressStreams (redacted): truncates top-level address and nested stream addresses", async () => {
    const store = seedPrivacyStore();
    try {
      await withServer(store, true, async (port) => {
        const res = await postGraphQL(port, "GetAddressStreams", { address: SENDER_A, first: 10 });
        assert.equal(res.status, 200);
        const addr = res.data.data.address;
        assert.equal(addr.address, "GAAAAAAA...");
        assert.equal(addr.streamCount, 1);
        const streamNode = addr.streams.edges[0].node;
        assert.equal(streamNode.sender, "GAAAAAAA...");
        assert.equal(streamNode.recipient, "GCCCCCCC...");
        assert.equal(res.rawJson.includes(SENDER_A), false);
        assert.equal(res.rawJson.includes(RECIPIENT_A), false);
      });
    } finally {
      store.close();
    }
  });

  test("GraphQL GetAddressStreams (opt-in unredacted): exposes full address and stream parties", async () => {
    const store = seedPrivacyStore();
    try {
      await withServer(store, false, async (port) => {
        const res = await postGraphQL(port, "GetAddressStreams", { address: SENDER_A, first: 10 });
        assert.equal(res.status, 200);
        const addr = res.data.data.address;
        assert.equal(addr.address, SENDER_A);
        const streamNode = addr.streams.edges[0].node;
        assert.equal(streamNode.sender, SENDER_A);
        assert.equal(streamNode.recipient, RECIPIENT_A);
      });
    } finally {
      store.close();
    }
  });

  test("REST GET /address/:addr/streams: pins current unredacted REST default", async () => {
    const store = seedPrivacyStore();
    try {
      await withServer(store, true, async (port) => {
        const res = await httpRequest(port, "GET", `/address/${SENDER_A}/streams`);
        assert.equal(res.status, 200);
        assert.equal(res.data.address, SENDER_A);
        assert.equal(res.data.streams[0].sender, SENDER_A);
        assert.equal(res.data.streams[0].recipient, RECIPIENT_A);
      });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Exposure Surface 3: Event Feed (API boundary serialized JSON)
// ---------------------------------------------------------------------------

describe("API boundary redaction matrix: event feed", () => {
  const eventSurfaceQueries: Array<{ name: string; queryId: string; rootField: string }> = [
    { name: "GetStreamHistory", queryId: "GetStreamHistory", rootField: "streamHistory" },
    { name: "GetStreamEvents (outbox)", queryId: "GetStreamEvents", rootField: "streamEvents" },
  ];

  for (const surface of eventSurfaceQueries) {
    test(`GraphQL ${surface.name} (redacted): redacts all ADDRESS_KEYS & full addresses in payload, keeps amounts/timestamps`, async () => {
      const store = seedPrivacyStore();
      try {
        await withServer(store, true, async (port) => {
          const res = await postGraphQL(port, surface.queryId, { streamId: "1", first: 20 });
          assert.equal(res.status, 200);
          const nodes = res.data.data[surface.rootField].edges.map((e: any) => e.node);
          assert.equal(nodes.length, 4);

          const created = nodes.find((n: any) => n.eventType === "stream_created");
          assert.equal(created.payload.sender, "GAAAAAAA...");
          assert.equal(created.payload.recipient, "GCCCCCCC...");
          // Pinned code behavior: `token` is in ADDRESS_KEYS so event payloads redact it.
          assert.equal(created.payload.token, "CAAAAAAA...");
          assert.equal(created.payload.deposit, "1000");
          assert.equal(created.payload.cancelable, true);

          const targetChanged = nodes.find((n: any) => n.eventType === "refund_target_changed");
          assert.equal(targetChanged.payload.new_target, "GDDDDDDD...");
          assert.equal(targetChanged.payload.changed_by, "GAAAAAAA...");

          const cancelled = nodes.find((n: any) => n.eventType === "stream_cancelled");
          assert.equal(cancelled.payload.cancelled_by, "GEEEEEEE...");

          // Wire-level JSON leak check across all 4 events
          for (const leaked of [SENDER_A, RECIPIENT_A, REFUND_TARGET, CANCELLED_BY, TOKEN_ADDR]) {
            assert.equal(res.rawJson.includes(leaked), false, `${surface.name} leaked ${leaked}`);
          }
        });
      } finally {
        store.close();
      }
    });

    test(`GraphQL ${surface.name} (opt-in unredacted): exposes full addresses in payload`, async () => {
      const store = seedPrivacyStore();
      try {
        await withServer(store, false, async (port) => {
          const res = await postGraphQL(port, surface.queryId, { streamId: "1", first: 20 });
          assert.equal(res.status, 200);
          const nodes = res.data.data[surface.rootField].edges.map((e: any) => e.node);
          const created = nodes.find((n: any) => n.eventType === "stream_created");
          assert.equal(created.payload.sender, SENDER_A);
          assert.equal(created.payload.recipient, RECIPIENT_A);
          assert.equal(created.payload.token, TOKEN_ADDR);
        });
      } finally {
        store.close();
      }
    });
  }
});
