// Unit tests for the event-schema compatibility gate.
//
// Run: node --test scripts/event_compat_check.test.mjs
// The `renamed event field ...` test is the seeded break demo from
// schemas/events/README.md: it shows exactly how CI goes red (and what the
// diff message looks like) when an event field is renamed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkRegistries, REGISTRY_PATH, CHANGELOG_PATH } from "./event_compat_check.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function registry(events, definitions = {}) {
  return { registry_version: 1, events, definitions };
}

const STREAM_CREATED = {
  event_key: "stream_created",
  fingerprint: "sha256:aaa",
  topics: [{ name: "stream_id", type: "u64" }],
  data: [
    { name: "sender", type: "Address" },
    { name: "deposit", type: "i128" },
  ],
};

test("identical registries pass", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const head = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const { errors, warnings } = checkRegistries(base, head, "");
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("BREAKING (seeded demo): renaming an event field fails with a clear diff", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const renamed = structuredClone(STREAM_CREATED);
  renamed.data[0] = { name: "from_address", type: "Address" };
  const head = registry({ StreamCreated: renamed });

  const { errors } = checkRegistries(base, head, "");
  assert.ok(
    errors.some((e) => e.includes("REMOVED data field StreamCreated.sender: Address")),
    `expected a removal error, got: ${errors.join("\n")}`
  );
  assert.ok(
    errors.some((e) => e.includes("MISSING CHANGELOG: added field StreamCreated.from_address")),
    `expected the addition to demand a changelog, got: ${errors.join("\n")}`
  );
});

test("type change of an existing field fails", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const changed = structuredClone(STREAM_CREATED);
  changed.data[1] = { name: "deposit", type: "i64" };
  const head = registry({ StreamCreated: changed });
  const { errors } = checkRegistries(base, head, "");
  assert.ok(errors.some((e) => e === "TYPE CHANGE StreamCreated.deposit: i128 -> i64"), errors.join("\n"));
});

test("removed event fails", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED), Withdrawn: {
    event_key: "withdrawn", fingerprint: "sha256:bbb",
    topics: [{ name: "stream_id", type: "u64" }], data: [],
  } });
  const head = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const { errors } = checkRegistries(base, head, "");
  assert.ok(errors.some((e) => e.includes('REMOVED event Withdrawn (key "withdrawn")')), errors.join("\n"));
});

test("renamed event key fails", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const changed = structuredClone(STREAM_CREATED);
  changed.event_key = "stream_opened";
  const head = registry({ StreamCreated: changed });
  const { errors } = checkRegistries(base, head, "");
  assert.ok(errors.some((e) => e.includes('RENAMED event key for StreamCreated: "stream_created" -> "stream_opened"')), errors.join("\n"));
});

test("topic layout changes are breaking, including reordering", () => {
  const base = registry({ StorageMigrated: {
    event_key: "storage_migrated", fingerprint: "sha256:ccc",
    topics: [{ name: "from_version", type: "u32" }, { name: "to_version", type: "u32" }],
    data: [],
  } });
  const head = registry({ StorageMigrated: {
    event_key: "storage_migrated", fingerprint: "sha256:ccc",
    topics: [{ name: "to_version", type: "u32" }, { name: "from_version", type: "u32" }],
    data: [],
  } });
  const { errors } = checkRegistries(base, head, "");
  assert.ok(errors.some((e) => e.includes("topic at position 0 changed name")), errors.join("\n"));
});

test("data field reordering is neutral (symbol-keyed map on the wire)", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const swapped = structuredClone(STREAM_CREATED);
  swapped.data = [swapped.data[1], swapped.data[0]];
  const head = registry({ StreamCreated: swapped });
  const { errors, warnings } = checkRegistries(base, head, "");
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("additive change without a changelog entry fails; with one it warns and passes", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const extended = structuredClone(STREAM_CREATED);
  extended.data.push({ name: "memo", type: "Address" });
  extended.fingerprint = "sha256:new";
  const head = registry({ StreamCreated: extended });

  const without = checkRegistries(base, head, "# changelog with nothing about it");
  assert.ok(without.errors.some((e) => e.includes("MISSING CHANGELOG: added field StreamCreated.memo")), without.errors.join("\n"));
  assert.equal(without.warnings.length, 1);

  const withEntry = checkRegistries(base, head, "## Unreleased\n- StreamCreated: added `memo` field\n");
  assert.deepEqual(withEntry.errors, []);
  assert.equal(withEntry.warnings.length, 1);
});

