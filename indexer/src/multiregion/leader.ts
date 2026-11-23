import type Database from "better-sqlite3";

export interface DeliveryLease {
  /** Consumer / subscription the lease is for. */
  subscriptionId: string;
  regionId: string;
  /** Monotonic term. Every takeover increments it; a stale term is fenced out. */
  epoch: number;
  /** Local clock (ms) at which the lease stops being valid. */
  expiresAt: number;
}

export class LeaseLostError extends Error {
  constructor(readonly lease: DeliveryLease) {
    super(`delivery lease for ${lease.subscriptionId} is no longer held by ${lease.regionId}@${lease.epoch}`);
    this.name = "LeaseLostError";
  }
}

export interface DeliveryLeaderElectorOptions {
  /** Lease duration in ms. A leader that cannot renew within it loses the lease. */
  leaseMs?: number;
  now?: () => number;
}

/**
 * Single delivery leader per subscription, with fenced failover (#212).
 *
 * Active-active regions all hold a copy of the outbox, but a push consumer must
 * be delivered to by exactly one of them. Regions elect through a shared lease
 * row: only the holder may claim intents, the lease expires if it is not renewed,
 * and a takeover increments `epoch`. Every guarded write re-checks the epoch, so
 * a leader that lost its lease (paused process, partitioned region, clock jump)
 * cannot deliver anything after the new leader starts — the fence, not
 * promptness, is what prevents duplicate webhooks.
 */
export class DeliveryLeaderElector {
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly acquireTx: (subscriptionId: string, regionId: string) => DeliveryLease | null;

  constructor(private readonly db: Database.Database, options: DeliveryLeaderElectorOptions = {}) {
    this.leaseMs = options.leaseMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new RangeError(`leaseMs must be a positive integer (got ${this.leaseMs})`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_leases (
        subscription_id TEXT PRIMARY KEY,
        region_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);

    this.acquireTx = this.db.transaction((subscriptionId: string, regionId: string): DeliveryLease | null => {
      const now = this.now();
      const row = this.db
        .prepare("SELECT subscription_id, region_id, epoch, expires_at FROM delivery_leases WHERE subscription_id = ?")
        .get(subscriptionId) as { region_id: string; epoch: number; expires_at: number } | undefined;

      if (!row) {
        this.db
          .prepare("INSERT INTO delivery_leases(subscription_id, region_id, epoch, expires_at) VALUES(?, ?, 1, ?)")
          .run(subscriptionId, regionId, now + this.leaseMs);
        return { subscriptionId, regionId, epoch: 1, expiresAt: now + this.leaseMs };
      }

      // A live lease held elsewhere is not stealable, however stale the caller is.
      if (row.region_id !== regionId && row.expires_at > now) return null;

      const epoch = row.region_id === regionId ? row.epoch : row.epoch + 1;
      const expiresAt = now + this.leaseMs;
      this.db
        .prepare("UPDATE delivery_leases SET region_id = ?, epoch = ?, expires_at = ? WHERE subscription_id = ?")
        .run(regionId, epoch, expiresAt, subscriptionId);
      return { subscriptionId, regionId, epoch, expiresAt };
    });
  }

  /** Elects `regionId` for the subscription, or returns null while another region holds a live lease. */
  acquire(subscriptionId: string, regionId: string): DeliveryLease | null {
    return this.acquireTx(subscriptionId, regionId);
  }

  current(subscriptionId: string): DeliveryLease | undefined {
    const row = this.db
      .prepare("SELECT subscription_id, region_id, epoch, expires_at FROM delivery_leases WHERE subscription_id = ?")
      .get(subscriptionId) as { subscription_id: string; region_id: string; epoch: number; expires_at: number } | undefined;
    if (!row) return undefined;
    return {
      subscriptionId: row.subscription_id,
      regionId: row.region_id,
      epoch: Number(row.epoch),
      expiresAt: Number(row.expires_at),
    };
  }

  /** True only while `lease` is still the current, unexpired holder. */
  isLeader(lease: DeliveryLease): boolean {
    const row = this.db
      .prepare("SELECT region_id, epoch, expires_at FROM delivery_leases WHERE subscription_id = ?")
      .get(lease.subscriptionId) as { region_id: string; epoch: number; expires_at: number } | undefined;
    return Boolean(
      row &&
      row.region_id === lease.regionId &&
      Number(row.epoch) === lease.epoch &&
      Number(row.expires_at) > this.now(),
    );
  }

  /** Extends the holder's lease. Returns false once the fence has moved on. */
  renew(lease: DeliveryLease): boolean {
    const now = this.now();
    const res = this.db
      .prepare(`UPDATE delivery_leases SET expires_at = ?
        WHERE subscription_id = ? AND region_id = ? AND epoch = ? AND expires_at > ?`)
      .run(now + this.leaseMs, lease.subscriptionId, lease.regionId, lease.epoch, now);
    return res.changes === 1;
  }

  /**
   * Voluntarily hands leadership back. The lease is expired rather than deleted,
   * so the epoch keeps increasing and a stale holder still cannot fence itself in.
   */
  release(lease: DeliveryLease): boolean {
    const res = this.db
      .prepare("UPDATE delivery_leases SET expires_at = 0 WHERE subscription_id = ? AND region_id = ? AND epoch = ?")
      .run(lease.subscriptionId, lease.regionId, lease.epoch);
    return res.changes === 1;
  }

  /** Fence check. Every unit of delivery work runs behind this. */
  assertLeader(lease: DeliveryLease): void {
    if (!this.isLeader(lease)) throw new LeaseLostError(lease);
  }

  /** Runs `work` only while the lease is still held; throws LeaseLostError otherwise. */
  runFenced<T>(lease: DeliveryLease, work: () => T): T {
    this.assertLeader(lease);
    return work();
  }
}
