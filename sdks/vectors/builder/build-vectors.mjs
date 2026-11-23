#!/usr/bin/env node
/**
 * Builds sdks/vectors/*.json — the cross-language conformance fixtures.
 *
 * Sources of truth:
 *   * event payloads: copied verbatim from the contract's own test snapshots
 *     (contracts/streaming-payments/test_snapshots), re-encoded to
 *     ContractEvent XDR
 *   * transaction envelopes: real signed Soroban invoke envelopes built with
 *     @stellar/stellar-sdk from the spec's argument list
 *   * results: ScVal values encoded from the function's return type; struct
 *     results (get_stream) are copied from a contract-data ledger entry in the
 *     same snapshots
 *   * error codes: looked up by name in the canonical catalog
 *     (frontend/lib/errors.ts), never restated here
 *
 * Everything is deterministic: fixed key seeds, fixed fee, no time bounds.
 * `git diff --exit-code sdks/vectors` is a valid regeneration check.
 *
 * This builder is shared tooling, not a language SDK: it only needs
 * @stellar/stellar-sdk to assemble signed envelopes.
 *
 * Run:  cd sdks/vectors/builder && npm ci && node build-vectors.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  contractErrorScValXdr,
  contractEventXdr,
  scValXdr,
} from "./lib/scval-writer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const vectorsDir = join(root, "sdks", "vectors");
const spec = JSON.parse(
  readFileSync(join(root, "sdks", "spec", "streampay.spec.json"), "utf8")
);
const fingerprint = readFileSync(
  join(root, "sdks", "spec", "FINGERPRINT"),
  "utf8"
).trim();

/** Error codes by name, from the canonical catalog generated from errors.rs. */
const catalogText = readFileSync(join(root, "frontend", "lib", "errors.ts"), "utf8");
const ERROR_CODES = Object.fromEntries(
  [...catalogText.matchAll(/^\s*(\d+):\s*\{\s*code:\s*\d+,\s*name:\s*"(\w+)"/gm)].map(
    ([, code, name]) => [name, Number(code)]
  )
);
const errorCode = (name) => {
  const code = ERROR_CODES[name];
  if (code === undefined) throw new Error(`${name} is not in frontend/lib/errors.ts`);
  return code;
};

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";
const SNAPSHOT_DIR = join(
  root,
  "contracts",
  "streaming-payments",
  "test_snapshots",
  "test"
);

/** Deterministic testnet-shaped signer: never used on any network. */
const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

const toScVal = (type, value) => {
  if (typeof type === "object" && type !== null) {
    if ("option" in type) return nativeToScVal(value);
    if ("vec" in type) {
      return nativeToScVal(
        value.map((item) => BigInt(item)),
        { type: type.vec }
      );
    }
  }
  if (type === "address") {
    return nativeToScVal(new Address(value), { type: "address" });
  }
  if (type === "bool") return nativeToScVal(Boolean(value));
  if (type === "vec:u64") {
    return nativeToScVal(value.map((item) => BigInt(item)), { type: "u64" });
  }
  if (type.startsWith("option:")) {
    return nativeToScVal(value);
  }
  return nativeToScVal(BigInt(value), { type });
};

const envelopeFor = (contractId, functionName, args) => {
  const tx = new TransactionBuilder(new Account(signer.publicKey(), "0"), {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contractId).call(functionName, ...args))
    .setTimebounds(0, 0)
    .build();
  tx.sign(signer);
  return tx.toXDR();
};

/** Canonical decode of a snapshot ScVal JSON node. */
const decodeJson = (node, type) => {
  if (type === "bool") return Boolean(node.bool);
  if (type === "address") return node.address;
  if (type === "symbol" || type === "string") {
    return node.symbol ?? node.string;
  }
  if (
    ["u32", "u64", "i32", "i128", "u128", "timepoint", "duration"].includes(type)
  ) {
    return String(node[type]);
  }
  if ("map" in node) {
    return Object.fromEntries(
      node.map.map(({ key, val }) => [
        key.symbol ?? key.string,
        decodeJson(val, inferType(val)),
      ])
    );
  }
  if ("vec" in node) return node.vec.map((item) => decodeJson(item, inferType(item)));
  throw new Error(`cannot decode snapshot node ${JSON.stringify(node)}`);
};

const inferType = (node) => {
  for (const key of ["bool", "u64", "i128", "u32", "symbol", "string", "address"]) {
    if (key in node) return key;
  }
  if ("map" in node) return "map";
  if ("vec" in node) return "vec";
  return "void";
};

/**
 * Canonical JSON for a snapshot node of a known spec type: structs become
 * objects keyed by field name, unit enums become their case name.
 */
const canonicalOf = (node, type) => {
  if (typeof type === "object") {
    if ("option" in type) return "void" in node ? null : canonicalOf(node, type.option);
    if ("vec" in type) return node.vec.map((item) => canonicalOf(item, type.vec));
    throw new Error(`unsupported type ${JSON.stringify(type)}`);
  }
  const struct = spec.structs.find((candidate) => candidate.name === type);
  if (struct) {
    const out = {};
    for (const field of struct.fields) {
      const entry = node.map.find((candidate) => candidate.key.symbol === field.name);
      if (!entry) throw new Error(`${type} snapshot is missing ${field.name}`);
      out[field.name] = canonicalOf(entry.val, field.type);
    }
    return out;
  }
  const enumSpec = spec.enums.find((candidate) => candidate.name === type);
  if (enumSpec) {
    // Soroban encodes a unit enum without discriminants as Vec[Symbol(case)].
    if (enumSpec.encoding === "symbol") return node.vec[0].symbol;
    return enumSpec.cases.find((c) => c.value === Number(node.u32)).name;
  }
  return decodeJson(node, type);
};

const loadSnapshot = (snapshotFile, dir = SNAPSHOT_DIR) =>
  JSON.parse(readFileSync(join(dir, snapshotFile), "utf8"));

const mapOf = (node) =>
  Object.fromEntries(node.map.map(({ key, val }) => [key.symbol, val]));

/** The `Stream` struct stored for `streamId` in a snapshot's ledger. */
const loadStoredStream = (
  snapshotFile,
  streamId,
  { dir = SNAPSHOT_DIR, contract = CONTRACT_ID } = {}
) => {
  const snapshot = loadSnapshot(snapshotFile, dir);
  const matches = snapshot.ledger.ledger_entries
    .map((item) => item.entry?.data?.contract_data)
    .filter(
      (data) =>
        data &&
        data.contract === contract &&
        data.key?.vec?.[0]?.symbol === "Stream" &&
        data.key.vec[1]?.u64 === streamId
    );
  if (matches.length !== 1) {
    throw new Error(`${snapshotFile}: expected one stored Stream ${streamId}, found ${matches.length}`);
  }
  // Since the stream-record versioning on main, a stored record is a
  // `VersionedStream { stream, version }`; a legacy (v1) record is the bare
  // `Stream` map. `get_stream` returns the inner `Stream` either way.
  const val = matches[0].val;
  const keys = val.map?.map((entry) => entry.key.symbol) ?? [];
  if (keys.length === 2 && keys.includes("stream") && keys.includes("version")) {
    return val.map.find((entry) => entry.key.symbol === "stream").val;
  }
  return val;
};

const loadEvent = (
  snapshotFile,
  eventName,
  { dir = SNAPSHOT_DIR, contract = CONTRACT_ID } = {}
) => {
  const snapshot = loadSnapshot(snapshotFile, dir);
  const matches = snapshot.events.filter(
    (entry) =>
      (entry.event?.type === "contract" || entry.event?.type_ === "contract") &&
      entry.event.contract_id === contract &&
      entry.event.body.v0.topics[0]?.symbol === eventName
  );
  if (matches.length !== 1) {
    throw new Error(
      `${snapshotFile}: expected exactly one ${eventName} event, found ${matches.length}`
    );
  }
  return matches[0].event;
};

const loadContractEvents = (
  snapshotFile,
  eventNames,
  { dir = SNAPSHOT_DIR, contract = CONTRACT_ID } = {}
) =>
  loadSnapshot(snapshotFile, dir).events
    .map((entry) => entry.event)
    .filter(
      (event) =>
        event.contract_id === contract &&
        event.body.v0.topics[0]?.symbol &&
        eventNames.includes(event.body.v0.topics[0].symbol)
    );

const contractEvent = (contract, topic, topicNodes, dataNodes) => ({
  contract_id: contract,
  type: "contract",
  body: {
    v0: {
      topics: [{ symbol: topic }, ...topicNodes],
      data: {
        map: Object.entries(dataNodes)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, val]) => ({ key: { symbol: key }, val })),
      },
    },
  },
});

