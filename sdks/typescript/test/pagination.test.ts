import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_PAGE_SIZE } from "../src/generated.js";
import { collectPages } from "../src/pagination.js";

test("collectPages follows pages to a short page", async () => {
  const offsets: number[] = [];
  const result = await collectPages(async (offset) => {
    offsets.push(offset);
    if (offset === 0) return Array.from({ length: MAX_PAGE_SIZE }, (_, i) => String(i));
    if (offset === MAX_PAGE_SIZE) return ["last"];
    return [];
  });

  assert.equal(result.length, MAX_PAGE_SIZE + 1);
  assert.deepEqual(offsets, [0, MAX_PAGE_SIZE]);
});

test("collectPages clamps the page size to the contract's MAX_PAGE_SIZE", async () => {
  const limits: number[] = [];
  await collectPages(async (_offset, limit) => {
    limits.push(limit);
    return [];
  }, MAX_PAGE_SIZE * 4);

  assert.deepEqual(limits, [MAX_PAGE_SIZE]);
});

test("collectPages stops on a single short page", async () => {
  const result = await collectPages(async () => ["only"]);
  assert.deepEqual(result, ["only"]);
});
