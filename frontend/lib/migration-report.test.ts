// Unit tests for the storage-layout classifier behind `scripts/migrate_audit.sh`
// (Node.js built-in test runner).

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildMigrationReport,
  buildReportFromVersions,
  classifyRecord,
  renderReportMarkdown,
  STREAM_RECORD_VERSION_V1,
  V1_STREAM_FIELDS,
  type ScValMapEntry,
  type ScValShape,
} from "./migration-report.ts";

const WRITTEN_VERSION = 2;

type ScalarKind = "u32" | "u64" | "i128" | "i64" | "bool" | "symbol" | "address" | "bytes";

function scalar(kind: ScalarKind, value: string | number | boolean): ScValShape {
  return { kind, value };
}

/** A bare, untagged `Stream` map — exactly what a pre-versioning deploy wrote. */
function legacyStreamMap(id = "7"): ScValShape {
  const values: Record<string, ScValShape> = {
    id: scalar("u64", id),
    sender: scalar("address", "GDUD7WFKZW4DQ633BPL3NDC37H5Q2W6B4RKGKAAAAAAAAC3PFDVZQXG6"),
    recipient: scalar("address", "GAYN5LJ6B4H3QFJ5RZ6D4E4R6ZQYQ2W6B4RKGKAAAAAAAAC3PFDVYDQN"),
    token: scalar("address", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2ZMN"),
    deposit: scalar("i128", "1000000"),
    withdrawn: scalar("i128", "0"),
    start_time: scalar("u64", "1760000000"),
    end_time: scalar("u64", "1760600000"),
    cancelable: scalar("bool", true),
    status: scalar("symbol", "Active"),
    use_oracle: scalar("bool", false),
  };
  const entries: ScValMapEntry[] = V1_STREAM_FIELDS.map((key) => ({
    key,
    value: values[key],
  }));
  return { kind: "map", entries };
}

function tagged(version: ScValShape, stream: ScValShape): ScValShape {
  return {
    kind: "map",
    entries: [
      { key: "version", value: version },
      { key: "stream", value: stream },
    ],
  };
}

describe("classifyRecord", () => {
  it("reads an untagged stream map as a legacy v1 record", () => {
    const verdict = classifyRecord(legacyStreamMap(), WRITTEN_VERSION);
    assert.equal(verdict.layout, "legacy");
    assert.equal(verdict.version, STREAM_RECORD_VERSION_V1);
  });

  it("reads the tagged envelope of this build's version as current", () => {
    const verdict = classifyRecord(
      tagged(scalar("u32", WRITTEN_VERSION), legacyStreamMap()),
      WRITTEN_VERSION,
    );
    assert.equal(verdict.layout, "current");
    assert.equal(verdict.version, WRITTEN_VERSION);
  });

  it("reads a tagged envelope behind this build as legacy", () => {
    const verdict = classifyRecord(
      tagged(scalar("u32", STREAM_RECORD_VERSION_V1), legacyStreamMap()),
      WRITTEN_VERSION,
    );
    assert.equal(verdict.layout, "legacy");
    assert.equal(verdict.version, STREAM_RECORD_VERSION_V1);
  });

  it("reads a tagged envelope ahead of this build as future", () => {
    const verdict = classifyRecord(
      tagged(scalar("u32", WRITTEN_VERSION + 1), legacyStreamMap()),
      WRITTEN_VERSION,
    );
    assert.equal(verdict.layout, "future");
  });

  it("refuses a map whose key set matches no layout instead of guessing", () => {
    const partial = legacyStreamMap();
    assert.ok(partial.kind === "map");
    const dropped = {
      kind: "map",
      entries: partial.entries.filter(
        (entry) => entry.key !== "start_time" && entry.key !== "end_time",
      ),
    } satisfies ScValShape;
    const verdict = classifyRecord(dropped, WRITTEN_VERSION);
    assert.equal(verdict.layout, "unrecognised");
    assert.equal(verdict.version, null);
    assert.match(verdict.detail, /match no known layout/);
  });

  it("refuses a tagged envelope that does not wrap a known stream layout", () => {
    const verdict = classifyRecord(
      tagged(scalar("u32", WRITTEN_VERSION), scalar("u64", "1")),
      WRITTEN_VERSION,
    );
    assert.equal(verdict.layout, "unrecognised");
  });

  it("refuses a version tag that is not a u32", () => {
    const verdict = classifyRecord(
      tagged(scalar("symbol", "two"), legacyStreamMap()),
      WRITTEN_VERSION,
    );
    assert.equal(verdict.layout, "unrecognised");
  });

  it("adds an extra field to a legacy map rather than reading it as v1", () => {
    const partial = legacyStreamMap();
    assert.ok(partial.kind === "map");
    const extended = {
      kind: "map",
      entries: [...partial.entries, { key: "refund_to", value: scalar("address", "G") }],
    } satisfies ScValShape;
    assert.equal(classifyRecord(extended, WRITTEN_VERSION).layout, "unrecognised");
  });
});

describe("buildMigrationReport", () => {
  it("orders stream ids numerically, not lexicographically", () => {
    const report = buildMigrationReport(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2ZMN",
      WRITTEN_VERSION,
      [
        { streamId: "10", shape: legacyStreamMap("10") },
        { streamId: "2", shape: tagged(scalar("u32", WRITTEN_VERSION), legacyStreamMap("2")) },
        { streamId: "9", shape: legacyStreamMap("9") },
      ],
    );
    assert.deepEqual(
      report.rows.map((row) => row.streamId),
      ["2", "9", "10"],
    );
  });

  it("maps each layout to the action an operator should take", () => {
    const report = buildMigrationReport("C1", WRITTEN_VERSION, [
      { streamId: "1", shape: legacyStreamMap("1") },
      { streamId: "2", shape: tagged(scalar("u32", WRITTEN_VERSION), legacyStreamMap("2")) },
      { streamId: "3", shape: tagged(scalar("u32", 99), legacyStreamMap("3")) },
    ]);
    assert.deepEqual(
      report.rows.map((row) => row.action),
      ["migrate", "none", "manual-review"],
    );
  });
});

describe("buildReportFromVersions", () => {
  it("treats an unreadable record as needing manual review", () => {
    const report = buildReportFromVersions("C1", WRITTEN_VERSION, [
      { streamId: "1", version: null },
      { streamId: "2", version: 1 },
      { streamId: "3", version: WRITTEN_VERSION },
    ]);
    assert.deepEqual(
      report.rows.map((row) => `${row.streamId}:${row.action}`),
      ["1:manual-review", "2:migrate", "3:none"],
    );
  });
});

describe("docs/MIGRATION_AUDIT.md", () => {
  it("is the report this classifier renders for the captured snapshot", () => {
    const snapshot = JSON.parse(
      readFileSync(new URL("../../tests/migration-audit/records.json", import.meta.url), "utf8"),
    ) as {
      contract: string;
      writtenVersion: number;
      records: { streamId: string; shape: ScValShape }[];
    };
    const rendered = renderReportMarkdown(
      buildMigrationReport(snapshot.contract, snapshot.writtenVersion, snapshot.records),
    );
    const golden = readFileSync(
      new URL("../../docs/MIGRATION_AUDIT.md", import.meta.url),
      "utf8",
    );
    assert.equal(golden, rendered);
  });
});
