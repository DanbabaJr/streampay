/**
 * Route identity resolution (issue #506).
 *
 * The pages must answer three different questions — is this identifier well
 * formed, does the entity exist, and does a valid entity still resolve — and
 * they must not collapse a transport failure into "missing". These tests pin
 * the decision the route makes; rendering is covered by the production build.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isStellarAddress,
  isStreamId,
  resolveAddress,
  resolvePaymentRef,
  resolveStream,
} from "./route-identity.ts";

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const BAD_CHECKSUM = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHG";

describe("stream ids", () => {
  it("accepts decimal u64 values", () => {
    assert.equal(isStreamId("0"), true);
    assert.equal(isStreamId("42"), true);
    assert.equal(isStreamId("18446744073709551615"), true);
  });

  it("rejects malformed ids", () => {
    for (const value of ["", "abc", "-1", "1.5", "0x10", " 42", "42 ", "18446744073709551616"]) {
      assert.equal(isStreamId(value), false, value);
    }
  });
});

describe("stellar addresses", () => {
  it("accepts a checksum-valid public key", () => {
    assert.equal(isStellarAddress(VALID_ADDRESS), true);
  });

  it("rejects wrong length, alphabet and checksum", () => {
    assert.equal(isStellarAddress("GABC"), false);
    assert.equal(isStellarAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"), false);
    assert.equal(isStellarAddress(BAD_CHECKSUM), false);
  });
});

describe("resolveStream", () => {
  it("marks a malformed id without calling the loader", async () => {
    const resolved = await resolveStream("not-an-id", async () => {
      throw new Error("loader must not run for malformed input");
    });
    assert.equal(resolved.status, "malformed");
  });

  it("marks a well-formed but absent stream as missing", async () => {
    const resolved = await resolveStream("42", async () => null);
    assert.equal(resolved.status, "missing");
  });

  it("returns the stream when it exists", async () => {
    const stream = { id: "42" };
    const resolved = await resolveStream("42", async () => stream);
    assert.deepEqual(resolved, { status: "ok", value: stream });
  });

  it("does not hide a loader failure as a missing entity", async () => {
    await assert.rejects(
      resolveStream("42", async () => {
        throw new Error("RPC unavailable");
      }),
      /RPC unavailable/
    );
  });
});

describe("resolveAddress", () => {
  it("marks a malformed address", () => {
    assert.equal(resolveAddress("GABC").status, "malformed");
  });

  it("accepts a well-formed address", () => {
    assert.deepEqual(resolveAddress(VALID_ADDRESS), {
      status: "ok",
      value: VALID_ADDRESS,
    });
  });
});

describe("resolvePaymentRef", () => {
  const decoded = { streamId: "7" };

  it("marks an undecodable reference as malformed", async () => {
    const resolved = await resolvePaymentRef(
      "garbage",
      async () => null,
      async () => {
        throw new Error("loader must not run for malformed input");
      }
    );
    assert.equal(resolved.status, "malformed");
  });

  it("marks a decoded but absent stream as missing", async () => {
    const resolved = await resolvePaymentRef(
      "ref",
      async () => decoded,
      async () => null
    );
    assert.equal(resolved.status, "missing");
  });

  it("returns the stream for a valid reference", async () => {
    const stream = { id: "7" };
    const resolved = await resolvePaymentRef(
      "ref",
      async () => decoded,
      async () => stream
    );
    assert.deepEqual(resolved, { status: "ok", value: stream });
  });
});
