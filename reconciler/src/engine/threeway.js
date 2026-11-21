//! Three-way reconciliation across Soroban RPC, Horizon and the indexer
//! projection. The third source turns a bare "mismatch" into an attributable
//! layer: chain read, ingestion, or projection.

import { createHash } from "node:crypto";
import {
  alignToAsOf,
  compareStates,
  normalizeStatus,
  pinLedger,
} from "./tolerance.js";
import { DivergenceSuppressor } from "./suppression.js";

export const SOURCES = ["rpc", "horizon", "projection"];

const SOURCE_LABEL = {
  rpc: "Soroban RPC",
  horizon: "Horizon",
  projection: "indexer projection",
};

const PAIR_LABEL = {
  "rpc:horizon": "rpc↔horizon",
  "rpc:projection": "rpc↔projection",
  "horizon:projection": "horizon↔projection",
};

const ROUTES = {
  chain_read_rpc: "rpc-operator",
  chain_read_horizon: "horizon-operator",
  ingestion: "indexer-ingest",
  projection: "indexer-projection",
  unknown: "on-call-triage",
};

function pairKey(left, right) {
  return [left, right].sort().join(":");
}

function pairLabel(left, right) {
  return PAIR_LABEL[pairKey(left, right)] ?? `${left}↔${right}`;
}