const withdrawEntryNode = (streamId, amount, code) => ({
  map: [
    { key: { symbol: "stream_id" }, val: { u64: String(streamId) } },
    { key: { symbol: "amount" }, val: { i128: String(amount) } },
    { key: { symbol: "code" }, val: { u32: code } },
  ],
});

const withdrawAllNode = ({
  transfers,
  successfulStreamIds,
  failedStreams,
  nextOffset,
}) => ({
  map: [
    {
      key: { symbol: "transfers" },
      val: {
        vec: transfers.map(({ token, amount }) => ({
          map: [
            { key: { symbol: "token" }, val: { address: token } },
            { key: { symbol: "amount" }, val: { i128: String(amount) } },
          ],
        })),
      },
    },
    {
      key: { symbol: "successful_stream_ids" },
      val: { vec: successfulStreamIds.map((id) => ({ u64: String(id) })) },
    },
    {
      key: { symbol: "failed_streams" },
      val: {
        vec: failedStreams.map(({ streamId, errorCode }) => ({
          map: [
            { key: { symbol: "stream_id" }, val: { u64: String(streamId) } },
            { key: { symbol: "error_code" }, val: { u32: errorCode } },
          ],
        })),
      },
    },
    {
      key: { symbol: "next_offset" },
      val: nextOffset === null ? { void: true } : { u32: nextOffset },
    },
  ],
});

