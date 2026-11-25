import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { GET } from "../app/api/stream-events/route.ts";

describe("GET /api/stream-events Route Handler", () => {
  const validAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
  const otherAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";

  it("rejects requests missing address query parameter with 400", async () => {
    const req = new Request("http://localhost:3000/api/stream-events");
    const res = await GET(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Missing required 'address' query parameter/);
  });

  it("rejects invalid Stellar address format with 400", async () => {
    const req = new Request("http://localhost:3000/api/stream-events?address=invalid-addr");
    const res = await GET(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Invalid Stellar address format/);
  });

  it("rejects non-numeric streamId with 400", async () => {
    const req = new Request(`http://localhost:3000/api/stream-events?address=${validAddr}&streamId=abc`);
    const res = await GET(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /streamId must be an unsigned integer/);
  });

  it("enforces auth header scoping mismatch with 403", async () => {
    const req = new Request(`http://localhost:3000/api/stream-events?address=${validAddr}`, {
      headers: { "x-user-address": otherAddr },
    });
    const res = await GET(req);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Forbidden: address scope mismatch/);
  });

  it("proxies upstream indexer SSE feed with correct headers", async () => {
    // Start a mock indexer HTTP server
    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      assert.equal(url.pathname, "/events/stream");
      assert.equal(url.searchParams.get("address"), validAddr);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": ok\n\n");
      res.write('id: evt-1\nevent: stream_created\ndata: {"id":"evt-1","streamId":"1"}\n\n');
      res.end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, resolve));
    const port = (mockServer.address() as { port: number }).port;
    const oldIndexerUrl = process.env.INDEXER_URL;
    process.env.INDEXER_URL = `http://127.0.0.1:${port}`;

    try {
      const req = new Request(`http://localhost:3000/api/stream-events?address=${validAddr}`);
      const res = await GET(req);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
      assert.equal(res.headers.get("x-accel-buffering"), "no");

      // Verify streamed content
      const text = await res.text();
      assert.match(text, /id: evt-1/);
      assert.match(text, /event: stream_created/);
    } finally {
      process.env.INDEXER_URL = oldIndexerUrl;
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  it("gracefully returns 503 when indexer service is unreachable", async () => {
    const oldIndexerUrl = process.env.INDEXER_URL;
    process.env.INDEXER_URL = "http://127.0.0.1:59999"; // Non-existent port

    try {
      const req = new Request(`http://localhost:3000/api/stream-events?address=${validAddr}`);
      const res = await GET(req);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "5");
      const body = await res.json();
      assert.match(body.error, /Failed to connect to indexer event feed/);
    } finally {
      process.env.INDEXER_URL = oldIndexerUrl;
    }
  });
});
