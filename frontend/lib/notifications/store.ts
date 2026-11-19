import { randomBytes } from "node:crypto";
import type {
  Subscription,
  SubscriptionStatus,
  StreamEvent,
  NotificationChannelType,
  SubscriptionConfig,
  StreamEventType,
  NotificationDigestOption,
} from "./types";

export interface CreateSubscriptionInput {
  address: string;
  channel: NotificationChannelType;
  config: SubscriptionConfig;
  eventTypes: StreamEventType[];
  digest?: NotificationDigestOption;
}

export class SubscriptionStore {
  private subscriptions = new Map<string, Subscription>();

  /**
   * Adds a new verified subscription for a Stellar address.
   */
  async addSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    const id = `sub_${randomBytes(12).toString("hex")}`;
    const now = Math.floor(Date.now() / 1000);

    const subscription: Subscription = {
      id,
      address: input.address,
      channel: input.channel,
      config: input.config,
      eventTypes: input.eventTypes.length > 0 ? input.eventTypes : ["claim", "liveness", "cancel"],
      digest: input.digest ?? "instant",
      status: "active",
      verifiedAt: now,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.subscriptions.set(id, subscription);
    return subscription;
  }

  /**
   * Lists all subscriptions registered by a given address.
   */
  async getSubscriptionsForAddress(address: string): Promise<Subscription[]> {
    const results: Subscription[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.address === address) {
        results.push({ ...sub });
      }
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Finds all active subscriptions that match a given stream event.
   */
  async findSubscriptionsForEvent(event: StreamEvent): Promise<Subscription[]> {
    const matched: Subscription[] = [];
    for (const sub of this.subscriptions.values()) {
      if (
        sub.address === event.address &&
        sub.status === "active" &&
        sub.eventTypes.includes(event.type)
      ) {
        matched.push({ ...sub });
      }
    }
    return matched;
  }

  /**
   * Updates delivery success status, resetting failure counters.
   */
  async recordDeliverySuccess(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;

    sub.consecutiveFailures = 0;
    sub.lastDeliveredAt = Math.floor(Date.now() / 1000);
    sub.updatedAt = Math.floor(Date.now() / 1000);
  }

  /**
   * Records a failed delivery attempt. Automatically marks subscription as
   * 'bounced' if an email hard bounces, or 'paused' after 5 consecutive failures.
   */
  async recordDeliveryFailure(
    subscriptionId: string,
    opts: { isBounce?: boolean; reason?: string } = {}
  ): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;

    sub.consecutiveFailures += 1;
    sub.updatedAt = Math.floor(Date.now() / 1000);

    if (opts.isBounce) {
      sub.status = "bounced";
      sub.bounceReason = opts.reason || "Hard bounce detected by delivery provider.";
    } else if (sub.consecutiveFailures >= 5) {
      sub.status = "paused";
      sub.bounceReason = opts.reason || "Paused after 5 consecutive delivery failures.";
    }
  }

  /**
   * Removes a subscription, verifying that the caller address owns it.
   */
  async removeSubscription(id: string, address: string): Promise<boolean> {
    const sub = this.subscriptions.get(id);
    if (!sub || sub.address !== address) return false;
    return this.subscriptions.delete(id);
  }

  /**
   * Updates subscription status (e.g. user manually pauses or reactivates).
   */
  async updateStatus(
    id: string,
    address: string,
    status: SubscriptionStatus
  ): Promise<Subscription | null> {
    const sub = this.subscriptions.get(id);
    if (!sub || sub.address !== address) return null;

    sub.status = status;
    sub.updatedAt = Math.floor(Date.now() / 1000);
    if (status === "active") {
      sub.consecutiveFailures = 0;
      sub.bounceReason = undefined;
    }
    return { ...sub };
  }

  /**
   * Resets all subscriptions in memory (primarily for unit/integration tests).
   */
  clear(): void {
    this.subscriptions.clear();
  }
}

// Global singleton instance for runtime state
export const defaultSubscriptionStore = new SubscriptionStore();