const eventToExpected = (event) => {
  const specEvent = spec.events.find(
    (candidate) => candidate.topic === event.body.v0.topics[0].symbol
  );
  if (!specEvent) {
    throw new Error(`event ${event.body.v0.topics[0].symbol} is not in the spec`);
  }
  const topics = {};
  specEvent.topicFields.forEach((field, index) => {
    topics[field.name] = decodeJson(event.body.v0.topics[index + 1], field.type);
  });
  const data = {};
  for (const entry of event.body.v0.data.map) {
    data[entry.key.symbol] = decodeJson(entry.val, inferType(entry.val));
  }
  return {
    contract: event.contract_id,
    name: specEvent.name,
    topics,
    data,
  };
};

const eventField = (event, name) => {
  const entry = event.body.v0.data.map.find(
    (candidate) => candidate.key.symbol === name
  );
  if (!entry) throw new Error(`event is missing data field ${name}`);
  return entry.val;
};

const build = (scenario) => {
  const contract = scenario.contract ?? CONTRACT_ID;
  const event = scenario.event
    ? loadEvent(scenario.snapshot, scenario.event, { dir: scenario.snapshotDir, contract })
    : null;
  const args = scenario.args(event);
  const functionSpec = spec.functions.find((f) => f.name === scenario.function);
  const orderedArgs = functionSpec.args.map((arg) => toScVal(arg.type, args[arg.name]));
  const envelopeXdr = envelopeFor(contract, scenario.function, orderedArgs);

  // `scenario.events` supplies events the snapshot did not record (a
  // snapshot only keeps the *last* invocation's events, which in the
  // schedule tests is usually a read-only getter); see `scheduledEvent`.
  const events = scenario.events ? scenario.events() : event ? [event] : [];
  let result;
  if (scenario.error) {
    result = { error: { name: scenario.error, code: errorCode(scenario.error) } };
  } else {
    result = { ok: scenario.result === undefined ? null : scenario.result };
  }

  const expectedTransaction = {
    contract,
    function: scenario.function,
    args,
    source: signer.publicKey(),
    fee: "100000",
    sequence: "1",
    signatures: 1,
  };

  return {
    schema: "streampay-vector/v1",
    name: scenario.name,
    specFingerprint: fingerprint,
    provenance: scenario.provenance,
    transactionEnvelopeXdr: envelopeXdr,
    resultXdr: scenario.error
      ? contractErrorScValXdr(errorCode(scenario.error))
      : scenario.resultScVal(event),
    eventsXdr: events.map((item) => contractEventXdr(item, StrKey)),
    expected: {
      transaction: expectedTransaction,
      result,
      events: events.map(eventToExpected),
    },
  };
};

