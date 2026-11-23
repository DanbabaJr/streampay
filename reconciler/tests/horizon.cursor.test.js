import test from "node:test";
import assert from "node:assert/strict";
import { HorizonReader } from "../dist/readers/horizon.js";
import { HttpError } from "../dist/http.js";

function page(records, cursor) {
  return {
    _embedded: { records },
    _links: cursor
      ? { next: { href: `https://horizon.test/effects?cursor=${cursor}&limit=2&order=asc` } }
      : {},
  };
}

function record(id, pagingToken) {
  return { id, paging_token: pagingToken };
}

function cursorFrom(url) {
  return new URL(url).searchParams.get("cursor");
}

function mockHttpAgent(get) {
  return {
    async get(url, headers) {
      const response = await get(url, headers);
      return {
        status: response.status,
        data: await response.json(),
        headers: {},
      };
    },
    async post() {
      throw new Error("Unexpected POST request");
    },
  };
}

function createReader(httpAgent) {
  return new HorizonReader({
    url: "https://horizon.test",
    pollIntervalMs: 0,
    retryDelayMs: 0,
    httpAgent,
  });
}

test("Horizon cursor walk completes across multiple pages without duplicates", async () => {
  const requests = [];
  const httpAgent = mockHttpAgent(async (url) => {
    requests.push(url);
    const cursor = cursorFrom(url);
    if (cursor === "0") {
      return Response.json(page([record("a", "1"), record("b", "2")], "2"));
    }
    if (cursor === "2") {
      return Response.json(page([record("c", "3"), record("d", "4")], "4"));
    }
    return Response.json(page([record("e", "5")]));
  });
  const reader = createReader(httpAgent);
  const records = await reader.readRecords("/effects", 2);
  const ids = records.map(item => item.id);

  assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
  assert.equal(records.length, 5);
  assert.equal(new Set(ids).size, ids.length);

  assert.deepEqual(requests.map(cursorFrom), ["0", "2", "4"]);
});

test("Horizon cursor walk terminates on an empty page", async () => {
  const requests = [];
  const httpAgent = mockHttpAgent(async (url) => {
    requests.push(url);
    return Response.json(page([]));
  });
  const reader = createReader(httpAgent);
  const records = await reader.readRecords("/effects", 2);

  assert.deepEqual(records, []);
  assert.equal(requests.length, 1);
});

test("Horizon retry 429 mid-walk resumes from the last successful cursor", async () => {
  const requests = [];
  let cursorTwoAttempts = 0;
  const httpAgent = mockHttpAgent(async (url) => {
    requests.push(url);
    const cursor = cursorFrom(url);
    if (cursor === "0") {
      return Response.json(page([record("a", "1"), record("b", "2")], "2"));
    }
    if (cursor === "2") {
      cursorTwoAttempts++;
      if (cursorTwoAttempts === 1) return Response.json({}, { status: 429 });
      return Response.json(page([record("c", "3"), record("d", "4")], "4"));
    }
    return Response.json(page([record("e", "5")]));
  });
  const reader = createReader(httpAgent);
  const records = await reader.readRecords("/effects", 2);

  assert.deepEqual(records.map(item => item.id), ["a", "b", "c", "d", "e"]);
  const cursors = requests.map(cursorFrom);
  assert.deepEqual(cursors, ["0", "2", "2", "4"]);
  assert.equal(cursors.filter(cursor => cursor === "0").length, 1);
});

test("Horizon retry 5xx mid-walk resumes from the last successful cursor", async () => {
  const requests = [];
  let cursorTwoAttempts = 0;
  const httpAgent = mockHttpAgent(async (url) => {
    requests.push(url);
    const cursor = cursorFrom(url);
    if (cursor === "0") {
      return Response.json(page([record("a", "1"), record("b", "2")], "2"));
    }
    if (cursor === "2") {
      cursorTwoAttempts++;
      if (cursorTwoAttempts === 1) return Response.json({}, { status: 503 });
      return Response.json(page([record("c", "3"), record("d", "4")], "4"));
    }
    return Response.json(page([record("e", "5")]));
  });
  const reader = createReader(httpAgent);
  const records = await reader.readRecords("/effects", 2);

  assert.deepEqual(records.map(item => item.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(requests.map(cursorFrom), ["0", "2", "2", "4"]);
});

test("Horizon retry exhaustion throws the final HTTP error", async () => {
  const requests = [];
  const httpAgent = mockHttpAgent(async (url) => {
    requests.push(url);
    return Response.json({}, { status: 503 });
  });
  const reader = new HorizonReader({
    url: "https://horizon.test",
    pollIntervalMs: 0,
    maxAttempts: 3,
    retryDelayMs: 0,
    httpAgent,
  });

  await assert.rejects(
    () => reader.readRecords("/effects", 2),
    error => error instanceof HttpError && error.status === 503,
  );

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(cursorFrom), ["0", "0", "0"]);
});

test("Horizon cursor walk handles a truncated final page", async () => {
  const requests = [];
  const httpAgent = mockHttpAgent(async (url) => {
    requests.push(url);
    const cursor = cursorFrom(url);
    if (cursor === "0") {
      return Response.json(page([record("a", "1"), record("b", "2")], "2"));
    }
    return Response.json(page([record("c", "3")], "4"));
  });
  const reader = createReader(httpAgent);
  const records = await reader.readRecords("/effects", 2);

  assert.deepEqual(records.map(item => item.id), ["a", "b", "c"]);
  assert.deepEqual(requests.map(cursorFrom), ["0", "2"]);
});

test("Horizon cursor walk preserves cross-page ordering", async () => {
  const httpAgent = mockHttpAgent(async (url) => {
    const cursor = cursorFrom(url);
    if (cursor === "0") {
      return Response.json(page([record("1", "10"), record("2", "20")], "20"));
    }
    return Response.json(page([{ id: "3" }, { id: "4" }]));
  });
  const reader = createReader(httpAgent);
  const records = await reader.readRecords("/effects", 2);

  assert.deepEqual(records.map(item => item.id), ["1", "2", "3", "4"]);
});
