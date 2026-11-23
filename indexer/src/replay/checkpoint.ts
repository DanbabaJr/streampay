import type Database from "better-sqlite3";

export interface ReplayCheckpoint {
  job: string;
  /** Highest ledger whose projection is durable for this job. */
  watermark: number;
  /** Merkle root of the projected state at that watermark. */
  stateRoot: string;
  updatedAt: string;
}

/**
 * Durable replay progress, one row per job, stored next to the projection it
 * checkpoints. A replay that dies mid-run resumes from `watermark`: ranges at or
 * below it are skipped, and the state they produced is still in the store, so
 * resuming can never re-apply or lose an event.
 *
 * The table is additive (`CREATE TABLE IF NOT EXISTS`) and never alters the
 * existing journal or projection tables.
 */
export class ReplayCheckpointStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS replay_checkpoints (
        job TEXT PRIMARY KEY,
        watermark INTEGER NOT NULL,
        state_root TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(job: string): ReplayCheckpoint | undefined {
    const row = this.db
      .prepare("SELECT job, watermark, state_root, updated_at FROM replay_checkpoints WHERE job = ?")
      .get(job) as { job: string; watermark: number; state_root: string; updated_at: string } | undefined;
    if (!row) return undefined;
    return {
      job: row.job,
      watermark: Number(row.watermark),
      stateRoot: row.state_root,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Records progress. Monotonic: an out-of-order or replayed range can never
   * move the watermark backwards.
   */
  record(job: string, watermark: number, stateRoot: string, updatedAt: string): void {
    this.db
      .prepare(`INSERT INTO replay_checkpoints(job, watermark, state_root, updated_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(job) DO UPDATE SET watermark = excluded.watermark, state_root = excluded.state_root,
        updated_at = excluded.updated_at
        WHERE excluded.watermark >= replay_checkpoints.watermark`)
      .run(job, watermark, stateRoot, updatedAt);
  }

  clear(job: string): void {
    this.db.prepare("DELETE FROM replay_checkpoints WHERE job = ?").run(job);
  }
}