const scenarios = [
  {
    name: "create-stream",
    provenance:
      "StreamCreated payload from contracts/streaming-payments/test_snapshots/test/create_stream_rejects_duration_over_max.1.json; envelope built from the same values.",
    snapshot: "create_stream_rejects_duration_over_max.1.json",
    event: "stream_created",
    function: "create_stream",
    args: (event) => ({
      sender: eventField(event, "sender").address,
      recipient: eventField(event, "recipient").address,
      token: eventField(event, "token").address,
      deposit_amount: eventField(event, "deposit").i128,
      start_time: eventField(event, "start_time").u64,
      end_time: eventField(event, "end_time").u64,
      cancelable: eventField(event, "cancelable").bool,
    }),
    resultScVal: (event) => scValXdr(event.body.v0.topics[1], StrKey),
    result: "1",
  },
  {
    name: "withdraw",
    provenance:
      "Withdrawn payload from contracts/streaming-payments/test_snapshots/test/withdraw_max_emits_withdrawn_event.1.json.",
    snapshot: "withdraw_max_emits_withdrawn_event.1.json",
    event: "withdrawn",
    function: "withdraw",
    args: (event) => ({
      stream_id: event.body.v0.topics[1].u64,
      amount: eventField(event, "amount").i128,
    }),
    resultScVal: () => scValXdr({ void: true }, StrKey),
    result: null,
  },
  {
    name: "withdraw-max",
    provenance:
      "Withdrawn payload from contracts/streaming-payments/test_snapshots/test/withdraw_max_emits_withdrawn_event.1.json; returns the paid amount.",
    snapshot: "withdraw_max_emits_withdrawn_event.1.json",
    event: "withdrawn",
    function: "withdraw_max",
    args: (event) => ({ stream_id: event.body.v0.topics[1].u64 }),
    resultScVal: (event) => scValXdr(eventField(event, "amount"), StrKey),
    result: "1000000000",
  },
  {
    name: "top-up",
    provenance:
      "StreamToppedUp payload from contracts/streaming-payments/test_snapshots/test/top_up_event_emitted.1.json.",
    snapshot: "top_up_event_emitted.1.json",
    event: "stream_topped_up",
    function: "top_up",
    args: (event) => ({
      stream_id: event.body.v0.topics[1].u64,
      amount: eventField(event, "amount").i128,
    }),
    resultScVal: () => scValXdr({ void: true }, StrKey),
    result: null,
  },
  {
    name: "cancel-stream",
    provenance:
      "StreamCancelled payload from contracts/streaming-payments/test_snapshots/test/events_are_emitted_with_expected_payloads.1.json.",
    snapshot: "events_are_emitted_with_expected_payloads.1.json",
    event: "stream_cancelled",
    function: "cancel_stream",
    args: (event) => ({
      caller: eventField(event, "cancelled_by").address,
      stream_id: event.body.v0.topics[1].u64,
    }),
    resultScVal: () => scValXdr({ void: true }, StrKey),
    result: null,
  },
  {
    name: "error-not-active",
    provenance:
      "WithdrawMax envelope against a cancelled stream; result is ScVal::Error(SCError::Contract(code)) with the StreamNotActive code from frontend/lib/errors.ts.",
    snapshot: null,
    event: null,
    function: "withdraw_max",
    args: () => ({ stream_id: "1" }),
    error: "StreamNotActive",
  },
  (() => {
    const snapshot = "withdraw_many_footprint_harness.1.json";
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    const amount = "10000000000";
    return {
      name: "batch-withdraw-success",
      provenance:
        "withdraw_many_settles_20 fully vested streams in contracts/streaming-payments/test_snapshots/test/withdraw_many_footprint_harness.1.json: one Withdrawn event per stream, then BatchWithdrawSummary; returns one WithdrawEntry per id.",
      snapshot,
      event: null,
      snapshotDir: SNAPSHOT_DIR,
      function: "withdraw_many",
      args: () => ({
        recipient: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
        stream_ids: ids.map(String),
        strict: false,
      }),
      events: () =>
        loadContractEvents(snapshot, ["withdrawn", "batch_withdraw_summary"])
          .filter((event) => event.body.v0.topics[0].symbol === "withdrawn" ||
            event.body.v0.topics[0].symbol === "batch_withdraw_summary"),
      resultScVal: () =>
        scValXdr(
          {
            vec: ids.map((id) => withdrawEntryNode(id, amount, 0)),
          },
          StrKey
        ),
      result: ids.map((id) => ({
        stream_id: String(id),
        amount,
        code: 0,
      })),
    };
  })(),
  (() => {
    const snapshot = "withdraw_many_answers_carry_the_amount_or_the_stable_error_code.1.json";
    return {
      name: "batch-withdraw-partial",
      provenance:
        "withdraw_many_answers_carry_the_amount_or_the_stable_error_code.1.json plus withdraw_many_settles_eligible_streams_and_reports_the_rest.1.json: stream 1 paid, stream 2 is StreamNotActive, stream 99 is StreamNotFound; non-strict mode returns per-entry rows and the BatchWithdrawSummary.",
      snapshot,
      event: null,
      snapshotDir: SNAPSHOT_DIR,
      function: "withdraw_many",
      args: () => ({
        recipient: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
        stream_ids: ["1", "2", "99"],
        strict: false,
      }),
      events: () =>
        loadContractEvents(snapshot, ["withdrawn", "batch_withdraw_summary"]),
      resultScVal: () =>
        scValXdr(
          {
            vec: [
              withdrawEntryNode(1, "10000000000", 0),
              withdrawEntryNode(2, 0, errorCode("StreamNotActive")),
              withdrawEntryNode(99, 0, errorCode("StreamNotFound")),
            ],
          },
          StrKey
        ),
      result: [
        { stream_id: "1", amount: "10000000000", code: 0 },
        { stream_id: "2", amount: "0", code: errorCode("StreamNotActive") },
        { stream_id: "99", amount: "0", code: errorCode("StreamNotFound") },
      ],
    };
  })(),
  {
    name: "error-batch-withdraw-empty",
    provenance:
      "withdraw_many_bounds_the_batch_and_rejects_duplicates_upfront.1.json/test assertion: an empty stream_ids vector reverts with WithdrawBatchEmpty before any stream is read.",
    snapshot: null,
    event: null,
    function: "withdraw_many",
    args: () => ({
      recipient: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      stream_ids: [],
      strict: false,
    }),
    error: "WithdrawBatchEmpty",
  },
  {
    name: "error-batch-withdraw-unknown-strict",
    provenance:
      "withdraw_many strict/unknown-stream semantics from withdraw_many_settles_eligible_streams_and_reports_the_rest.1.json: strict=true turns StreamNotFound into a top-level revert, while non-strict mode returns it as a WithdrawEntry code.",
    snapshot: null,
    event: null,
    function: "withdraw_many",
    args: () => ({
      recipient: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      stream_ids: ["99"],
      strict: true,
    }),
    error: "StreamNotFound",
  },
  (() => {
    const snapshot = "withdraw_all_aggregates_transfers_per_asset.1.json";
    const snapshotData = loadSnapshot(snapshot);
    const streamData = (snapshotData.ledger?.ledger_entries || [])
      .map((item) => item.entry?.data?.contract_data)
      .find((data) => data?.key?.vec?.[0]?.symbol === "Stream");
    if (!streamData) throw new Error(`${snapshot}: missing Stream ledger entry`);
    const contract = streamData.contract;
    const stream1 = mapOf(loadStoredStream(snapshot, "1", { contract }));
    const stream2 = mapOf(loadStoredStream(snapshot, "2", { contract }));
    const stream3 = mapOf(loadStoredStream(snapshot, "3", { contract }));
    const recipient = stream1.recipient.address;
    return {
      name: "claim-all-success",
      provenance:
        "withdraw_all_aggregates_transfers_per_asset.1.json and withdraw_all_aggregates_transfers_per_asset contract assertions: three active streams pay 5,000,000,000 / 10,000,000,000 / 5,000,000,000 and aggregate by asset.",
      snapshot,
      event: null,
      snapshotDir: SNAPSHOT_DIR,
      function: "withdraw_all",
      args: () => ({ recipient, page_bounds: null }),
      events: () => [
        contractEvent(contract, "withdrawn", [{ u64: "1" }], {
          recipient: { address: recipient },
          amount: { i128: "5000000000" },
          withdrawn_total: { i128: "5000000000" },
        }),
        contractEvent(contract, "withdrawn", [{ u64: "2" }], {
          recipient: { address: recipient },
          amount: { i128: "10000000000" },
          withdrawn_total: { i128: "10000000000" },
        }),
        contractEvent(contract, "withdrawn", [{ u64: "3" }], {
          recipient: { address: recipient },
          amount: { i128: "5000000000" },
          withdrawn_total: { i128: "5000000000" },
        }),
      ],
      resultScVal: () =>
        scValXdr(
          withdrawAllNode({
            transfers: [
              { token: stream1.token.address, amount: "15000000000" },
              { token: stream3.token.address, amount: "5000000000" },
            ],
            successfulStreamIds: ["1", "2", "3"],
            failedStreams: [],
            nextOffset: null,
          }),
          StrKey
        ),
      result: {
        transfers: [
          { token: stream1.token.address, amount: "15000000000" },
          { token: stream3.token.address, amount: "5000000000" },
        ],
        successful_stream_ids: ["1", "2", "3"],
        failed_streams: [],
        next_offset: null,
      },
    };
  })(),
  (() => {
    const snapshot = "withdraw_all_partial_failure_isolation.1.json";
    const stream1 = mapOf(loadStoredStream(snapshot, "1"));
    const contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";
    const recipient = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
    return {
      name: "claim-all-partial",
      provenance:
        "withdraw_all_partial_failure_isolation.1.json and contract assertions: stream 1 succeeds, unstarted/cancelled/depleted streams are returned as ClaimFailure rows, and the active amount is aggregated as one transfer.",
      snapshot,
      event: null,
      snapshotDir: SNAPSHOT_DIR,
      function: "withdraw_all",
      args: () => ({ recipient, page_bounds: null }),
      events: () =>
        loadContractEvents(snapshot, ["withdrawn"]),
      resultScVal: () =>
        scValXdr(
          withdrawAllNode({
            transfers: [{ token: stream1.token.address, amount: "5000000000" }],
            successfulStreamIds: ["1"],
            failedStreams: [
              { streamId: "2", errorCode: errorCode("NothingToWithdraw") },
              { streamId: "3", errorCode: errorCode("StreamNotActive") },
              { streamId: "4", errorCode: errorCode("StreamNotActive") },
            ],
            nextOffset: null,
          }),
          StrKey
        ),
      result: {
        transfers: [{ token: stream1.token.address, amount: "5000000000" }],
        successful_stream_ids: ["1"],
        failed_streams: [
          { stream_id: "2", error_code: errorCode("NothingToWithdraw") },
          { stream_id: "3", error_code: errorCode("StreamNotActive") },
          { stream_id: "4", error_code: errorCode("StreamNotActive") },
        ],
        next_offset: null,
      },
    };
  })(),
  ...[
    ["get-stream-active", "create_stream_accepts_exact_capacity_boundary.1.json"],
    ["get-stream-cancelled", "cancel_before_start_refunds_everything_to_sender.1.json"],
  ].map(([name, snapshot]) => ({
    name,
    provenance: `Stored Stream 1 (contract-data ledger entry) from contracts/streaming-payments/test_snapshots/test/${snapshot}; status is the contract's Vec[Symbol] enum encoding.`,
    snapshot,
    event: null,
    function: "get_stream",
    args: () => ({ stream_id: "1" }),
    resultScVal: () => scValXdr(loadStoredStream(snapshot, "1"), StrKey),
    result: canonicalOf(loadStoredStream(snapshot, "1"), "Stream"),
  })),
];

