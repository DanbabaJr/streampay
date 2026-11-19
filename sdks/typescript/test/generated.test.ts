import assert from "node:assert/strict";
import { test } from "node:test";

import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import {
  decodeCreateStreamsBatchResult,
  decodeGovernanceAction,
  encodeGovernanceAction,
  encodeGovernanceProposeArgs,
  type GovernanceAction,
  decodeIntentStatus,
  decodeStreamPayEvent,
  addressToScVal,
  decodeOracleConfig,
  decodeScheduledIntent,
  decodeStream,
  decodeStreamInput,
  decodeStreamStatus,
  decodeTreasuryStatus,
  encodeCreateStreamWithOracleArgs,
  encodeCreateStreamsArgs,
  encodeIntentStatus,
  encodeOracleConfig,
  encodeScheduledIntent,
  encodeSponsoredWithdrawArgs,
  encodeStream,
  encodeStreamStatus,
  encodeTreasuryStatus,
  type OracleConfig,
  type ScheduledIntent,
  type Stream,
  type StreamInput,
  type TreasuryStatus,
} from "../src/generated.js";

const SENDER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const RECIPIENT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
const GOVERNOR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";
const TOKEN = "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL";

test("Stream round-trips through its ScVal codec, including use_oracle", () => {
  const stream: Stream = {
    id: 1n,
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    deposit: 10_000_000_000n,
    withdrawn: 25n,
    startTime: 0n,
    endTime: 3_155_760_000n,
    cancelable: true,
    status: "Depleted",
    useOracle: true,
  };
  assert.deepEqual(decodeStream(scValToNative(encodeStream(stream))), stream);
});

test("Stream.use_oracle is Option<bool>: legacy records decode to null, new ones keep Some(bool)", () => {
  const stream: Stream = {
    id: 1n,
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    deposit: 100n,
    withdrawn: 0n,
    startTime: 0n,
    endTime: 1000n,
    cancelable: false,
    status: "Active",
    useOracle: false,
  };
  const entries = (scVal: xdr.ScVal): xdr.ScMapEntry[] => {
    if (!("map" in scVal) || !Array.isArray(scVal.map)) throw new Error("expected an ScVal map");
    return scVal.map;
  };
  const keyOf = (item: xdr.ScMapEntry) => scValToNative(item.key) as string;
  const wire = (scVal: xdr.ScVal) => scVal.toXDR("base64");
  const entry = (scVal: xdr.ScVal, key: string) =>
    entries(scVal).find((item) => keyOf(item) === key)!.val;

  // Every stream this contract build writes stores Some(_): still a bare
  // ScVal::Bool on the wire, never void.
  const current = encodeStream(stream);
  assert.equal(wire(entry(current, "use_oracle")), wire(xdr.ScVal.scvBool(false)));
  assert.deepEqual(decodeStream(scValToNative(current)), stream);

  // None encodes as ScVal::Void and decodes back to null.
  const none = encodeStream({ ...stream, useOracle: null });
  assert.equal(wire(entry(none, "use_oracle")), wire(xdr.ScVal.scvVoid()));
  assert.equal(decodeStream(scValToNative(none)).useOracle, null);

  // A pre-oracle (v0.3.0) record has no `use_oracle` key at all.
  const legacy = xdr.ScVal.scvMap(
    entries(current).filter((item) => keyOf(item) !== "use_oracle")
  );
  assert.equal(decodeStream(scValToNative(legacy)).useOracle, null);
});

test("enum codecs cover every declared case", () => {
  for (const value of ["Active", "Cancelled", "Depleted"] as const) {
    assert.equal(decodeStreamStatus(scValToNative(encodeStreamStatus(value))), value);
  }
  for (const value of ["Pending", "Executed", "Cancelled", "Expired"] as const) {
    assert.equal(decodeIntentStatus(scValToNative(encodeIntentStatus(value))), value);
  }
});

test("optional fields decode to null and back", () => {
  const status: TreasuryStatus = {
    token: TOKEN,
    governor: GOVERNOR,
    pendingGovernor: null,
    feeBps: 100,
    maxFeeBps: 100,
    chargedTotal: 12n,
    withdrawnTotal: 2n,
    collectible: 10n,
  };
  assert.deepEqual(decodeTreasuryStatus(scValToNative(encodeTreasuryStatus(status))), status);
});

test("vectors, bytes and nested enums round-trip", () => {
  const intent: ScheduledIntent = {
    id: 7n,
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    deposit: 100n,
    startTime: 10n,
    endTime: 20n,
    cancelable: true,
    interval: 5n,
    occurrencesTotal: 2,
    occurrencesRemaining: 1,
    feeBudget: 3n,
    executeAfter: 9n,
    expiresAt: 99n,
    paramsHash: new Uint8Array(32).fill(0xab),
    status: "Pending",
  };
  assert.deepEqual(decodeScheduledIntent(scValToNative(encodeScheduledIntent(intent))), intent);

  const config: OracleConfig = {
    publishers: [SENDER, RECIPIENT],
    threshold: 2,
    maxStaleSeconds: 3600n,
  };
  assert.deepEqual(decodeOracleConfig(scValToNative(encodeOracleConfig(config))), config);
});