function stableId(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function normalizeSnapshot(snapshot) {
  return {
    source: snapshot.source,
    available: snapshot.available !== false,
    asOfLedger: Number.isFinite(snapshot.asOfLedger) ? snapshot.asOfLedger : null,
    latestLedger: Number.isFinite(snapshot.latestLedger) ? snapshot.latestLedger : snapshot.asOfLedger,
    fetchedAt: snapshot.fetchedAt ?? new Date().toISOString(),
    error: snapshot.error ?? null,
    states: Array.isArray(snapshot.states)
      ? snapshot.states.map((state) => ({
          ...state,
          data: {
            ...state.data,
            status: normalizeStatus(state.data?.status),
          },
        }))
      : [],
  };
}

function indexSnapshots(snapshots) {
  const bySource = new Map();
  for (const raw of snapshots) {
    if (!SOURCES.includes(raw?.source)) {
      throw new Error(`unknown reconciliation source: ${raw?.source}`);
    }
    if (bySource.has(raw.source)) {
      throw new Error(`duplicate reconciliation source: ${raw.source}`);
    }
    bySource.set(raw.source, normalizeSnapshot(raw));
  }
  return bySource;
}

function stateEvidence(state) {
  if (!state) return { present: false };
  return {
    present: true,
    streamId: state.streamId,
    ledger: state.ledger,
    timestamp: state.timestamp,
    data: state.data,
  };
}

function recordLedger(state) {
  return Number.isFinite(state?.ledger) ? state.ledger : null;
}

function ledgerLag(left, right) {
  const a = recordLedger(left);
  const b = recordLedger(right);
  if (a === null || b === null) return null;
  return Math.abs(a - b);
}

function missingLayer(absent, presentSources, equalityByPair) {
  if (presentSources.length !== 2) return { layer: "unknown", reason: "fewer_than_two_confirming_sources" };
  const [first, second] = presentSources;
  const confirmingPair = equalityByPair.get(pairKey(first, second));
  if (!confirmingPair?.equal) {
    return { layer: "unknown", reason: "confirming_sources_disagree" };
  }
  if (absent === "projection") {
    return {
      layer: "ingestion",
      reason: "rpc_and_horizon_agree_but_projection_lacks_record",
    };
  }
  if (absent === "horizon") {
    return {
      layer: "chain_read_horizon",
      reason: "rpc_and_projection_agree_but_horizon_lacks_record",
    };
  }
  return {
    layer: "chain_read_rpc",
    reason: "horizon_and_projection_agree_but_rpc_lacks_record",
  };
}

function oddSourceLayer(odd, absentSources) {
  if (absentSources.length === 1) {
    if (odd === "projection") return { layer: "projection", reason: "projection_differs_from_agreeing_chain_sources" };
    if (odd === "horizon") return { layer: "chain_read_horizon", reason: "horizon_differs_from_agreeing_rpc_and_projection" };
    return { layer: "chain_read_rpc", reason: "rpc_differs_from_agreeing_horizon_and_projection" };
  }
  if (odd === "projection") {
    return { layer: "projection", reason: "projection_differs_from_unanimous_chain_sources" };
  }
  if (odd === "horizon") {
    return { layer: "chain_read_horizon", reason: "horizon_differs_from_unanimous_rpc_and_projection" };
  }
  return { layer: "chain_read_rpc", reason: "rpc_differs_from_unanimous_horizon_and_projection" };
}

/**
 * Pinned three-way reconciler. It never declares a clean verdict unless all
 * three sources were available, aligned to the pinned ledger, and compared.
 */
export class ThreeWayReconciler {
  constructor(options = {}) {
    this.tolerance = options.tolerance ?? { absolute: 0, relativePpm: 0 };
    this.maxLagLedgers = options.maxLagLedgers ?? 5;
    this.suppressor = options.suppressor ?? new DivergenceSuppressor();
    this.now = options.now ?? (() => Date.now());
  }

  reconcile({ snapshots, streamIds, asOfLedger, requestedAsOfLedger } = {}) {
    const generatedAt = new Date(this.now()).toISOString();
    const bySource = indexSnapshots(snapshots ?? []);
    const pinned = pinLedger([...bySource.values()], asOfLedger ?? requestedAsOfLedger);
    if (pinned === null) {
      return this.insufficientReport(generatedAt, requestedAsOfLedger ?? null, "no_source_had_a_ledger");
    }

    const excluded = [];
    const compared = [];
    for (const source of SOURCES) {
      const snapshot = bySource.get(source);
      if (!snapshot) {
        excluded.push({ source, reason: "not_configured" });
        continue;
      }
      if (!snapshot.available) {
        excluded.push({ source, reason: "unavailable", error: snapshot.error });
        continue;
      }
      const alignment = alignToAsOf(snapshot, pinned, this.maxLagLedgers);
      if (!alignment.aligned) {
        excluded.push({
          source,
          reason: alignment.reason,
          lagLedgers: alignment.lagLedgers,
          asOfLedger: snapshot.asOfLedger,
        });
        continue;
      }
      compared.push({ ...snapshot, alignment });
    }

    const mode = compared.length === 3
      ? "three_way"
      : compared.length === 2
        ? "degraded_two_way"
        : "insufficient_sources";

    const caveats = [];
    for (const item of excluded) {
      if (item.reason === "not_configured") {
        caveats.push(`${SOURCE_LABEL[item.source]} is not configured; ${item.source} cannot be compared.`);
      } else {
        caveats.push(`${SOURCE_LABEL[item.source]} is excluded (${item.reason}); no clean verdict is possible.`);
      }
    }
    if (mode === "degraded_two_way") {
      caveats.push(
        "Degraded to two-way reconciliation: a disagreement cannot be attributed to the missing source."
      );
    }
    if (mode === "insufficient_sources") {
      return this.insufficientReport(generatedAt, pinned, "fewer_than_two_aligned_sources", {
        excluded,
        caveats,
      });
    }

    const comparedSources = compared.map((snapshot) => snapshot.source);
    const maps = new Map(compared.map((snapshot) => [snapshot.source, new Map(snapshot.states.map((state) => [state.streamId, state]))]));
    const requested = Array.isArray(streamIds) && streamIds.length > 0 ? streamIds : null;
    const allIds = new Set(requested ?? []);
    for (const map of maps.values()) {
      for (const id of map.keys()) allIds.add(id);
    }

    const diagnoses = [];
    const suppressed = [];
    let inSync = 0;
    let tolerated = 0;
    let withinLag = 0;
    let notObserved = 0;

    for (const streamId of [...allIds].sort()) {
      const states = new Map();
      for (const source of comparedSources) {
        const state = maps.get(source).get(streamId);
        if (state) states.set(source, state);
      }
      const presentSources = comparedSources.filter((source) => states.has(source));
      const absentSources = comparedSources.filter((source) => !states.has(source));

      if (presentSources.length === 0) {
        notObserved += 1;
        continue;
      }

      const pairResults = new Map();
      for (let i = 0; i < presentSources.length; i += 1) {
        for (let j = i + 1; j < presentSources.length; j += 1) {
          const left = presentSources[i];
          const right = presentSources[j];
          const comparison = compareStates(states.get(left), states.get(right), this.tolerance);
          const lag = !comparison.equal && comparison.mismatches.length > 0
            ? ledgerLag(states.get(left), states.get(right))
            : null;
          const isLag = !comparison.equal && lag !== null && lag > 0 && lag <= this.maxLagLedgers;
          pairResults.set(pairKey(left, right), {
            pair: pairLabel(left, right),
            left,
            right,
            equal: comparison.equal,
            tolerated: comparison.tolerated,
            lag: isLag,
            lagLedgers: lag,
            mismatches: comparison.mismatches,
            fields: comparison.fields,
          });
        }
      }

      if (presentSources.length === comparedSources.length && pairResults.size === 3) {
        const disagreeing = [...pairResults.values()].filter((pair) => !pair.equal && !pair.lag);
        if (disagreeing.length === 0) {
          const anyTolerated = [...pairResults.values()].some((pair) => pair.tolerated);
          const anyLag = [...pairResults.values()].some((pair) => pair.lag);
          if (anyLag) withinLag += 1;
          else if (anyTolerated) tolerated += 1;
          else inSync += 1;
          this.suppressor.clearStream(streamId);
          continue;
        }
      } else if (absentSources.length === 0) {
        const disagreeing = [...pairResults.values()].filter((pair) => !pair.equal && !pair.lag);
        if (disagreeing.length === 0) {
          const anyLag = [...pairResults.values()].some((pair) => pair.lag);
          if (anyLag) withinLag += 1;
          else if ([...pairResults.values()].some((pair) => pair.tolerated)) tolerated += 1;
          else inSync += 1;
          this.suppressor.clearStream(streamId);
          continue;
        }
      }

      const diagnosis = this.buildDiagnosis({
        streamId,
        states,
        presentSources,
        absentSources,
        pairResults,
        comparedSources,
        pinned,
        mode,
        caveats,
      });
      const observation = this.suppressor.observe(
        diagnosis.id,
        true,
        { streamId, layer: diagnosis.suspectedLayer, pairs: diagnosis.disagreeingPairs }
      );
      if (observation.suppressed) {
        suppressed.push({
          id: diagnosis.id,
          recordId: streamId,
          pair: diagnosis.disagreeingPairs.join(","),
          layer: diagnosis.suspectedLayer,
          reason: observation.reason,
          suppressedUntil: observation.suppressedUntil,
        });
      } else {
        diagnosis.suppressions = { occurrences: observation.occurrences, firstSeenAt: observation.firstSeenAt };
        diagnoses.push(diagnosis);
      }
    }

    const byLayer = {};
    for (const diagnosis of diagnoses) {
      byLayer[diagnosis.suspectedLayer] = (byLayer[diagnosis.suspectedLayer] ?? 0) + 1;
    }

    const verdict = diagnoses.length > 0 || suppressed.length > 0
      ? "divergent"
      : caveats.length > 0
        ? "clean_degraded"
        : "clean";

    return {
      schema: "streampay-reconciliation-report/v1",
      generatedAt,
      asOfLedger: pinned,
      requestedAsOfLedger: requestedAsOfLedger ?? asOfLedger ?? null,
      mode,
      coverage: {
        expectedSources: SOURCES.length,
        comparedSources,
        excluded,
        complete: comparedSources.length === SOURCES.length,
      },
      caveats,
      verdict,
      clean: verdict === "clean",
      summary: {
        checked: allIds.size,
        inSync,
        tolerated,
        withinLag,
        divergent: diagnoses.length,
        suppressed: suppressed.length,
        notObserved,
        byLayer,
      },
      tolerance: this.tolerance,
      diagnoses: diagnoses.sort((a, b) => a.recordId.localeCompare(b.recordId) || a.id.localeCompare(b.id)),
      suppressed,
    };
  }

  buildDiagnosis({
    streamId,
    states,
    presentSources,
    absentSources,
    pairResults,
    comparedSources,
    pinned,
    mode,
    caveats,
  }) {
    const pairs = [...pairResults.values()];
    const disagreeing = pairs.filter((pair) => !pair.equal && !pair.lag);
    const disagreeingPairs = disagreeing.length > 0
      ? disagreeing.map((pair) => pair.pair).sort()
      : absentSources.flatMap((absent) =>
          presentSources.map((present) => pairLabel(absent, present))
        ).sort();

    let layer = "unknown";
    let reason = "no_majority";
    let confidence = "low";

    if (absentSources.length > 0) {
      if (absentSources.length === 1) {
        const result = missingLayer(absentSources[0], presentSources, pairResults);
        layer = result.layer;
        reason = result.reason;
        confidence = layer === "unknown" ? "low" : "high";
      }
    } else if (presentSources.length === comparedSources.length && presentSources.length === 3) {
      if (disagreeing.length >= 3) {
        layer = "unknown";
        reason = "all_three_sources_disagree";
        confidence = "low";
      } else if (disagreeing.length === 2) {
        const shared = comparedSources.filter((source) =>
          disagreeing.every((pair) => pair.left === source || pair.right === source)
        );
        if (shared.length === 1) {
          const result = oddSourceLayer(shared[0], absentSources);
          layer = result.layer;
          reason = result.reason;
          confidence = "high";
        }
      }
    } else {
      layer = "unknown";
      reason = "two_way_source_disagreement";
      confidence = "low";
    }

    if (mode !== "three_way") {
      confidence = "low";
      if (reason === "no_majority") reason = "degraded_mode_no_tiebreaker";
    }

    const checkType = absentSources.length > 0
      ? "missing_record"
      : disagreeing.some((pair) => pair.mismatches.includes("deposit") || pair.mismatches.includes("withdrawn"))
        ? "stream_balance"
        : "stream_status";

    const severity = checkType === "missing_record"
      ? absentSources.includes("projection") ? "critical" : "warning"
      : checkType === "stream_balance" ? "critical" : "warning";

    const id = stableId([streamId, checkType, layer, disagreeingPairs.join(","), String(pinned)]);
    const divergence = [...disagreeing, ...pairs.filter((pair) => pair.lag)];

    return {
      id,
      recordId: streamId,
      checkType,
      severity,
      disagreeingPairs,
      suspectedLayer: layer,
      owner: ROUTES[layer] ?? ROUTES.unknown,
      confidence,
      reason,
      evidence: {
        asOfLedger: pinned,
        mode,
        caveats,
        tolerance: this.tolerance,
        sources: Object.fromEntries(
          SOURCES.map((source) => [source, stateEvidence(states.get(source))])
        ),
        absentSources,
        presentSources,
        pairComparisons: divergence.map((pair) => ({
          pair: pair.pair,
          mismatches: pair.mismatches,
          lag: pair.lag,
          lagLedgers: pair.lagLedgers,
          tolerated: pair.tolerated,
          fields: pair.fields,
        })),
        rule: reason,
      },
    };
  }

  insufficientReport(generatedAt, pinned, reason, extra = {}) {
    const excluded = extra.excluded ?? [];
    const caveats = [
      ...(extra.caveats ?? []),
      "Insufficient source coverage: reconciliation produced no verdict and no clean bill of health.",
    ];
    return {
      schema: "streampay-reconciliation-report/v1",
      generatedAt,
      asOfLedger: pinned,
      requestedAsOfLedger: pinned,
      mode: "insufficient_sources",
      coverage: {
        expectedSources: SOURCES.length,
        comparedSources: [],
        excluded,
        complete: false,
      },
      caveats,
      verdict: "insufficient_coverage",
      clean: false,
      summary: {
        checked: 0,
        inSync: 0,
        tolerated: 0,
        withinLag: 0,
        divergent: 0,
        suppressed: 0,
        notObserved: 0,
        byLayer: {},
        unavailableReason: reason,
      },
      tolerance: this.tolerance,
      diagnoses: [],
      suppressed: [],
    };
  }
}

export { pairLabel };
