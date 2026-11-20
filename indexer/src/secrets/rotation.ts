/**
 * Zero-downtime secret rotation — issue #615.
 *
 * Manual rotation of webhook signing keys and RPC credentials is an outage
 * waiting to happen (rotate-then-update: deliveries fail for the length of the
 * gap) or a stale-secret incident (never rotate: nobody remembers). This module
 * implements the lifecycle that avoids both:
 *
 *   issue ──► health-check ──► promote ──► overlap window ──► retire
 *                 │
 *                 └─ fails ──► abort: the old secret stays active (fail-safe)
 *
 * Three properties are the whole point, and each has a test:
 *
 * 1. **Overlap.** A new secret is promoted while the old one stays *valid*, for
 *    a bounded window. Webhook subscribers get both signatures during the
 *    window (`generateSignatureHeader(secret, ..., previousSecret)`), so a
 *    subscriber that has not yet picked up the new key still verifies.
 * 2. **Fail-safe abort.** A rotation that cannot be health-checked, or whose
 *    write fails, changes nothing: the previous secret remains active and an
 *    alert is emitted. A partial rotation is never left behind.
 * 3. **Audit integrity.** Every issue/abort/retire is appended to a hash-chained
 *    log. Editing or dropping an entry breaks the chain, so "the audit says it
 *    was rotated on Tuesday" is checkable rather than asserted.
 *
 * Restart safety without a schema change: the overlap window for a webhook
 * endpoint is derived from the row's `updated_at` plus the policy window, so a
 * process that restarts mid-overlap neither forgets to retire the old key nor
 * rejects it early.
 */

import { createHash, randomBytes } from "node:crypto";
import type { WebhookStore } from "../webhooks/store.js";
import { generateSignatureHeader, verifySignatureHeader } from "../webhooks/hmac.js";

// ── policy ──────────────────────────────────────────────────────────────────

export interface RotationPolicy {
  /** How long the previous secret stays valid after a promotion. */
  overlapMs: number;
  /** How often the scheduler attempts a rotation. */
  rotationIntervalMs: number;
  /** Consecutive aborted rotations before the scheduler stops retrying. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  // Long enough for every subscriber to fetch a new key and deploy it, short
  // enough that a leaked key stops working within the day.
  overlapMs: 24 * 60 * 60 * 1000,
  rotationIntervalMs: 30 * 24 * 60 * 60 * 1000,
  maxConsecutiveFailures: 3,
};

// ── secrets manager seam ────────────────────────────────────────────────────

/**
 * The seam where a real secrets manager (AWS Secrets Manager, GCP Secret
 * Manager, Vault) plugs in. The rotation lifecycle never assumes a specific
 * backend: it reads the current value, writes the next one and aborts if either
 * call fails. `EnvSecretProvider` is the default for deployments that inject
 * secrets as environment variables; `MemorySecretProvider` is for tests and
 * dry runs.
 */
export interface SecretsProvider {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
}

export class MemorySecretProvider implements SecretsProvider {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.values.set(name, value);
  }

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async put(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

/** Env-var backed provider: `RPC_CREDENTIAL` reads $RPC_CREDENTIAL. */
export class EnvSecretProvider implements SecretsProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(name: string): Promise<string | null> {
    return this.env[name] ?? null;
  }

  async put(name: string, value: string): Promise<void> {
    // A process cannot rewrite its parent's environment; a deployment that uses
    // this provider must persist the new value (systemd EnvironmentFile, k8s
    // Secret, compose env) — which is exactly what the audit entry records.
    this.env[name] = value;
  }
}

// ── audit log ───────────────────────────────────────────────────────────────

export type AuditAction =
  | "rotation_started"
  | "rotation_promoted"
  | "rotation_aborted"
  | "secret_retired";

export interface AuditEntry {
  seq: number;
  at: number;
  action: AuditAction;
  secretName: string;
  /** Key ids and fingerprints only — never secret material. */
  keyId: string | null;
  previousKeyId: string | null;
  actor: string;
  detail: string;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  valid: boolean;
  entries: number;
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * Append-only, hash-chained audit log.
 *
 * `hash = sha256(prevHash + canonical(entry-without-hash))`, so removing,
 * reordering or editing an entry is detectable from the log alone. The chain is
 * seeded with 64 zeros; the first entry's `prevHash` is that constant.
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly persist?: (entry: AuditEntry) => void;

