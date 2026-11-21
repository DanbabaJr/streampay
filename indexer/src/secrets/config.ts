/**
 * Rotation configuration (issue #615).
 *
 * Read from the environment, with every duration explicit and no hidden
 * defaults beyond the documented ones in `DEFAULT_ROTATION_POLICY`. Values are
 * clamped rather than trusted: an overlap window of 0 would retire the previous
 * webhook key the instant it was rotated, which is exactly the outage this
 * feature exists to prevent.
 */

import { DEFAULT_ROTATION_POLICY, type RotationPolicy } from "./rotation.js";

export interface RotationConfig {
  /** Rotation runs only when explicitly enabled; off by default. */
  enabled: boolean;
  policy: RotationPolicy;
  /** Where the hash-chained audit log is appended (null: in memory only). */
  auditPath: string | null;
  /** Secrets-manager key holding the RPC credential. */
  rpcCredentialName: string;
  /** How often the webhook overlap sweep runs. */
  webhookSweepIntervalMs: number;
  /** How often the generic rotation engine ticks. */
  tickIntervalMs: number;
}

/** Minimum overlap: below this, rotation is an outage. */
export const MIN_OVERLAP_MS = 60_000;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

function envBool(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function loadRotationConfig(env: NodeJS.ProcessEnv = process.env): RotationConfig {
  const overlapMs = Math.max(
    MIN_OVERLAP_MS,
    envInt(env, "SECRET_OVERLAP_MS", DEFAULT_ROTATION_POLICY.overlapMs)
  );
  return {
    enabled: envBool(env, "SECRETS_ROTATION_ENABLED"),
    policy: {
      overlapMs,
      rotationIntervalMs: Math.max(
        overlapMs,
        envInt(env, "SECRET_ROTATION_INTERVAL_MS", DEFAULT_ROTATION_POLICY.rotationIntervalMs)
      ),
      maxConsecutiveFailures: Math.max(
        1,
        envInt(env, "SECRET_ROTATION_MAX_FAILURES", DEFAULT_ROTATION_POLICY.maxConsecutiveFailures)
      ),
    },
    auditPath: env.SECRET_ROTATION_AUDIT_PATH ?? null,
    rpcCredentialName: env.RPC_CREDENTIAL_NAME ?? "STREAMPY_RPC_CREDENTIAL",
    webhookSweepIntervalMs: Math.max(
      10_000,
      envInt(env, "WEBHOOK_KEY_SWEEP_INTERVAL_MS", 15 * 60 * 1000)
    ),
    tickIntervalMs: Math.max(10_000, envInt(env, "SECRET_ROTATION_TICK_MS", 60 * 1000)),
  };
}

/**
 * Credential headers applied to every RPC request.
 *
 * `RPC_AUTH_HEADER` + `RPC_AUTH_VALUE` is the general case (any provider's
 * header), `RPC_BEARER_TOKEN` the common one. Empty when unauthenticated, which
 * keeps the public testnet default working unchanged.
 */
export function rpcAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.RPC_AUTH_HEADER && env.RPC_AUTH_VALUE) {
    headers[env.RPC_AUTH_HEADER] = env.RPC_AUTH_VALUE;
  }
  if (env.RPC_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${env.RPC_BEARER_TOKEN}`;
  }
  return headers;
}