// ---------------------------------------------------------------------------
// Scheduled intents (contracts/streaming-payments/src/schedule_test.rs).
//
// Sources: the `schedule_test` snapshots. A snapshot records the final ledger
// plus only the *last* invocation's events, and every schedule test ends with
// a read-only getter, so only `StreamScheduled` is recorded verbatim. For the
// other outcomes the stored `Intent`/`Stream` ledger entries supply every
// value, and the event payloads are rebuilt from them exactly as the test
// asserts them (e.g. `execute_creates_stream_and_pays_keeper` asserts the
// events are `[StreamCreated, ScheduledStreamExecuted]`).
// ---------------------------------------------------------------------------
const SCHEDULE_SNAPSHOT_DIR = join(
  root,
  "contracts",
  "streaming-payments",
  "test_snapshots",
  "schedule_test"
);
const scheduleSnap = (name) => `${name}.1.json`;

/** The stored `Intent(1)` entry of a schedule snapshot. */
const loadStoredIntent = (snapshotFile) => {
  const matches = loadSnapshot(snapshotFile, SCHEDULE_SNAPSHOT_DIR)
    .ledger.ledger_entries.map((item) => item.entry?.data?.contract_data)
    .filter(
      (data) =>
        data && data.key?.vec?.[0]?.symbol === "Intent" && data.key.vec[1]?.u64 === "1"
    );
  if (matches.length !== 1) {
    throw new Error(`${snapshotFile}: expected one stored Intent 1, found ${matches.length}`);
  }
  return { contract: matches[0].contract, fields: mapOf(matches[0].val) };
};