test("new events need a changelog entry too", () => {
  const base = registry({ StreamCreated: structuredClone(STREAM_CREATED) });
  const head = registry({
    StreamCreated: structuredClone(STREAM_CREATED),
    StreamExtended: {
      event_key: "stream_extended", fingerprint: "sha256:ddd",
      topics: [{ name: "stream_id", type: "u64" }], data: [{ name: "extra", type: "u64" }],
    },
  });
  const { errors } = checkRegistries(base, head, "StreamExtended gained extra");
  assert.deepEqual(errors, []);
  const missing = checkRegistries(base, head, "");
  assert.ok(missing.errors.some((e) => e.includes("MISSING CHANGELOG: new event StreamExtended")), missing.errors.join("\n"));
});

test("breaking a referenced struct definition fails", () => {
  const defs = { StreamPolicy: {
    fingerprint: "sha256:p1",
    fields: [{ name: "min_rate", type: "i128" }, { name: "min_duration", type: "u64" }],
  } };
  const base = registry({ StreamPolicySet: {
    event_key: "stream_policy_set", fingerprint: "sha256:e1", topics: [],
    data: [{ name: "new_policy", type: "StreamPolicy" }],
  } }, defs);
  const shrunk = structuredClone(defs);
  shrunk.StreamPolicy.fields.pop();
  shrunk.StreamPolicy.fingerprint = "sha256:p2";
  const head = registry({ StreamPolicySet: {
    event_key: "stream_policy_set", fingerprint: "sha256:e2", topics: [],
    data: [{ name: "new_policy", type: "StreamPolicy" }],
  } }, shrunk);
  const { errors } = checkRegistries(base, head, "");
  assert.ok(errors.some((e) => e.includes("REMOVED field StreamPolicy.min_duration")), errors.join("\n"));
});

test("breaking a referenced enum definition fails; adding a variant needs a changelog", () => {
  const defs = { OwnershipRole: {
    kind: "enum",
    fingerprint: "sha256:r1",
    variants: ["Recipient", "Sender"],
  } };
  const event = {
    event_key: "ownership_accepted", fingerprint: "sha256:e1", topics: [],
    data: [{ name: "role", type: "OwnershipRole" }],
  };
  const base = registry({ OwnershipAccepted: structuredClone(event) }, defs);

  const shrunk = structuredClone(defs);
  shrunk.OwnershipRole.variants = ["Sender"];
  shrunk.OwnershipRole.fingerprint = "sha256:r2";
  const removed = registry({ OwnershipAccepted: { ...event, fingerprint: "sha256:e2" } }, shrunk);
  const { errors } = checkRegistries(base, removed, "");
  assert.ok(
    errors.some((e) => e.includes("REMOVED variant OwnershipRole.Recipient")),
    errors.join("\n")
  );

  const grown = structuredClone(defs);
  grown.OwnershipRole.variants = ["Guardian", "Recipient", "Sender"];
  grown.OwnershipRole.fingerprint = "sha256:r3";
  const added = registry({ OwnershipAccepted: { ...event, fingerprint: "sha256:e3" } }, grown);
  const undocumented = checkRegistries(base, added, "");
  assert.ok(
    undocumented.errors.some((e) => e.includes("MISSING CHANGELOG: added variant OwnershipRole.Guardian")),
    undocumented.errors.join("\n")
  );
  const documented = checkRegistries(base, added, "## Unreleased\n- OwnershipAccepted: OwnershipRole gained the `Guardian` variant\n");
  assert.deepEqual(documented.errors, []);
  assert.equal(documented.warnings.length, 1);
});

test("the committed registry passes the checker against itself", () => {
  const text = readFileSync(path.join(REPO_ROOT, REGISTRY_PATH), "utf8");
  const registryDoc = JSON.parse(text);
  const changelog = readFileSync(path.join(REPO_ROOT, CHANGELOG_PATH), "utf8");
  const { errors, warnings } = checkRegistries(registryDoc, registryDoc, changelog);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("CLI: --base of a ref with no registry passes as the introduction", (t) => {
  let rootCommit = "";
  try {
    rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim().split("\n").pop();
  } catch {
    /* shallow clone */
  }
  if (!rootCommit) {
    t.skip("no full history available (shallow clone)");
    return;
  }
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "event_compat_check.mjs"), "--base", rootCommit],
    { encoding: "utf8", cwd: REPO_ROOT }
  );
  assert.ok(out.includes("introduces the registry"), out);
});

test("CLI: --base of a ref the clone does not have fails loudly, not vacuously", () => {
  let code = 0;
  let stderr = "";
  try {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "event_compat_check.mjs"), "--base", "not-a-real-ref"],
      { encoding: "utf8", cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr ?? "");
  }
  assert.equal(code, 1);
  assert.ok(stderr.includes("not a commit available in this clone"), stderr);
});

test("CLI: --base-file of the current registry exits 0", () => {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "event_compat_check.mjs"), "--base-file", path.join(REPO_ROOT, REGISTRY_PATH)],
    { encoding: "utf8" }
  );
  assert.match(out, /PASSED/);
});
