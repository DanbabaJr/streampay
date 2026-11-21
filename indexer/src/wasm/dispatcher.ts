/**
 * Per-subscription plugin dispatch (issue #580).
 *
 * A subscription binds one tenant-approved plugin to one subscription id
 * (an SSE stream, an outbox consumer, … — the dispatcher does not care
 * what a subscription is, only that the binding is explicit). Dispatching
 * an event for a subscription runs the tenant's approved plugin over the
 * event and then redacts the result:
 *
 *   raw event → plugin transform → redaction → subscriber
 *
 * Redaction is always the last step, and it also runs on the passthrough
 * and fallback paths, so a plugin can never leak a protected field by
 * emitting it, and a fallback never leaks one either.
 *
 * Failure is never fatal to ingestion. Any of these falls back to the raw
 * (redacted) event, records a fallback alert, and keeps going:
 *
 *   - no subscription (passthrough, not a fallback — there is nothing to
 *     fall back *from*);
 *   - the bound plugin is unknown or not approved for the tenant;
 *   - the plugin traps, times out, is killed, or replies with garbage.
 *
 * Alerts are delivered to `onFallback` when one is configured and are
 * always appended to `fallbackLog`, which operators can read back (and
 * which the HTTP API exposes at `GET /api/wasm/fallbacks`).
 */
import { redactDecodedEvent } from "../redaction.js";
import type { DecodedEvent } from "../types.js";
import type { WasmPluginHost } from "./host.js";
import type { WasmPluginRegistry } from "./registry.js";

export type DispatchOutcome = "transformed" | "dropped" | "passthrough" | "fallback";

export interface DispatchResult {
  outcome: DispatchOutcome;
  /** The event to deliver, or `undefined` when the plugin dropped it. */
  event?: DecodedEvent;
  /** Why a fallback happened (present only for `fallback`). */
  reason?: string;
  pluginDigest?: string;
}

export interface FallbackAlert {
  tenant: string;
  subscriptionId: string;
  pluginDigest: string | null;
  eventId: string;
  reason: string;
  at: string;
}

export interface SubscriptionBinding {
  tenant: string;
  pluginDigest: string;
}

export class PluginDispatcher {
  readonly fallbackLog: FallbackAlert[] = [];
  private readonly subscriptions = new Map<string, SubscriptionBinding>();

  constructor(
    private readonly registry: WasmPluginRegistry,
    private readonly host: WasmPluginHost,
    private readonly opts: {
      /** Redact Stellar addresses from delivered events (default false). */
      redactionEnabled?: boolean;
      /** Called for every fallback alert, e.g. to log or page. */
      onFallback?: (alert: FallbackAlert) => void;
    } = {},
  ) {}

  subscribe(subscriptionId: string, tenant: string, pluginDigest: string): void {
    if (!subscriptionId) throw new Error("subscriptionId must be a non-empty string");
    if (!tenant) throw new Error("tenant must be a non-empty string");
    if (!pluginDigest) throw new Error("pluginDigest must be a non-empty string");
    this.subscriptions.set(subscriptionId, { tenant, pluginDigest });
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  binding(subscriptionId: string): SubscriptionBinding | undefined {
    return this.subscriptions.get(subscriptionId);
  }

  private fallback(
    subscriptionId: string,
    tenant: string,
    pluginDigest: string | null,
    event: DecodedEvent,
    reason: string,
  ): DispatchResult {
    const alert: FallbackAlert = {
      tenant,
      subscriptionId,
      pluginDigest,
      eventId: event.id,
      reason,
      at: new Date().toISOString(),
    };
    this.fallbackLog.push(alert);
    this.opts.onFallback?.(alert);
    return {
      outcome: "fallback",
      event: redactDecodedEvent(event, this.opts.redactionEnabled ?? false),
      reason,
      pluginDigest: pluginDigest ?? undefined,
    };
  }

  async dispatch(event: DecodedEvent, subscriptionId: string): Promise<DispatchResult> {
    const binding = this.subscriptions.get(subscriptionId);
    const redactionEnabled = this.opts.redactionEnabled ?? false;
    if (!binding) {
      return { outcome: "passthrough", event: redactDecodedEvent(event, redactionEnabled) };
    }
    const record = this.registry.getApproved(binding.tenant, binding.pluginDigest);
    if (!record) {
      return this.fallback(
        subscriptionId,
        binding.tenant,
        binding.pluginDigest,
        event,
        `plugin ${binding.pluginDigest} is not approved for tenant ${binding.tenant}`,
      );
    }
    const outcome = await this.host.transformEvent(record.bytes, event);
    if (outcome.status === "dropped") {
      return { outcome: "dropped", pluginDigest: binding.pluginDigest };
    }
    if (outcome.status === "fallback") {
      return this.fallback(subscriptionId, binding.tenant, binding.pluginDigest, event, outcome.reason);
    }
    return {
      outcome: "transformed",
      event: redactDecodedEvent({ ...event, data: outcome.output }, redactionEnabled),
      pluginDigest: binding.pluginDigest,
    };
  }
}
