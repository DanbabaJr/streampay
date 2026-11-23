//! Governance-gated heal proposals: scoped corrective actions that can only
//! execute after timelock approval, with a dry-run preview verified at
//! execution time.

import { verify as verifySignature } from "node:crypto";
import { compareStates } from "../engine/tolerance.js";
import {
  computeStateRoot,
  stableDocumentHash,
} from "./merkle.js";
import {
  normalizeRecord,
  previewScope,
  targetMap,
} from "./dryrun.js";

const ACTION_TYPES = new Set(["rebuild_record", "replay_ledger_range", "resync_cursor"]);

export class HealGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HealGateError";
    this.code = code;
  }
}

function milliseconds(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

function normalizeScope(action) {
  const streamIds = [...new Set((action?.scope?.streamIds ?? []).map(String))];
  const ledgerRange = action?.scope?.ledgerRange
    ? {
        from: Number(action.scope.ledgerRange.from),
        to: Number(action.scope.ledgerRange.to),
      }
    : null;
  return { streamIds, ledgerRange };
}

function scopeHash(action) {
  const scope = normalizeScope(action);
  return stableDocumentHash({ type: action.type, scope, reason: action.reason ?? null });
}

function evidenceTargets(diagnosis) {
  const sources = diagnosis?.evidence?.sources ?? {};
  const chosen = sources.rpc?.present
    ? sources.rpc
    : sources.horizon?.present
      ? sources.horizon
      : sources.projection?.present
        ? sources.projection
        : null;
  if (!chosen) return new Map();
  return targetMap([{
    streamId: String(chosen.streamId ?? diagnosis.recordId),
    ledger: chosen.ledger,
    timestamp: chosen.timestamp,
    data: chosen.data,
  }]);
}

function chooseAction(diagnosis, options = {}) {
  const maxLedgerRange = options.maxLedgerRange ?? 1000;
  const streamId = String(diagnosis.recordId);
  if (diagnosis.suspectedLayer === "projection") {
    return {
      type: "rebuild_record",
      scope: { streamIds: [streamId] },
      reason: diagnosis.reason,
    };
  }
  if (diagnosis.suspectedLayer === "ingestion" && diagnosis.checkType === "missing_record") {
    const state = diagnosis.evidence?.sources?.rpc?.present
      ? diagnosis.evidence.sources.rpc
      : diagnosis.evidence?.sources?.horizon;
    const from = Number(state?.ledger);
    const to = Number(diagnosis.evidence?.asOfLedger);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      return { skip: "no_bounded_ledger_range" };
    }
    if (to - from > maxLedgerRange) {
      return { skip: "ledger_range_exceeds_bound" };
    }
    return {
      type: "replay_ledger_range",
      scope: { streamIds: [streamId], ledgerRange: { from, to } },
      reason: diagnosis.reason,
    };
  }
  return { skip: "no_safe_heal_for_layer" };
}

/**
 * Generate a proposal for every attributable projection divergence. Chain-read
 * and ambiguous diagnoses are never auto-healed.
 */
/**
 * Turn divergences in a three-way report into governance proposals. Every
 * proposal stays scoped to the diagnosis that produced it.
 *
 * @param {{
 *   report?: any,
 *   records?: Array<any>,
 *   store?: any,
 *   contractId?: string,
 *   maxLedgerRange?: number,
 *   now?: () => number
 * }} [options]
 */
export function proposeHeals({ report, records, store, contractId = "", maxLedgerRange = 1000, now } = {}) {
  const proposals = [];
  const skipped = [];
  if (!report || report.mode !== "three_way") {
    return {
      proposals,
      skipped: [{
        reason: "degraded_mode_fail_closed",
        detail: "heal proposals require all three aligned sources",
      }],
    };
  }

  for (const diagnosis of report.diagnoses) {
    const action = chooseAction(diagnosis, { maxLedgerRange });
    if (action.skip) {
      skipped.push({ diagnosisId: diagnosis.id, reason: action.skip });
      continue;
    }
    const targets = evidenceTargets(diagnosis);
    const preview = previewScope({
      records,
      targets,
      scope: action.scope,
      contractId,
      tolerance: report.tolerance,
    });
    if (preview.unresolved.length > 0) {
      skipped.push({ diagnosisId: diagnosis.id, reason: "target_state_unavailable" });
      continue;
    }
    if (preview.changes.length === 0) {
      skipped.push({ diagnosisId: diagnosis.id, reason: "no_changes" });
      continue;
    }
    const proposal = store.propose({
      diagnosis,
      action,
      dryRun: preview,
      contractId,
      now,
    });
    proposals.push(proposal);
  }
  return { proposals, skipped };
}