/**
 * The keeper is the third address `Address::generate` hands the test fixture;
 * it is never part of a stored intent, but its token balance equals the fee it
 * was paid, so it is recoverable from the happy-path snapshot.
 */
const KEEPER_SOURCE = scheduleSnap("execute_creates_stream_and_pays_keeper");
const KEEPER = (() => {
  const intent = loadStoredIntent(KEEPER_SOURCE);
  const fee = intent.fields.fee_budget.i128;
  const paid = loadSnapshot(KEEPER_SOURCE, SCHEDULE_SNAPSHOT_DIR)
    .ledger.ledger_entries.map((item) => item.entry?.data?.contract_data)
    .filter(
      (data) =>
        data &&
        data.contract === intent.fields.token.address &&
        data.key?.vec?.[0]?.symbol === "Balance" &&
        data.key.vec[1].address !== intent.contract &&
        data.key.vec[1].address !== intent.fields.sender.address &&
        mapOf(data.val).amount.i128 === fee
    );
  if (paid.length !== 1) throw new Error("cannot identify the keeper in the snapshot");
  return paid[0].key.vec[1].address;
})();

/**
 * A contract event in snapshot JSON shape. Map keys are sorted by symbol, the
 * order the host stores a Soroban map in (and the order every recorded event
 * above already has).
 */