test("create_streams encodes a vec of StreamInput structs", () => {
  const input: StreamInput = {
    recipient: RECIPIENT,
    token: TOKEN,
    depositAmount: 5n,
    startTime: 1n,
    endTime: 2n,
    cancelable: false,
  };
  const encoded = encodeCreateStreamsArgs({ sender: SENDER, inputs: [input] });
  assert.equal(encoded.length, 2);
  const native = scValToNative(encoded[1]!);
  assert.deepEqual(decodeStreamInput((native as unknown[])[0]), input);
});

test("create_stream_with_oracle carries use_oracle as its final argument", () => {
  const encoded = encodeCreateStreamWithOracleArgs({
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    depositAmount: 10n,
    startTime: 0n,
    endTime: 100n,
    cancelable: true,
    useOracle: true,
  });
  assert.equal(encoded.length, 8);
  assert.equal(scValToNative(encoded[7]!), true);
});

test("sponsored_withdraw accepts 64-byte signatures", () => {
  const signature = new Uint8Array(64).fill(1);
  const encoded = encodeSponsoredWithdrawArgs({
    sponsor: SENDER,
    beneficiary: RECIPIENT,
    streamId: 1n,
    amount: 2n,
    nonce: 3n,
    deadline: 4n,
    operatorSig: signature,
    beneficiarySig: signature,
  });
  assert.equal(encoded.length, 8);
  assert.deepEqual(scValToNative(encoded[6]!), signature);
});

test("decodes multi-topic events and events with no data fields", () => {
  const contractId = new Uint8Array(32).fill(9);
  const oracleEvent = {
    type: { name: "contract" },
    contractId: { value: contractId },
    body: {
      v0: {
        topics: [
          xdr.ScVal.scvSymbol("oracle_time_reported"),
          addressToScVal(GOVERNOR),
        ],
        data: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("ledger_time"),
            val: nativeToScVal(42n, { type: "u64" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("reported_time"),
            val: nativeToScVal(41n, { type: "u64" }),
          }),
        ]),
      },
    },
  } as unknown as xdr.ContractEvent;

  const decoded = decodeStreamPayEvent(oracleEvent);
  assert.equal(decoded?.type, "OracleTimeReported");
  if (decoded?.type !== "OracleTimeReported") throw new Error("wrong event type");
  assert.equal(decoded.publisher, GOVERNOR);
  assert.equal(decoded.reportedTime, 41n);
  assert.equal(decoded.ledgerTime, 42n);

  const handoffEvent = {
    type: { name: "contract" },
    contractId: { value: contractId },
    body: {
      v0: {
        topics: [
          xdr.ScVal.scvSymbol("policy_handoff_accepted"),
          addressToScVal(GOVERNOR),
        ],
        data: xdr.ScVal.scvMap([]),
      },
    },
  } as unknown as xdr.ContractEvent;
  const handoff = decodeStreamPayEvent(handoffEvent);
  assert.equal(handoff?.type, "PolicyHandoffAccepted");
  if (handoff?.type !== "PolicyHandoffAccepted") throw new Error("wrong event type");
  assert.equal(handoff.newAdmin, GOVERNOR);
});

test("batch results decode Ok values and contract errors per entry", () => {
  const value = xdr.ScVal.scvVec([
    nativeToScVal(5n, { type: "u64" }),
    xdr.ScVal.scvError(xdr.ScError.sceContract(5)),
  ]);
  assert.deepEqual(decodeCreateStreamsBatchResult(value), [
    { ok: 5n },
    { error: "StreamNotActive" },
  ]);
});

test("unit enums use Soroban's Vec[Symbol] wire form", () => {
  const encoded = encodeStreamStatus("Cancelled");
  const expected = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Cancelled")]);
  assert.equal(encoded.toXDR("base64"), expected.toXDR("base64"));
  // What the contract stores and what scValToNative yields for it.
  assert.equal(decodeStreamStatus(["Cancelled"]), "Cancelled");
  assert.throws(() => decodeStreamStatus(1));
});

test("payload enums encode as [Symbol(variant), payload...] and round-trip", () => {
  const cases: GovernanceAction[] = [
    { variant: "SetFeeBps", payload: [25] },
    { variant: "SetFrozen", payload: [true] },
    { variant: "WithdrawTreasury", payload: [TOKEN, RECIPIENT, 5n] },
    { variant: "ExecuteUpgrade", payload: [] },
    { variant: "SetSigners", payload: [[SENDER, RECIPIENT]] },
    {
      variant: "SetStreamPolicy",
      payload: [
        null,
        { minRate: 1n, maxRate: 10n, minDeposit: 100n, minDuration: 60n, maxDuration: 3600n },
      ],
    },
  ];
  for (const action of cases) {
    assert.deepEqual(decodeGovernanceAction(scValToNative(encodeGovernanceAction(action))), action);
  }
  const fee = encodeGovernanceAction({ variant: "SetFeeBps", payload: [25] });
  const expected = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("SetFeeBps"),
    nativeToScVal(25, { type: "u32" }),
  ]);
  assert.equal(fee.toXDR("base64"), expected.toXDR("base64"));
  const args = encodeGovernanceProposeArgs({
    caller: SENDER,
    action: { variant: "ExecuteUpgrade", payload: [] },
  });
  assert.equal(args.length, 2);
  assert.equal(
    args[1]!.toXDR("base64"),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("ExecuteUpgrade")]).toXDR("base64")
  );
});
