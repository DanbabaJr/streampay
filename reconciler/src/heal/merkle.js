//! Deterministic state roots used by heal proposals and dry-run previews.

import { createHash } from "node:crypto";

export const STATE_LEAF_PREFIX = "STREAMPAY_STATE_LEAF_V1\0";
export const MERKLE_NODE_PREFIX = "STREAMPAY_MERKLE_NODE_V1\0";
export const MERKLE_EMPTY_PREFIX = "STREAMPAY_MERKLE_EMPTY_V1\0";

function sha256(data) {
  return createHash("sha256").update(data).digest();
}

export function canonicalRecord(record) {
  return JSON.stringify({
    streamId: String(record.streamId),
    deposit: String(record.data?.deposit ?? "0"),
    withdrawn: String(record.data?.withdrawn ?? "0"),
    status: String(record.data?.status ?? "Active"),
  });
}

export function computeStateRoot(records, contractId = "") {
  const leaves = [...records]
    .map((record) => ({
      streamId: String(record.streamId),
      hash: sha256(
        Buffer.concat([
          Buffer.from(STATE_LEAF_PREFIX, "utf8"),
          Buffer.from(`${contractId}:${canonicalRecord(record)}`, "utf8"),
        ])
      ),
    }))
    .sort((left, right) => left.streamId.localeCompare(right.streamId))
    .map((leaf) => leaf.hash);

  if (leaves.length === 0) {
    return sha256(Buffer.from(MERKLE_EMPTY_PREFIX, "utf8")).toString("hex");
  }

  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      next.push(
        sha256(
          Buffer.concat([
            Buffer.from(MERKLE_NODE_PREFIX, "utf8"),
            left,
            right,
          ])
        )
      );
    }
    level = next;
  }
  return level[0].toString("hex");
}

export function stableDocumentHash(value) {
  return createHash("sha256").update(JSON.stringify(sortDeep(value))).digest("hex");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep(value[key])])
    );
  }
  return value;
}