const scheduledEvent = (contract, topic, intentId, data) => ({
  contract_id: contract,
  type: "contract",
  body: {
    v0: {
      topics: [{ symbol: topic }, { u64: intentId }],
      data: {
        map: Object.entries(data)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, val]) => ({ key: { symbol: key }, val })),
      },
    },
  },
});

const VOID_RESULT = () => scValXdr({ void: true }, StrKey);

/** Cross-checks that a revert snapshot used the same actors as the happy path. */
const sameActors = (snapshotFile) => {
  const happy = loadStoredIntent(KEEPER_SOURCE);
  const intent = loadStoredIntent(snapshotFile);
  for (const field of ["sender", "recipient", "token"]) {
    if (intent.fields[field].address !== happy.fields[field].address) {
      throw new Error(`${snapshotFile}: ${field} differs from ${KEEPER_SOURCE}`);
    }
  }
  return intent;
};

const scheduleRevert = ({ name, snapshot, fn, error, provenance, args }) => {
  const intent = sameActors(scheduleSnap(snapshot));
  return {
    name,
    provenance,
    snapshotDir: SCHEDULE_SNAPSHOT_DIR,
    snapshot: scheduleSnap(snapshot),
    contract: intent.contract,
    event: null,
    function: fn,
    args: () => args(intent.fields),
    error,
  };
};

