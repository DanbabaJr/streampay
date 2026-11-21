import assert from "node:assert/strict";
import { test } from "node:test";

import { subscribeEvents } from "../src/subscription.js";

function response(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

test("replays feed events from the supplied cursor", async () => {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return response('id: evt-2\ndata: {"id":"evt-2","streamId":"7","eventType":"stream_created","ledger":12,"ledgerClosedAt":"2026-01-01T00:00:00Z","data":{"deposit":"10"}}\n\n');
  };
  const iterator = subscribeEvents(7n, {
    eventFeedUrl: "https://indexer.example/events/stream",
    fromCursor: "evt-1",
    fetch,
    initialBackoffMs: 0,
  });

  const event = await iterator.next();
  assert.equal(event.done, false);
  assert.equal(event.value?.type, "StreamCreated");
  assert.equal(event.value?.cursor, "evt-2");
  assert.equal(requests[0]?.headers.get("last-event-id"), "evt-1");
  assert.equal(new URL(requests[0]!.url).searchParams.get("streamId"), "7");
  await iterator.return(undefined);
});

test("resumes after a mid-stream failure using the most recently received cursor", async () => {
  const cursors: Array<string | null> = [];
  const errors: unknown[] = [];
  let call = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    cursors.push(new Headers(init?.headers).get("last-event-id"));
    call += 1;
    if (call === 1) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'id: evt-10\ndata: {"id":"evt-10","streamId":"7","eventType":"withdrawn","ledger":13,"ledgerClosedAt":"2026-01-01T00:00:00Z","data":{"amount":"1"}}\n\n'
          ));
          setTimeout(() => controller.error(new Error("connection interrupted")), 10);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return response('id: evt-11\ndata: {"id":"evt-11","streamId":"7","eventType":"withdrawn","ledger":14,"ledgerClosedAt":"2026-01-01T00:00:01Z","data":{"amount":"2"}}\n\n');
  };
  const iterator = subscribeEvents("7", {
    eventFeedUrl: "https://indexer.example/events/stream",
    fromCursor: "evt-9",
    fetch,
    initialBackoffMs: 0,
    onError: (error) => errors.push(error),
  });

  const first = await iterator.next();
  assert.equal(first.value?.cursor, "evt-10");
  const second = await iterator.next();
  assert.equal(second.value?.cursor, "evt-11");
  assert.deepEqual(cursors, ["evt-9", "evt-10"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /connection interrupted/);
  await iterator.return(undefined);
});

test("abort signal ends the subscription cleanly", async () => {
  const controller = new AbortController();
  const fetch = async () => new Response(new ReadableStream<Uint8Array>(), {
    headers: { "content-type": "text/event-stream" },
  });
  const iterator = subscribeEvents(7, {
    eventFeedUrl: "https://indexer.example/events/stream",
    fetch,
    signal: controller.signal,
  });

  const pending = iterator.next();
  controller.abort();
  assert.deepEqual(await pending, { done: true, value: undefined });
});

test("unknown event names are skipped according to the generated decoder policy", async () => {
  const controller = new AbortController();
  let requestCount = 0;
  const cursors: Array<string | null> = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    cursors.push(new Headers(init?.headers).get("last-event-id"));
    if (requestCount === 1) {
      return response('id: evt-unknown\ndata: {"id":"evt-unknown","streamId":"7","eventType":"future_event","ledger":1,"ledgerClosedAt":"2026-01-01T00:00:00Z","data":{}}\n\n');
    }
    controller.abort();
    return response("");
  };
  const iterator = subscribeEvents(7, {
    eventFeedUrl: "https://indexer.example/events/stream",
    fetch,
    signal: controller.signal,
    initialBackoffMs: 0,
  });

  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(requestCount, 2);
  assert.deepEqual(cursors, [null, "evt-unknown"]);
});
