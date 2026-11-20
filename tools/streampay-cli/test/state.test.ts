import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalStreamState,
  decodeStreamState,
  streamStatesEqual,
} from "../src/state.ts";

const base = {
  id: 7n,
  sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  token: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  deposit: 1_000n,
  withdrawn: 250n,
  start_time: 1_700_000_000n,
  end_time: 1_700_086_400n,
  cancelable: true,
  status: "Active",
};

test("decoded state ignores RPC/ledger noise when comparing", () => {
  const first = decodeStreamState({ ...base, latest_ledger: 100, ledger_timestamp: 1_700_000_100 });
  const second = decodeStreamState({ ...base, latest_ledger: 101, ledger_timestamp: 1_700_000_105 });
  assert.equal(canonicalStreamState(first), canonicalStreamState(second));
  assert.ok(streamStatesEqual(first, second));
});

test("decoded state changes when an on-chain field changes", () => {
  const before = decodeStreamState(base);
  const after = decodeStreamState({ ...base, withdrawn: 251n });
  assert.notEqual(canonicalStreamState(before), canonicalStreamState(after));
  assert.equal(after.withdrawn, "251");
});

test("decode rejects a missing or malformed stream", () => {
  assert.throws(() => decodeStreamState(null), /no stream state/);
  assert.throws(() => decodeStreamState({ ...base, deposit: "lots" }), /invalid deposit/);
  assert.throws(() => decodeStreamState({ ...base, status: "" }), /invalid status/);
});
