import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { describe, it } from "node:test";
import { decodeEvent, DecodeError } from "./decoder.js";
import { StreamStore } from "./store.js";
import type { RpcEvent } from "./types.js";
import {
  buildCorruptCorpus,
  generateTruncatedXdrFixtures,
  generateWrongTypeFieldFixtures,
  generateUnknownTopicFixtures,
  generateSchemaViolationFixtures,
  type CorruptTestCase,
} from "./corrupt-fixtures.js";

test("decodes the RPC fixture using Soroban ScVal XDR", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/stream-created.json", import.meta.url), "utf8")
  ) as RpcEvent;
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

describe("Negative Fixtures: Soroban ScVal decoding suite (issue #486)", () => {
  describe("1. Truncated & Malformed XDR", () => {
    const fixtures = generateTruncatedXdrFixtures();
    for (const tc of fixtures) {
      it(`rejects ${tc.name} with TRUNCATED_XDR`, () => {
        let threw = false;
        try {
          decodeEvent(tc.event);
        } catch (err) {
          threw = true;
          assert.ok(err instanceof DecodeError, `Expected DecodeError, got ${err}`);
          assert.equal(err.code, "TRUNCATED_XDR");
          if (tc.expectedField) {
            assert.ok(
              err.field === tc.expectedField || err.message.includes(tc.expectedField),
              `Expected error to reference field "${tc.expectedField}", got "${err.field}" (${err.message})`
            );
          }
        }
        assert.ok(threw, `Expected decodeEvent to throw for ${tc.name}`);
      });
    }
  });

  describe("2. Wrong-type ScVals for each event field", () => {
    const fixtures = generateWrongTypeFieldFixtures();
    for (const tc of fixtures) {
      it(`rejects ${tc.name} with INVALID_TYPE`, () => {
        let threw = false;
        try {
          decodeEvent(tc.event);
        } catch (err) {
          threw = true;
          assert.ok(err instanceof DecodeError, `Expected DecodeError, got ${err}`);
          assert.equal(err.code, "INVALID_TYPE");
          if (tc.expectedField) {
            assert.ok(
              err.field === tc.expectedField || err.message.includes(tc.expectedField),
              `Expected error to reference field "${tc.expectedField}", got "${err.field}" (${err.message})`
            );
          }
        }
        assert.ok(threw, `Expected decodeEvent to throw for ${tc.name}`);
      });
    }
  });

  describe("3. Unknown event topics", () => {
    const fixtures = generateUnknownTopicFixtures();
    for (const tc of fixtures) {
      it(`rejects ${tc.name} with structured error (${tc.expectedErrorCode})`, () => {
        let threw = false;
        try {
          decodeEvent(tc.event);
        } catch (err) {
          threw = true;
          assert.ok(err instanceof DecodeError, `Expected DecodeError, got ${err}`);
          assert.equal(err.code, tc.expectedErrorCode);
        }
        assert.ok(threw, `Expected decodeEvent to throw for ${tc.name}`);
      });
    }
  });

  describe("4. Schema violations (schemas/events/v1/)", () => {
    const fixtures = generateSchemaViolationFixtures();
    for (const tc of fixtures) {
      it(`rejects ${tc.name} with structured error (${tc.expectedErrorCode})`, () => {
        let threw = false;
        try {
          decodeEvent(tc.event);
        } catch (err) {
          threw = true;
          assert.ok(err instanceof DecodeError, `Expected DecodeError, got ${err}`);
          assert.equal(err.code, tc.expectedErrorCode);
          if (tc.expectedField) {
            assert.ok(
              err.field === tc.expectedField || err.message.includes(tc.expectedField),
              `Expected error to reference field "${tc.expectedField}", got "${err.field}" (${err.message})`
            );
          }
        }
        assert.ok(threw, `Expected decodeEvent to throw for ${tc.name}`);
      });
    }
  });

  describe("5. Complete corrupt corpus fail-closed assertions", () => {
    const corpus = buildCorruptCorpus();
    assert.ok(corpus.length >= 20, `Expected rich corpus, got ${corpus.length} cases`);

    it("never emits a half-decoded event or crashes unhandled", () => {
      for (const tc of corpus) {
        let result: unknown = null;
        let threwStructured = false;

        try {
          result = decodeEvent(tc.event);
        } catch (err) {
          if (err instanceof DecodeError) {
            threwStructured = true;
            assert.equal(
              err.code,
              tc.expectedErrorCode,
              `Fixture ${tc.id}: expected code ${tc.expectedErrorCode}, got ${err.code}`
            );
          } else {
            assert.fail(`Fixture ${tc.id} threw non-structured error: ${err}`);
          }
        }

        assert.equal(
          result,
          null,
          `Fixture ${tc.id} unexpectedly returned half-decoded event instead of failing closed`
        );
        assert.ok(
          threwStructured,
          `Fixture ${tc.id} did not throw structured DecodeError`
        );
      }
    });
  });
});