  constructor(persist?: (entry: AuditEntry) => void) {
    this.persist = persist;
  }

  static readonly GENESIS = "0".repeat(64);

  append(input: {
    at: number;
    action: AuditAction;
    secretName: string;
    keyId?: string | null;
    previousKeyId?: string | null;
    actor: string;
    detail?: string;
  }): AuditEntry {
    const prevHash = this.entries.length === 0 ? AuditLog.GENESIS : this.entries[this.entries.length - 1]!.hash;
    const body = {
      seq: this.entries.length + 1,
      at: input.at,
      action: input.action,
      secretName: input.secretName,
      keyId: input.keyId ?? null,
      previousKeyId: input.previousKeyId ?? null,
      actor: input.actor,
      detail: input.detail ?? "",
      prevHash,
    };
    const entry: AuditEntry = { ...body, hash: AuditLog.hashEntry(body) };
    this.entries.push(entry);
    this.persist?.(entry);
    return entry;
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  static hashEntry(body: Omit<AuditEntry, "hash">): string {
    const canonical = JSON.stringify([
      body.seq,
      body.at,
      body.action,
      body.secretName,
      body.keyId,
      body.previousKeyId,
      body.actor,
      body.detail,
      body.prevHash,
    ]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** Recompute the whole chain; a tampered entry is named by sequence. */
  verify(): AuditVerification {
    let prev = AuditLog.GENESIS;
    for (const entry of this.entries) {
      const { hash, ...body } = entry;
      if (body.prevHash !== prev) {
        return { valid: false, entries: this.entries.length, brokenAtSeq: entry.seq, reason: "prevHash does not match the previous entry" };
      }
      if (AuditLog.hashEntry(body) !== hash) {
        return { valid: false, entries: this.entries.length, brokenAtSeq: entry.seq, reason: "hash does not cover the entry contents" };
      }
      prev = hash;
    }
    return { valid: true, entries: this.entries.length };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A new secret plus a key id that is safe to log. */
export function generateSecret(prefix: string): { value: string; keyId: string } {
  const value = `${prefix}_${randomBytes(24).toString("hex")}`;
  return { value, keyId: keyIdFor(value) };
}

/** Stable, non-reversible id for a secret: safe in logs and audit entries. */
export function keyIdFor(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

export interface RotationAlert {
  at: number;
  secretName: string;
  reason: string;
  error?: string;
}

export interface RotationOutcome {
  ok: boolean;
  secretName: string;
  keyId?: string;
  value?: string;
  previousKeyId?: string | null;
  promotedAt?: number;
  /** When the previous secret stops being accepted. */
  previousRetireAt?: number | null;
  error?: string;
}

export type HealthCheck = (candidate: string) => Promise<boolean>;

export interface RotationManagerOptions {
  name: string;
  provider: SecretsProvider;
  audit?: AuditLog;
  policy?: Partial<RotationPolicy>;
  now?: () => number;
  /** Verifies the *new* credential works before it replaces the old one. */
  healthCheck?: HealthCheck;
  onAlert?: (alert: RotationAlert) => void;
  prefix?: string;
}

interface VersionRecord {
  value: string;
  keyId: string;
  promotedAt: number;
  retireAt: number | null;
}

// ── generic provider-backed rotation ────────────────────────────────────────

/**
 * Rotation engine for a single named secret (an RPC credential today, any
 * provider-backed secret tomorrow).
 *
 * `rotate()` is the only mutating path, and it either fully succeeds or fully
 * aborts: the provider is written only after the candidate passes its health
 * check, so a failing candidate never becomes the active secret.
 */
export class SecretRotationManager {
  readonly name: string;
  private readonly provider: SecretsProvider;
  private readonly policy: RotationPolicy;
  private readonly now: () => number;
  private readonly healthCheck?: HealthCheck;
  private readonly onAlert?: (alert: RotationAlert) => void;
  private readonly prefix: string;
  readonly audit: AuditLog;

  private currentVersion: VersionRecord | null = null;
  private previousVersion: VersionRecord | null = null;
  private rotating = false;
  private consecutiveFailures = 0;
  private lastRotatedAt = 0;

  constructor(options: RotationManagerOptions) {
    this.name = options.name;
    this.provider = options.provider;
    this.policy = { ...DEFAULT_ROTATION_POLICY, ...options.policy };
    this.now = options.now ?? (() => Date.now());
    this.healthCheck = options.healthCheck;
    this.onAlert = options.onAlert;
    this.prefix = options.prefix ?? "sk";
    this.audit = options.audit ?? new AuditLog();
  }

  /** Load the active value from the provider; call once at startup. */
  async init(): Promise<void> {
    const value = await this.provider.get(this.name);
    if (value) {
      this.currentVersion = {
        value,
        keyId: keyIdFor(value),
        promotedAt: this.now(),
        retireAt: null,
      };
      this.lastRotatedAt = this.now();
    }
  }

  /** The secret new material should be encrypted/signed with. */
  current(): VersionRecord | null {
    return this.currentVersion;
  }

  /** Values still accepted: the current one, plus the previous inside its window. */
  acceptedValues(at: number = this.now()): string[] {
    const values: string[] = [];
    // Current first: callers that only look at the first element sign with the
    // active key, while every element still verifies.
    if (this.currentVersion) values.push(this.currentVersion.value);
    if (this.previousVersion && this.previousVersion.retireAt !== null && at < this.previousVersion.retireAt) {
      values.push(this.previousVersion.value);
    }
    return values;
  }

  state(at: number = this.now()): {
    current: { keyId: string; promotedAt: number } | null;
    previous: { keyId: string; retireAt: number | null; active: boolean } | null;
    rotating: boolean;
    consecutiveFailures: number;
    nextRotationAt: number;
  } {
    return {
      current: this.currentVersion
        ? { keyId: this.currentVersion.keyId, promotedAt: this.currentVersion.promotedAt }
        : null,
      previous: this.previousVersion
        ? {
            keyId: this.previousVersion.keyId,
            retireAt: this.previousVersion.retireAt,
            active: this.previousVersion.retireAt !== null && at < this.previousVersion.retireAt,
          }
        : null,
      rotating: this.rotating,
      consecutiveFailures: this.consecutiveFailures,
      nextRotationAt: this.lastRotatedAt + this.policy.rotationIntervalMs,
    };
  }

  /**
   * Issue, health-check, promote — or abort and keep the old secret.
   *
   * Ordering matters: the candidate is generated and health-checked *before*
   * the provider is written, so there is no window in which the store holds a
   * credential that has never worked.
   */
  async rotate(actor = "scheduler", reason = "scheduled"): Promise<RotationOutcome> {
    if (this.rotating) {
      return { ok: false, secretName: this.name, error: "a rotation is already in flight" };
    }
    this.rotating = true;
    const at = this.now();
    this.audit.append({ at, action: "rotation_started", secretName: this.name, actor, detail: reason });

    try {
      const candidate = generateSecret(this.prefix);
      if (this.healthCheck) {
        const healthy = await this.healthCheck(candidate.value);
        if (!healthy) {
          return this.abort(actor, at, "health check rejected the candidate credential");
        }
      }

      await this.provider.put(this.name, candidate.value);

      const previous = this.currentVersion;
      this.previousVersion = previous
        ? { ...previous, retireAt: at + this.policy.overlapMs }
        : null;
      this.currentVersion = {
        value: candidate.value,
        keyId: candidate.keyId,
        promotedAt: at,
        retireAt: null,
      };
      this.lastRotatedAt = at;
      this.consecutiveFailures = 0;

      this.audit.append({
        at,
        action: "rotation_promoted",
        secretName: this.name,
        keyId: candidate.keyId,
        previousKeyId: previous?.keyId ?? null,
        actor,
        detail: previous ? `previous key valid until ${new Date(at + this.policy.overlapMs).toISOString()}` : "initial key",
      });

      return {
        ok: true,
        secretName: this.name,
        keyId: candidate.keyId,
        value: candidate.value,
        previousKeyId: previous?.keyId ?? null,
        promotedAt: at,
        previousRetireAt: previous ? at + this.policy.overlapMs : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.abort(actor, at, `rotation failed: ${message}`, message);
    } finally {
      this.rotating = false;
    }
  }

  /** Fail-safe: record the abort, alert, and leave the active secret alone. */
  private abort(actor: string, at: number, reason: string, error?: string): RotationOutcome {
    this.consecutiveFailures += 1;
    this.audit.append({
      at,
      action: "rotation_aborted",
      secretName: this.name,
      keyId: this.currentVersion?.keyId ?? null,
      actor,
      detail: reason,
    });
    this.onAlert?.({ at, secretName: this.name, reason, error });
    return {
      ok: false,
      secretName: this.name,
      keyId: this.currentVersion?.keyId,
      error: reason,
    };
  }

  /** Retire the previous secret once its overlap window has elapsed. */
  retireExpired(at: number = this.now()): boolean {
    const previous = this.previousVersion;
    if (!previous || previous.retireAt === null || at < previous.retireAt) return false;
    this.previousVersion = null;
    this.audit.append({
      at,
      action: "secret_retired",
      secretName: this.name,
      keyId: previous.keyId,
      actor: "scheduler",
      detail: "overlap window elapsed",
    });
    return true;
  }

  /** Scheduler tick: rotate when due, retire when due. Returns what it did. */
  async tick(at: number = this.now()): Promise<{ rotated: boolean; retired: boolean; outcome?: RotationOutcome }> {
    const retired = this.retireExpired(at);
    if (this.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
      // Backing off rather than hammering a broken rotation path.
      return { rotated: false, retired };
    }
    if (at - this.lastRotatedAt < this.policy.rotationIntervalMs) {
      return { rotated: false, retired };
    }
    const outcome = await this.rotate("scheduler", "scheduled");
    return { rotated: outcome.ok, retired, outcome };
  }
}

// ── webhook signing keys (per endpoint, overlap enforced on read) ───────────

export interface WebhookRotationOptions {
  audit?: AuditLog;
  policy?: Partial<RotationPolicy>;
  now?: () => number;
  onAlert?: (alert: RotationAlert) => void;
}

export interface WebhookRotationOutcome {
  ok: boolean;
  endpointId: string;
  keyId?: string;
  previousKeyId?: string | null;
  previousRetireAt?: number | null;
  error?: string;
}

/**
 * Rotation of a webhook endpoint's signing key with a bounded dual-key window.
 *
 * The delivered header carries a signature from the new key *and* from the old
 * one (`generateSignatureHeader` with `previousSecret`), so a subscriber that
 * still holds only the old key keeps verifying. Retention of the old key is
 * derived from the endpoint row's `updated_at`, which makes the window
 * restart-safe without adding a column.
 */
export class WebhookKeyRotation {
  private readonly store: WebhookStore;
  private readonly policy: RotationPolicy;
  private readonly now: () => number;
  private readonly onAlert?: (alert: RotationAlert) => void;
  readonly audit: AuditLog;
  private rotating = new Set<string>();

  constructor(store: WebhookStore, options: WebhookRotationOptions = {}) {
    this.store = store;
    this.policy = { ...DEFAULT_ROTATION_POLICY, ...options.policy };
    this.now = options.now ?? (() => Date.now());
    this.onAlert = options.onAlert;
    this.audit = options.audit ?? new AuditLog();
  }

  /**
   * Promote a new signing key for one endpoint. The old key stays valid until
   * the overlap window elapses; the new one is dual-signed immediately, so
   * subscribers never see a signature they cannot verify.
   */
  rotate(endpointId: string, actor = "scheduler"): WebhookRotationOutcome {
    const at = this.now();
    if (this.rotating.has(endpointId)) {
      return { ok: false, endpointId, error: "a rotation is already in flight for this endpoint" };
    }
    this.rotating.add(endpointId);
    this.audit.append({ at, action: "rotation_started", secretName: endpointId, actor, detail: "webhook signing key" });

    try {
      const before = this.store.getEndpoint(endpointId);
      if (!before) {
        throw new Error(`webhook endpoint ${endpointId} not found`);
      }
      const previousKeyId = keyIdFor(before.secret);
      // Pass the rotation clock through so the stored `updated_at` (which the
      // overlap window is derived from, and which therefore survives a restart)
      // is the same instant the audit entry and the window are computed at.
      const { secret, previous_secret } = this.store.rotateEndpointSecret(endpointId, new Date(at));
      const newKeyId = keyIdFor(secret);

      // Prove the pair verifies before declaring success: a header signed with
      // the new key must verify under the endpoint's active key set, or the
      // rotation would quietly break delivery for this subscriber.
      //
      // The signature timestamp is wall-clock time, not the injected rotation
      // clock: the verifier's replay window is checked against `Date.now()`, so
      // a rotation clock that is deliberately fast-forwarded in tests must not
      // change what the header claims about when it was made.
      const probe = generateSignatureHeader(secret, Math.floor(Date.now() / 1000), "{}", previous_secret);
      const check = verifySignatureHeader(probe, [secret, previous_secret].filter(Boolean), "{}", 300);
      if (!check.valid) {
        throw new Error(`self-check failed after writing the new key: ${check.reason ?? "unknown"}`);
      }

      this.audit.append({
        at,
        action: "rotation_promoted",
        secretName: endpointId,
        keyId: newKeyId,
        previousKeyId,
        actor,
        detail: `previous key valid until ${new Date(at + this.policy.overlapMs).toISOString()}`,
      });

      return {
        ok: true,
        endpointId,
        keyId: newKeyId,
        previousKeyId,
        previousRetireAt: at + this.policy.overlapMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.append({
        at,
        action: "rotation_aborted",
        secretName: endpointId,
        keyId: null,
        actor,
        detail: message,
      });
      this.onAlert?.({ at, secretName: endpointId, reason: "webhook key rotation failed", error: message });
      return { ok: false, endpointId, error: message };
    } finally {
      this.rotating.delete(endpointId);
    }
  }

  /** Secrets accepted for one endpoint right now, newest first. */
  acceptedSecrets(endpointId: string, at: number = this.now()): string[] {
    const endpoint = this.store.getEndpoint(endpointId);
    if (!endpoint) return [];
    const values = [endpoint.secret];
    const previous = endpoint.previous_secret;
    if (previous && this.withinOverlap(endpoint.updated_at, at)) values.push(previous);
    return values.filter(Boolean);
  }

  /** Verify a delivered header against the endpoint's active key set. */
  verify(
    endpointId: string,
    header: string,
    payloadJson: string,
    toleranceSec = 300,
    at: number = this.now()
  ): { valid: boolean; reason?: string } {
    const secrets = this.acceptedSecrets(endpointId, at);
    if (secrets.length === 0) return { valid: false, reason: "endpoint not found" };
    const result = verifySignatureHeader(header, secrets, payloadJson, toleranceSec);
    if (result.valid) return result;
    if (this.isExpiredOverlap(endpointId, at)) {
      return { valid: false, reason: `previous secret retired: ${result.reason ?? "signature mismatch"}` };
    }
    return result;
  }

  /**
   * Retire previous keys whose window has elapsed. Returns the endpoints swept.
   * Runs on a schedule; verification already refuses an expired previous key,
   * so a missed sweep cannot extend the window.
   */
  sweep(at: number = this.now()): string[] {
    const retired: string[] = [];
    for (const endpoint of this.store.listEndpoints()) {
      if (!endpoint.previous_secret) continue;
      if (this.withinOverlap(endpoint.updated_at, at)) continue;
      this.store.retirePreviousSecret(endpoint.id, new Date(at));
      this.audit.append({
        at,
        action: "secret_retired",
        secretName: endpoint.id,
        keyId: keyIdFor(endpoint.previous_secret),
        actor: "scheduler",
        detail: "overlap window elapsed",
      });
      retired.push(endpoint.id);
    }
    return retired;
  }

  private withinOverlap(updatedAt: string, at: number): boolean {
    const started = Date.parse(updatedAt);
    if (Number.isNaN(started)) return false;
    return at < started + this.policy.overlapMs;
  }

  private isExpiredOverlap(endpointId: string, at: number): boolean {
    const endpoint = this.store.getEndpoint(endpointId);
    return Boolean(endpoint?.previous_secret) && !this.withinOverlap(endpoint!.updated_at, at);
  }
}
