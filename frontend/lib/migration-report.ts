//! Layout classification for StreamPay's versioned stream records.
//!
//! The contract tags every persisted stream record with an explicit layout
//! version (`VersionedStream`), so an auditor can tell three things apart: a
//! current record, a pre-versioning legacy record that the permissionless
//! migration path can lift, and a record this build refuses to decode (a future
//! or unrecognisable layout — the contract fails closed on those). This module
//! is the single implementation of that classification: `scripts/migrate_audit.ts`
//! builds its migration report from it, and `frontend/lib/stellar-read.ts`
//! returns the same verdict for a single stream.
//!
//! It is deliberately dependency-free: it works on a decoded `ScValShape` or on
//! a version tag, never on an SDK object, so it runs under Next.js, under Node's
//! type stripping (with no `node_modules` installed) and in tests without a
//! network.

/** The bare, untagged `Stream` map written before record versioning existed. */
export const STREAM_RECORD_VERSION_V1 = 1;

/** The tagged `{version, stream}` envelope this build writes. */
export const STREAM_RECORD_VERSION_V2 = 2;

/** Field names of the legacy v1 layout, in wire (declaration) order. */
export const V1_STREAM_FIELDS: readonly string[] = [
  "id",
  "sender",
  "recipient",
  "token",
  "deposit",
  "withdrawn",
  "start_time",
  "end_time",
  "cancelable",
  "status",
  "use_oracle",
];

/** Field names of the tagged envelope, in wire order. */
export const V2_RECORD_FIELDS: readonly string[] = ["version", "stream"];

/**
 * A storage value reduced to what the classifier reads: ordered map keys with
 * their nested shapes, plus the scalars a record is built from. Callers convert
 * an SDK `ScVal` into this; snapshots persist it as JSON.
 */
export type ScValShape =
  | { readonly kind: "map"; readonly entries: readonly ScValMapEntry[] }
  | { readonly kind: "vec"; readonly values: readonly ScValShape[] }
  | {
      readonly kind: "u32" | "u64" | "i128" | "i64" | "bool" | "symbol" | "address" | "bytes";
      readonly value: string | number | boolean;
    }
  | { readonly kind: "other"; readonly value: string | number | boolean | null };

export interface ScValMapEntry {
  readonly key: string;
  readonly value: ScValShape;
}

export type RecordLayout = "current" | "legacy" | "future" | "unrecognised";

export interface RecordVerdict {
  readonly layout: RecordLayout;
  /** Layout version the record claims, when it carries a tag. */
  readonly version: number | null;
  /** Version the audited build writes; `current` means `version === writtenVersion`. */
  readonly writtenVersion: number;
  /** Why the verdict was reached — shown in the report's detail column. */
  readonly detail: string;
}

export interface MigrationRow {
  readonly streamId: string;
  readonly layout: RecordLayout;
  readonly fromVersion: number | null;
  /** `migrate` — one `migrate_stream_version` call fixes it; `manual-review` — it does not. */
  readonly action: "migrate" | "none" | "manual-review";
  readonly detail: string;
}

export interface MigrationReport {
  readonly contract: string;
  readonly writtenVersion: number;
  readonly rows: readonly MigrationRow[];
}

function verdict(
  layout: RecordLayout,
  version: number | null,
  writtenVersion: number,
  detail: string,
): RecordVerdict {
  return { layout, version, writtenVersion, detail };
}

/** Classify a record from the layout version it declares. */
export function classifyVersionTag(
  version: number | null,
  writtenVersion: number,
): RecordVerdict {
  if (version === null) {
    return verdict("unrecognised", null, writtenVersion, "record declares no version tag");
  }
  if (version === writtenVersion) {
    return verdict("current", version, writtenVersion, `tagged v${version}`);
  }
  if (version > writtenVersion) {
    return verdict(
      "future",
      version,
      writtenVersion,
      `tagged v${version}, newer than this build (v${writtenVersion})`,
    );
  }
  return verdict(
    "legacy",
    version,
    writtenVersion,
    `tagged v${version}, behind this build (v${writtenVersion})`,
  );
}