export class ProposalStore {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.timelockMs = options.timelockMs ?? 24 * 60 * 60 * 1000;
    this.ttlMs = options.ttlMs ?? 48 * 60 * 60 * 1000;
    this.requiredSignatures = options.requiredSignatures ?? 2;
    this.governanceSigners = options.governanceSigners ?? null;
    this.maxScope = options.maxScope ?? 25;
    this.maxLedgerRange = options.maxLedgerRange ?? 1000;
    this.onEvent = options.onEvent ?? (() => {});
    this.proposals = new Map();
    this.byDivergence = new Map();
    this.checkpoints = new Map();
  }

  list() {
    return [...this.proposals.values()];
  }

  get(id) {
    return this.proposals.get(id) ?? null;
  }

  propose(input) {
    const at = milliseconds(input.now ?? input.at, this.now());
    const action = {
      type: input.action.type,
      scope: normalizeScope(input.action),
      reason: input.action.reason ?? null,
    };
    if (!ACTION_TYPES.has(action.type)) {
      throw new HealGateError("INVALID_ACTION", `unsupported heal action ${action.type}`);
    }
    const scopeIds = action.scope.streamIds;
    if (scopeIds.length === 0) {
      throw new HealGateError("EMPTY_SCOPE", "a heal proposal must name at least one record");
    }
    if (scopeIds.length > this.maxScope) {
      throw new HealGateError("SCOPE_TOO_LARGE", `scope has ${scopeIds.length} records; limit is ${this.maxScope}`);
    }
    if (action.scope.ledgerRange) {
      const { from, to } = action.scope.ledgerRange;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
        throw new HealGateError("INVALID_LEDGER_RANGE", "ledger range must be finite and ordered");
      }
      if (to - from > this.maxLedgerRange) {
        throw new HealGateError("LEDGER_RANGE_TOO_LARGE", "ledger range exceeds the approved bound");
      }
    }

    const existing = this.byDivergence.get(input.diagnosis?.id);
    if (existing) {
      const current = this.proposals.get(existing);
      if (current && ["proposed", "approved", "executing"].includes(current.status)) {
        return current;
      }
    }

    const dryRun = {
      changes: input.dryRun.changes,
      unresolved: input.dryRun.unresolved ?? [],
      beforeRoot: input.dryRun.beforeRoot,
      afterRoot: input.dryRun.afterRoot,
      scope: input.dryRun.scope ?? action.scope,
      computedAt: input.dryRun.computedAt ?? new Date(at).toISOString(),
      previewHash: input.dryRun.previewHash,
    };
    if (dryRun.changes.length === 0) {
      throw new HealGateError("EMPTY_PREVIEW", "a proposal must change at least one record");
    }
    if (dryRun.changes.length > this.maxScope) {
      throw new HealGateError("SCOPE_TOO_LARGE", "preview exceeds the bounded scope");
    }
    for (const change of dryRun.changes) {
      if (!scopeIds.includes(String(change.streamId))) {
        throw new HealGateError("SCOPE_VIOLATION", `preview changes ${change.streamId} outside the approved scope`);
      }
    }
    const expectedPreviewHash = stableDocumentHash({
      scope: dryRun.scope,
      changes: dryRun.changes,
      beforeRoot: dryRun.beforeRoot,
      afterRoot: dryRun.afterRoot,
    });
    if (expectedPreviewHash !== dryRun.previewHash) {
      throw new HealGateError("PREVIEW_TAMPERED", "dry-run preview hash does not match its contents");
    }

    const hash = stableDocumentHash({
      divergenceId: input.diagnosis.id,
      createdAt: at,
      action,
      dryRun: {
        beforeRoot: dryRun.beforeRoot,
        afterRoot: dryRun.afterRoot,
        previewHash: dryRun.previewHash,
      },
    });
    const id = `heal-${hash.slice(0, 16)}`;
    const proposal = {
      schema: "streampay-heal-proposal/v1",
      id,
      hash,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.ttlMs).toISOString(),
      status: "proposed",
      divergence: {
        id: input.diagnosis.id,
        recordId: input.diagnosis.recordId,
        checkType: input.diagnosis.checkType,
        disagreeingPairs: input.diagnosis.disagreeingPairs,
        suspectedLayer: input.diagnosis.suspectedLayer,
        evidence: input.diagnosis.evidence,
      },
      contractId: input.contractId ?? "",
      action,
      dryRun,
      governance: {
        requiredSignatures: this.requiredSignatures,
        timelockMs: this.timelockMs,
        executableAt: new Date(at + this.timelockMs).toISOString(),
        expiresAt: new Date(at + this.ttlMs).toISOString(),
        vetoed: false,
        vetoedBy: null,
        onChainProposalId: null,
        approvals: [],
      },
      execution: null,
      audit: [{
        at: new Date(at).toISOString(),
        event: "proposed",
        beforeRoot: dryRun.beforeRoot,
        afterRoot: dryRun.afterRoot,
        actionHash: scopeHash(action),
      }],
    };
    this.proposals.set(id, proposal);
    this.byDivergence.set(input.diagnosis.id, id);
    this.onEvent("proposal.created", proposal);
    return proposal;
  }

  approve(id, approval) {
    const proposal = this.requireProposal(id);
    const at = milliseconds(approval.at, this.now());
    this.assertLive(proposal, at);
    if (proposal.governance.vetoed) {
      throw new HealGateError("VETOED", "a vetoed proposal can never be approved");
    }
    if (approval.proposalHash !== proposal.hash) {
      throw new HealGateError("HASH_MISMATCH", "approval signs a different proposal hash");
    }
    const expectedKey = this.expectedKey(approval.signer);
    if (!this.signerAllowed(approval.signer)) {
      throw new HealGateError("UNAUTHORIZED_SIGNER", `${approval.signer} is not a governance signer`);
    }
    if (expectedKey && approval.publicKey !== expectedKey) {
      throw new HealGateError("INVALID_SIGNATURE", "approval public key does not match the governance signer");
    }
    if (proposal.governance.approvals.some((existing) => existing.signer === approval.signer)) {
      throw new HealGateError("DUPLICATE_SIGNER", `${approval.signer} already approved`);
    }
    if (!this.validSignature(proposal.hash, approval, expectedKey ?? approval.publicKey)) {
      throw new HealGateError("INVALID_SIGNATURE", "approval signature does not verify");
    }
    proposal.governance.approvals.push({
      signer: approval.signer,
      publicKey: approval.publicKey,
      signature: approval.signature,
      proposalHash: approval.proposalHash,
      approvedAt: new Date(at).toISOString(),
    });
    if (proposal.governance.approvals.length >= proposal.governance.requiredSignatures) {
      proposal.status = "approved";
    }
    proposal.audit.push({
      at: new Date(at).toISOString(),
      event: "approval",
      signer: approval.signer,
      approvals: proposal.governance.approvals.length,
    });
    this.onEvent("proposal.approved", proposal);
    return proposal;
  }

  veto(id, veto) {
    const proposal = this.requireProposal(id);
    const at = milliseconds(veto.at, this.now());
    this.assertLive(proposal, at);
    if (at >= Date.parse(proposal.governance.executableAt)) {
      throw new HealGateError("VETO_WINDOW_CLOSED", "veto window has closed");
    }
    if (!this.signerAllowed(veto.signer)) {
      throw new HealGateError("UNAUTHORIZED_SIGNER", `${veto.signer} is not a governance signer`);
    }
    proposal.governance.vetoed = true;
    proposal.governance.vetoedBy = veto.signer;
    proposal.status = "vetoed";
    proposal.audit.push({ at: new Date(at).toISOString(), event: "vetoed", signer: veto.signer });
    this.onEvent("proposal.vetoed", proposal);
    return proposal;
  }

  expire(id) {
    const proposal = this.requireProposal(id);
    const at = this.now();
    if (at > Date.parse(proposal.expiresAt) && !["executed", "vetoed"].includes(proposal.status)) {
      proposal.status = "expired";
      proposal.audit.push({ at: new Date(at).toISOString(), event: "expired" });
    }
    return proposal;
  }

  async execute(id, { records, writeRecord, writeCursor, executor = "unknown", at } = {}) {
    const proposal = this.requireProposal(id);
    const now = milliseconds(at, this.now());
    if (proposal.status === "executed") {
      return { proposal, executed: false, idempotent: true, ...proposal.execution };
    }
    if (now > Date.parse(proposal.expiresAt)) {
      this.expire(id);
      throw new HealGateError("EXPIRED", "an expired proposal can never execute");
    }
    if (proposal.governance.vetoed || proposal.status === "vetoed") {
      throw new HealGateError("VETOED", "a vetoed proposal can never execute");
    }
    if (proposal.status !== "approved" && proposal.status !== "executing") {
      throw new HealGateError("NOT_APPROVED", "only an approved proposal may execute");
    }
    if (now < Date.parse(proposal.governance.executableAt)) {
      throw new HealGateError("TIMELOCK_ACTIVE", "the governance timelock has not elapsed");
    }
    this.assertApprovalsCurrent(proposal);
    this.assertScope(proposal);
    if (!Array.isArray(records)) {
      throw new HealGateError("NO_PROJECTION", "execution needs the current projection records");
    }

    const expectedPreview = stableDocumentHash({
      scope: proposal.dryRun.scope,
      changes: proposal.dryRun.changes,
      beforeRoot: proposal.dryRun.beforeRoot,
      afterRoot: proposal.dryRun.afterRoot,
    });
    if (expectedPreview !== proposal.dryRun.previewHash) {
      throw new HealGateError("PREVIEW_TAMPERED", "the stored dry-run preview no longer verifies");
    }

    const normalized = records.map(normalizeRecord);
    const current = new Map(normalized.map((record) => [record.streamId, record]));
    const checkpointKey = proposal.id;
    const applied = this.checkpoints.get(checkpointKey) ?? new Map();
    const resuming = applied.size > 0;
    const beforeRoot = computeStateRoot(normalized, proposal.contractId ?? "");

    if (!resuming && beforeRoot !== proposal.dryRun.beforeRoot) {
      throw new HealGateError("STALE_PREVIEW", "the projection changed after the dry run; regenerate the proposal");
    }
    for (const [streamId, after] of applied) {
      current.set(streamId, after);
    }
    for (const change of proposal.dryRun.changes) {
      if (applied.has(change.streamId)) continue;
      const currentRecord = current.get(change.streamId) ?? null;
      if (!sameRecord(currentRecord, change.before)) {
        throw new HealGateError("STALE_PREVIEW", `record ${change.streamId} moved after the dry run`);
      }
    }

    proposal.status = "executing";
    proposal.execution = {
      startedAt: new Date(now).toISOString(),
      executor,
      appliedStreamIds: [...applied.keys()],
      beforeRoot,
      governanceAction: {
        onChainProposalId: proposal.governance.onChainProposalId,
        approvals: proposal.governance.approvals.map((approval) => approval.signer),
      },
    };

    try {
      for (const change of proposal.dryRun.changes) {
        if (applied.has(change.streamId)) continue;
        if (writeRecord) {
          await writeRecord(change.after, { proposalId: proposal.id, change });
        }
        current.set(change.streamId, change.after);
        applied.set(change.streamId, change.after);
        this.checkpoints.set(checkpointKey, applied);
      }
      if (proposal.action.type === "resync_cursor" && writeCursor) {
        await writeCursor(proposal.action.scope.ledgerRange ?? null, { proposalId: proposal.id });
      }
    } catch (error) {
      proposal.status = "executing";
      proposal.audit.push({
        at: new Date(now).toISOString(),
        event: "execution_failed",
        error: error instanceof Error ? error.message : String(error),
        appliedStreamIds: [...applied.keys()],
      });
      this.onEvent("proposal.execution_failed", proposal);
      throw error;
    }

    const afterRoot = computeStateRoot([...current.values()], proposal.contractId ?? "");
    if (afterRoot !== proposal.dryRun.afterRoot) {
      proposal.audit.push({
        at: new Date(now).toISOString(),
        event: "root_mismatch",
        expected: proposal.dryRun.afterRoot,
        actual: afterRoot,
      });
      throw new HealGateError("ROOT_MISMATCH", "execution did not reproduce the dry-run root");
    }

    proposal.status = "executed";
    proposal.execution = {
      ...proposal.execution,
      executedAt: new Date(now).toISOString(),
      beforeRoot,
      afterRoot,
      appliedStreamIds: [...applied.keys()],
    };
    proposal.audit.push({
      at: new Date(now).toISOString(),
      event: "executed",
      executor,
      beforeRoot,
      afterRoot,
      governanceAction: proposal.execution.governanceAction,
    });
    this.onEvent("proposal.executed", proposal);
    return { proposal, executed: true, beforeRoot, afterRoot, appliedStreamIds: [...applied.keys()] };
  }

  assertScope(proposal) {
    const { streamIds, ledgerRange } = normalizeScope(proposal.action);
    if (streamIds.length === 0 || streamIds.length > this.maxScope) {
      throw new HealGateError("SCOPE_TOO_LARGE", "proposal scope is outside the configured bound");
    }
    if (ledgerRange && ledgerRange.to - ledgerRange.from > this.maxLedgerRange) {
      throw new HealGateError("LEDGER_RANGE_TOO_LARGE", "proposal ledger range is outside the configured bound");
    }
    for (const change of proposal.dryRun.changes) {
      if (!streamIds.includes(change.streamId)) {
        throw new HealGateError("SCOPE_VIOLATION", `change ${change.streamId} is outside the approved scope`);
      }
    }
    if (proposal.action.type === "resync_cursor" && !ledgerRange) {
      throw new HealGateError("INVALID_LEDGER_RANGE", "cursor resync requires a ledger range");
    }
  }

  assertApprovalsCurrent(proposal) {
    const approvals = proposal.governance.approvals;
    if (approvals.length < proposal.governance.requiredSignatures) {
      throw new HealGateError("NOT_APPROVED", "proposal does not have enough approvals");
    }
    const seen = new Set();
    for (const approval of approvals) {
      if (seen.has(approval.signer)) {
        throw new HealGateError("DUPLICATE_SIGNER", "duplicate approval detected");
      }
      seen.add(approval.signer);
      const expectedKey = this.expectedKey(approval.signer);
      if (!this.signerAllowed(approval.signer) || (expectedKey && approval.publicKey !== expectedKey)) {
        throw new HealGateError("UNAUTHORIZED_SIGNER", `${approval.signer} is no longer a governance signer`);
      }
      if (
        approval.proposalHash !== proposal.hash
        || !this.validSignature(proposal.hash, approval, expectedKey ?? approval.publicKey)
      ) {
        throw new HealGateError("INVALID_SIGNATURE", "stored approval no longer verifies");
      }
    }
  }

  signerAllowed(signer) {
    const signers = this.governanceSigners;
    if (!signers) return true;
    if (Array.isArray(signers)) return signers.includes(signer);
    if (signers instanceof Map) return signers.has(signer);
    return Object.prototype.hasOwnProperty.call(signers, signer);
  }

  expectedKey(signer) {
    const signers = this.governanceSigners;
    if (!signers || Array.isArray(signers)) return null;
    if (signers instanceof Map) return signers.get(signer) ?? null;
    return signers[signer] ?? null;
  }

  assertLive(proposal, at) {
    if (["executed", "vetoed", "expired"].includes(proposal.status)) {
      throw new HealGateError("NOT_LIVE", `proposal is ${proposal.status}`);
    }
    if (at > Date.parse(proposal.expiresAt)) {
      proposal.status = "expired";
      throw new HealGateError("EXPIRED", "proposal has expired");
    }
  }

  validSignature(hash, approval, publicKey) {
    try {
      return verifySignature(
        null,
        Buffer.from(hash, "utf8"),
        publicKey ?? approval.publicKey,
        Buffer.from(approval.signature, "base64")
      );
    } catch {
      return false;
    }
  }

  requireProposal(id) {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new HealGateError("NOT_FOUND", `unknown proposal ${id}`);
    return proposal;
  }
}

function sameRecord(left, right) {
  if (left === null || right === null) return left === right;
  return stableDocumentHash(normalizeRecord(left)) === stableDocumentHash(normalizeRecord(right));
}

export { compareStates, targetMap, previewScope };
