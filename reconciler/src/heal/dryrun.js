//! Dry-run preview for a scoped heal: the exact records that would change and
//! the resulting state root, computed without writing anything.

import { compareStates } from "../engine/tolerance.js";
import { computeStateRoot, stableDocumentHash } from "./merkle.js";

function addTarget(targets, state) {
  if (state?.streamId !== undefined) targets.set(String(state.streamId), state);
}

export function targetMap(states) {
  const targets = new Map();
  if (Array.isArray(states)) {
    for (const state of states) addTarget(targets, state);
  } else if (states instanceof Map) {
    for (const state of states.values()) addTarget(targets, state);
  } else if (states && typeof states === "object") {
    for (const state of Object.values(states)) addTarget(targets, state);
  }
  return targets;
}

export function normalizeRecord(record) {
  return {
    streamId: String(record.streamId),
    ledger: Number(record.ledger ?? 0),
    timestamp: record.timestamp ?? new Date(0).toISOString(),
    data: {
      deposit: String(record.data?.deposit ?? "0"),
      withdrawn: String(record.data?.withdrawn ?? "0"),
      status: record.data?.status ?? "Active",
    },
  };
}

function correctedRecord(before, target) {
  return {
    streamId: String(target.streamId),
    ledger: Number(target.ledger ?? before?.ledger ?? 0),
    timestamp: target.timestamp ?? before?.timestamp ?? new Date(0).toISOString(),
    data: {
      deposit: String(target.data?.deposit ?? "0"),
      withdrawn: String(target.data?.withdrawn ?? "0"),
      status: target.data?.status ?? "Active",
    },
  };
}

/**
 * Compute the changes a scoped heal would apply. `records` is the current
 * projection; `targets` is the chain-agreed state for each candidate.
 */
export function previewScope({ records, targets, scope, contractId = "", tolerance = {} }) {
  const normalized = records.map(normalizeRecord);
  const byId = new Map(normalized.map((record) => [record.streamId, record]));
  const targetById = targets instanceof Map ? targets : targetMap(targets);
  const scopeIds = scope.streamIds ?? [];
  const changes = [];
  const unresolved = [];

  for (const streamId of scopeIds) {
    const target = targetById.get(String(streamId));
    if (!target) {
      unresolved.push(String(streamId));
      continue;
    }
    const before = byId.get(String(streamId)) ?? null;
    const after = correctedRecord(before, target);
    if (before) {
      const comparison = compareStates(before, after, tolerance);
      if (comparison.equal) continue;
      changes.push({
        streamId: String(streamId),
        before,
        after,
        fields: comparison.mismatches,
      });
    } else {
      changes.push({
        streamId: String(streamId),
        before: null,
        after,
        fields: ["record"],
      });
    }
  }

  const corrected = new Map(normalized.map((record) => [record.streamId, record]));
  for (const change of changes) corrected.set(change.streamId, change.after);
  const beforeRoot = computeStateRoot(normalized, contractId);
  const afterRoot = computeStateRoot([...corrected.values()], contractId);
  const preview = {
    changes,
    unresolved,
    beforeRoot,
    afterRoot,
    scope: {
      streamIds: scopeIds.map(String),
      ...(scope.ledgerRange ? { ledgerRange: scope.ledgerRange } : {}),
    },
    computedAt: new Date().toISOString(),
  };
  preview.previewHash = stableDocumentHash({
    scope: preview.scope,
    changes: preview.changes,
    beforeRoot,
    afterRoot,
  });
  return preview;
}