function sameKeys(keys: readonly string[], expected: readonly string[]): boolean {
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function asVersion(shape: ScValShape | undefined): number | null {
  if (!shape || shape.kind !== "u32") return null;
  const value = Number(shape.value);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Classify one decoded storage value. The verdict comes from the bytes, not
 * from a contract call: a tagged envelope whose payload is not a known stream
 * layout is `unrecognised`, exactly as the contract's fail-closed decode is.
 */
export function classifyRecord(shape: ScValShape, writtenVersion: number): RecordVerdict {
  if (shape.kind !== "map") {
    return verdict("unrecognised", null, writtenVersion, `stored value is a ${shape.kind}, not a record map`);
  }
  const keys = shape.entries.map((entry) => entry.key);
  if (sameKeys(keys, V2_RECORD_FIELDS)) {
    const claimed = asVersion(shape.entries.find((entry) => entry.key === "version")?.value);
    const inner = shape.entries.find((entry) => entry.key === "stream")?.value;
    const innerKeys: string[] = [];
    if (inner && inner.kind === "map") {
      for (const entry of inner.entries) innerKeys.push(entry.key);
    }
    if (claimed === null) {
      return verdict("unrecognised", null, writtenVersion, "tagged envelope carries a non-u32 version");
    }
    if (!sameKeys(innerKeys, V1_STREAM_FIELDS)) {
      return verdict(
        claimed > writtenVersion ? "future" : "unrecognised",
        claimed,
        writtenVersion,
        claimed > writtenVersion
          ? `inner record of a version this build has never seen (v${claimed})`
          : `tagged envelope does not wrap a known stream layout (inner keys: [${innerKeys.join(", ")}])`,
      );
    }
    return classifyVersionTag(claimed, writtenVersion);
  }
  if (sameKeys(keys, V1_STREAM_FIELDS)) {
    return verdict(
      "legacy",
      STREAM_RECORD_VERSION_V1,
      writtenVersion,
      "untagged v1 stream map (written before record versioning)",
    );
  }
  return verdict(
    "unrecognised",
    null,
    writtenVersion,
    `keys [${keys.join(", ")}] match no known layout`,
  );
}

function actionFor(layout: RecordLayout): MigrationRow["action"] {
  if (layout === "legacy") return "migrate";
  if (layout === "current") return "none";
  return "manual-review";
}

/** Compare stream ids numerically: `10` sorts after `9`, not after `1`. */
function compareIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Build the migration report for a walked set of records, ordered by stream id. */
export function buildMigrationReport(
  contract: string,
  writtenVersion: number,
  records: readonly { readonly streamId: string; readonly shape: ScValShape }[],
): MigrationReport {
  const rows: MigrationRow[] = records
    .map(({ streamId, shape }) => {
      const result = classifyRecord(shape, writtenVersion);
      return {
        streamId,
        layout: result.layout,
        fromVersion: result.version,
        action: actionFor(result.layout),
        detail: result.detail,
      };
    })
    .sort((a, b) => compareIds(a.streamId, b.streamId));
  return { contract, writtenVersion, rows };
}

/** Build the migration report from the version tags read back from the chain. */
export function buildReportFromVersions(
  contract: string,
  writtenVersion: number,
  versions: readonly { readonly streamId: string; readonly version: number | null }[],
): MigrationReport {
  const rows: MigrationRow[] = versions
    .map(({ streamId, version }) => {
      const result = classifyVersionTag(version, writtenVersion);
      return {
        streamId,
        layout: result.layout,
        fromVersion: result.version,
        action: actionFor(result.layout),
        detail: result.detail,
      };
    })
    .sort((a, b) => compareIds(a.streamId, b.streamId));
  return { contract, writtenVersion, rows };
}

export const LAYOUT_LABELS: readonly RecordLayout[] = ["current", "legacy", "future", "unrecognised"];

/**
 * Stable content hash of a report (FNV-1a over the ordered verdicts). Two runs
 * that disagree about any layout produce different fingerprints, so a captured
 * report can be diffed without a crypto dependency in the browser bundle.
 */
export function reportFingerprint(report: MigrationReport): string {
  const canonical = report.rows
    .map((row) => `${row.streamId}:${row.layout}:${row.fromVersion ?? "-"}:${row.action}`)
    .join("|");
  let hash = 0x811c9dc5;
  for (const character of canonical) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

export function countByLayout(report: MigrationReport): Record<RecordLayout, number> {
  const counts: Record<RecordLayout, number> = {
    current: 0,
    legacy: 0,
    future: 0,
    unrecognised: 0,
  };
  for (const row of report.rows) counts[row.layout] += 1;
  return counts;
}

/** Plain-text table for terminal output. */
export function renderReportTable(report: MigrationReport): string {
  const header = ["stream", "layout", "from", "action", "detail"];
  const body = report.rows.map((row) => [
    row.streamId,
    row.layout,
    row.fromVersion === null ? "-" : `v${row.fromVersion}`,
    row.action,
    row.detail,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => (cells[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (cell ?? "").padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  if (body.length === 0) return `${line(header)}\n(no streams found)`;
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
    "",
    `report fingerprint: ${reportFingerprint(report)}`,
  ].join("\n");
}

/** Markdown report — the shape of the golden file under `docs/`. */
export function renderReportMarkdown(report: MigrationReport): string {
  const counts = countByLayout(report);
  const pending = report.rows.filter((row) => row.action === "migrate").length;
  const blocked = report.rows.filter((row) => row.action === "manual-review").length;
  const rows = report.rows.map(
    (row) =>
      `| ${row.streamId} | ${row.layout} | ${row.fromVersion === null ? "-" : `v${row.fromVersion}`} | ${row.action} | ${row.detail} |`,
  );
  return [
    "# Migration audit report",
    "",
    "<!-- Generated by `bash scripts/migrate_audit.sh --generate` from",
    "     tests/migration-audit/records.json. Do not edit by hand. -->",
    "",
    `Contract: \`${report.contract}\`. Records written by this build carry layout tag **v${report.writtenVersion}**.`,
    "",
    "`scripts/migrate_audit.sh` walks the per-address discovery indexes, reads every",
    "stream record it can reach and classifies its storage layout:",
    "",
    "- **current** — tagged with this build's version; nothing to do.",
    "- **legacy** — reachable by every read path today, and one permissionless",
    "  `migrate_stream_version(stream_id)` call rewrites it onto the current layout.",
    "  The call is idempotent: re-running it on a current record is a byte-for-byte no-op.",
    "- **future** / **unrecognised** — the contract refuses to guess at these and fails",
    "  closed with `SchemaVersionUnsupported` on every path that touches the record.",
    "  They need a build that understands the layout; the migration path will not touch them.",
    "",
    "| stream | layout | from | action | detail |",
    "| --- | --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows : ["| _none walked_ | | | | |"]),
    "",
    "## Summary",
    "",
    `- Records walked: ${report.rows.length}`,
    `- current: ${counts.current}`,
    `- legacy: ${counts.legacy}`,
    `- future: ${counts.future}`,
    `- unrecognised: ${counts.unrecognised}`,
    `- Pending migration: ${pending}`,
    `- Blocked (fail closed until a build understands them): ${blocked}`,
    `- Report fingerprint: ${reportFingerprint(report)}`,
    "",
  ].join("\n");
}