const scheduledScenarios = [
  (() => {
    const snapshot = scheduleSnap("schedule_emits_expected_event");
    const dir = SCHEDULE_SNAPSHOT_DIR;
    const contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
    return {
      name: "schedule-stream",
      provenance:
        "StreamScheduled payload from contracts/streaming-payments/test_snapshots/schedule_test/schedule_emits_expected_event.1.json (3-occurrence recurring intent); envelope built from the same values; returns the new intent id.",
      snapshotDir: dir,
      snapshot,
      contract,
      event: "stream_scheduled",
      function: "schedule_stream",
      args: (event) => ({
        sender: eventField(event, "sender").address,
        recipient: eventField(event, "recipient").address,
        token: eventField(event, "token").address,
        deposit_amount: eventField(event, "deposit").i128,
        start_time: eventField(event, "start_time").u64,
        end_time: eventField(event, "end_time").u64,
        cancelable: eventField(event, "cancelable").bool,
        interval: eventField(event, "interval").u64,
        occurrences: String(eventField(event, "occurrences").u32),
        fee_budget: eventField(event, "fee_budget").i128,
        execute_after: eventField(event, "execute_after").u64,
        expires_at: eventField(event, "expires_at").u64,
      }),
      resultScVal: (event) => scValXdr(event.body.v0.topics[1], StrKey),
      result: "1",
    };
  })(),
  (() => {
    const snapshot = scheduleSnap("execute_creates_stream_and_pays_keeper");
    const intent = loadStoredIntent(snapshot);
    const f = intent.fields;
    const stream = mapOf(
      loadStoredStream(snapshot, "1", { dir: SCHEDULE_SNAPSHOT_DIR, contract: intent.contract })
    );
    const streamId = "1";
    return {
      name: "execute-scheduled",
      provenance:
        "Happy path of schedule_test::execute_creates_stream_and_pays_keeper: the stored Intent/Stream entries of its snapshot supply the values; events are the [StreamCreated, ScheduledStreamExecuted] pair that test asserts; returns the new stream id.",
      snapshotDir: SCHEDULE_SNAPSHOT_DIR,
      snapshot,
      contract: intent.contract,
      event: null,
      function: "execute_scheduled",
      args: () => ({ intent_id: f.id.u64, keeper: KEEPER }),
      events: () => [
        scheduledEvent(intent.contract, "stream_created", streamId, {
          sender: stream.sender,
          recipient: stream.recipient,
          token: stream.token,
          deposit: stream.deposit,
          start_time: stream.start_time,
          end_time: stream.end_time,
          cancelable: stream.cancelable,
        }),
        scheduledEvent(intent.contract, "scheduled_stream_executed", f.id.u64, {
          keeper: { address: KEEPER },
          stream_id: { u64: streamId },
          occurrence_index: { u32: f.occurrences_total.u32 - f.occurrences_remaining.u32 - 1 },
          occurrences_remaining: f.occurrences_remaining,
          fee_paid: f.fee_budget,
        }),
      ],
      resultScVal: () => scValXdr({ u64: streamId }, StrKey),
      result: streamId,
    };
  })(),
  (() => {
    const snapshot = scheduleSnap("cancel_before_window_refunds_and_blocks_execution");
    const intent = sameActors(snapshot);
    const f = intent.fields;
    // refund = (deposit + fee) * outstanding occurrences; the test asserts
    // DEPOSIT + FEE for its single occurrence.
    const refund = String(
      (BigInt(f.deposit.i128) + BigInt(f.fee_budget.i128)) * BigInt(f.occurrences_remaining.u32)
    );
    return {
      name: "cancel-scheduled",
      provenance:
        "schedule_test::cancel_before_window_refunds_and_blocks_execution: cancelled before execute_after, full (deposit + fee) escrow refunded to the sender; ScheduledIntentCancelled as that test asserts it.",
      snapshotDir: SCHEDULE_SNAPSHOT_DIR,
      snapshot,
      contract: intent.contract,
      event: null,
      function: "cancel_scheduled",
      args: () => ({ sender: f.sender.address, intent_id: f.id.u64 }),
      events: () => [
        scheduledEvent(intent.contract, "scheduled_intent_cancelled", f.id.u64, {
          sender: f.sender,
          refund: { i128: refund },
        }),
      ],
      resultScVal: VOID_RESULT,
      result: null,
    };
  })(),
  (() => {
    const snapshot = scheduleSnap("reclaim_after_expiry_refunds_sender_permissionlessly");
    const intent = sameActors(snapshot);
    const f = intent.fields;
    const refund = String(
      (BigInt(f.deposit.i128) + BigInt(f.fee_budget.i128)) * BigInt(f.occurrences_remaining.u32)
    );
    return {
      name: "reclaim-expired",
      provenance:
        "schedule_test::reclaim_after_expiry_refunds_sender_permissionlessly: an unexecuted intent reclaimed at expires_at by anyone; escrow refunded to the sender; ScheduledIntentExpired as that test asserts it.",
      snapshotDir: SCHEDULE_SNAPSHOT_DIR,
      snapshot,
      contract: intent.contract,
      event: null,
      function: "reclaim_expired",
      args: () => ({ intent_id: f.id.u64 }),
      events: () => [
        scheduledEvent(intent.contract, "scheduled_intent_expired", f.id.u64, {
          sender: f.sender,
          refund: { i128: refund },
        }),
      ],
      resultScVal: VOID_RESULT,
      result: null,
    };
  })(),
  scheduleRevert({
    name: "error-intent-not-yet-executable",
    snapshot: "execute_before_due_reverts",
    fn: "execute_scheduled",
    error: "IntentNotYetExecutable",
    provenance:
      "schedule_test::execute_before_due_reverts: execute_scheduled before execute_after; the error is ScVal::Error(SCError::Contract(code)) with the IntentNotYetExecutable code from frontend/lib/errors.ts.",
    args: (f) => ({ intent_id: f.id.u64, keeper: KEEPER }),
  }),
  scheduleRevert({
    name: "error-intent-not-pending",
    snapshot: "execute_twice_reverts_double_execution_race",
    fn: "execute_scheduled",
    error: "IntentNotPending",
    provenance:
      "schedule_test::execute_twice_reverts_double_execution_race: the second execute_scheduled of an already-executed one-shot intent (the first call succeeded; see execute-scheduled); the same code also rejects executing a cancelled intent.",
    args: (f) => ({ intent_id: f.id.u64, keeper: KEEPER }),
  }),
  scheduleRevert({
    name: "error-intent-not-cancellable",
    snapshot: "cancel_after_window_opens_reverts",
    fn: "cancel_scheduled",
    error: "IntentNotCancellable",
    provenance:
      "schedule_test::cancel_after_window_opens_reverts: cancel_scheduled once execute_after has been reached.",
    args: (f) => ({ sender: f.sender.address, intent_id: f.id.u64 }),
  }),
  scheduleRevert({
    name: "error-intent-not-expired",
    snapshot: "reclaim_before_expiry_reverts",
    fn: "reclaim_expired",
    error: "IntentNotExpired",
    provenance:
      "schedule_test::reclaim_before_expiry_reverts: reclaim_expired while expires_at is still in the future.",
    args: (f) => ({ intent_id: f.id.u64 }),
  }),
];
scenarios.push(...scheduledScenarios);

mkdirSync(vectorsDir, { recursive: true });
for (const scenario of scenarios) {
  const vector = build(scenario);
  const path = join(vectorsDir, `${scenario.name}.json`);
  writeFileSync(path, JSON.stringify(vector, null, 2) + "\n");
  console.log(`wrote ${path}`);
}
