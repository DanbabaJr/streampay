/**
 * Plugin registry: versioning, content-addressing and per-tenant approval
 * (issue #580).
 *
 * Identity. A plugin's id is the SHA-256 digest of its exact WASM bytes
 * (`pluginDigest` in `abi.ts`). Registering the same bytes twice returns
 * the same record; different bytes are a different plugin, even under the
 * same name. A human-readable `version` string (e.g. `"1.2.0"`) is stored
 * alongside the digest as metadata — it does not change the identity.
 *
 * Approval. A plugin cannot run for a tenant until that tenant has
 * approved that exact digest. Approval is recorded per `(tenant, digest)`
 * with the version that was approved, so approving v1 does not silently
 * approve a re-registered v2 of the same bytes (which would be a different
 * version string on the same digest — the registry refuses to re-register
 * a digest under a different version, so this cannot happen by accident).
 *
 * Storage. Records live in SQLite (`wasm_plugins`, `wasm_plugin_approvals`)
 * and are mirrored in an in-memory map, so a restart keeps approvals and
 * a hot path never has to hit the database. `StreamStore` owns one
 * registry over its own database; tests can pass any `better-sqlite3`
 * database (including `:memory:`).
 */
import type Database from "better-sqlite3";
import { pluginDigest, type PluginLimits } from "./abi.js";
import { validatePlugin } from "./validate.js";

export interface PluginRecord {
  digest: string;
  version: string;
  name: string | null;
  bytes: Uint8Array;
  createdAt: string;
}

export interface PluginApproval {
  tenant: string;
  digest: string;
  version: string;
  approvedAt: string;
}

export function ensureWasmPluginTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wasm_plugins (
      digest TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      name TEXT,
      bytes BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wasm_plugin_approvals (
      tenant TEXT NOT NULL,
      digest TEXT NOT NULL,
      version TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (tenant, digest)
    );
  `);
}

export class WasmPluginRegistry {
  private readonly db: Database.Database;
  private readonly cache = new Map<string, PluginRecord>();

  constructor(db: Database.Database) {
    this.db = db;
    ensureWasmPluginTables(db);
    for (const row of this.db
      .prepare("SELECT digest, version, name, bytes, created_at FROM wasm_plugins")
      .all() as Array<{ digest: string; version: string; name: string | null; bytes: Buffer; created_at: string }>) {
      this.cache.set(row.digest, {
        digest: row.digest,
        version: row.version,
        name: row.name,
        bytes: new Uint8Array(row.bytes),
        createdAt: row.created_at,
      });
    }
  }

  /**
   * Validate and store a plugin. Throws `PluginValidationError` for an
   * invalid module, and an `Error` if the digest is already registered
   * under a different version.
   */
  register(bytes: Uint8Array, version: string, name?: string, limits?: PluginLimits): PluginRecord {
    if (!version || typeof version !== "string") throw new Error("plugin version must be a non-empty string");
    validatePlugin(bytes, limits);
    const digest = pluginDigest(bytes);
    const existing = this.cache.get(digest) ?? this.getPlugin(digest);
    if (existing) {
      if (existing.version !== version) {
        throw new Error(
          `plugin ${digest} is already registered as version ${existing.version}, cannot re-register as ${version}`,
        );
      }
      return existing;
    }
    const record: PluginRecord = {
      digest,
      version,
      name: name ?? null,
      bytes: new Uint8Array(bytes),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO wasm_plugins(digest, version, name, bytes, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(record.digest, record.version, record.name, Buffer.from(record.bytes), record.createdAt);
    this.cache.set(digest, record);
    return record;
  }

  getPlugin(digest: string): PluginRecord | undefined {
    const cached = this.cache.get(digest);
    if (cached) return cached;
    const row = this.db
      .prepare("SELECT digest, version, name, bytes, created_at FROM wasm_plugins WHERE digest = ?")
      .get(digest) as { digest: string; version: string; name: string | null; bytes: Buffer; created_at: string } | undefined;
    if (!row) return undefined;
    const record: PluginRecord = {
      digest: row.digest,
      version: row.version,
      name: row.name,
      bytes: new Uint8Array(row.bytes),
      createdAt: row.created_at,
    };
    this.cache.set(digest, record);
    return record;
  }

  listPlugins(): Array<Omit<PluginRecord, "bytes"> & { size: number }> {
    return [...this.cache.values()].map((r) => ({
      digest: r.digest,
      version: r.version,
      name: r.name,
      createdAt: r.createdAt,
      size: r.bytes.length,
    }));
  }

  /** Approve `digest` for `tenant`. The plugin must already be registered. */
  approve(tenant: string, digest: string): PluginApproval {
    if (!tenant) throw new Error("tenant must be a non-empty string");
    const record = this.getPlugin(digest);
    if (!record) throw new Error(`cannot approve unknown plugin ${digest}`);
    const approval: PluginApproval = {
      tenant,
      digest,
      version: record.version,
      approvedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO wasm_plugin_approvals(tenant, digest, version, approved_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(tenant, digest) DO UPDATE SET version=excluded.version, approved_at=excluded.approved_at",
      )
      .run(approval.tenant, approval.digest, approval.version, approval.approvedAt);
    return approval;
  }

  revoke(tenant: string, digest: string): boolean {
    return this.db.prepare("DELETE FROM wasm_plugin_approvals WHERE tenant = ? AND digest = ?").run(tenant, digest).changes > 0;
  }

  isApproved(tenant: string, digest: string): boolean {
    const row = this.db
      .prepare("SELECT version FROM wasm_plugin_approvals WHERE tenant = ? AND digest = ?")
      .get(tenant, digest) as { version: string } | undefined;
    if (!row) return false;
    const record = this.getPlugin(digest);
    return record !== undefined && row.version === record.version;
  }

  listApprovals(tenant: string): PluginApproval[] {
    return this.db
      .prepare("SELECT tenant, digest, version, approved_at FROM wasm_plugin_approvals WHERE tenant = ? ORDER BY approved_at ASC")
      .all(tenant) as PluginApproval[];
  }

  /**
   * The plugin record for `tenant` + `digest`, or `undefined` when the
   * plugin is unknown or not approved for that tenant. This is the only
   * way the dispatcher obtains plugin bytes — an unapproved plugin can
   * never run.
   */
  getApproved(tenant: string, digest: string): PluginRecord | undefined {
    return this.isApproved(tenant, digest) ? this.getPlugin(digest) : undefined;
  }
}
