import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeEvent } from "./decoder.js";
import { StreamStore } from "./store.js";
import type { RpcEvent } from "./types.js";

test("decodes the RPC fixture using Soroban ScVal XDR", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/stream-created.json", import.meta.url), "utf8")) as RpcEvent;
  const result = decodeEvent(fixture);
  assert.equal(result.name, "stream_created");
  assert.equal(result.streamId, "7");
  assert.equal(result.data.sender, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
  assert.equal(result.data.deposit, 1000000n);

  const store = new StreamStore(":memory:");
  store.ingestPage([result], result.pagingToken, result.ledger);
  assert.equal(store.getStream("7")?.sender, result.data.sender);
  assert.equal(store.getStream("7")?.deposit, "1000000");
  assert.equal(store.getState("cursor"), result.pagingToken);
  store.close();
});
