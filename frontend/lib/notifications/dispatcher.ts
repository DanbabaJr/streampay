import { randomBytes } from "node:crypto";
import type {
  StreamEvent,
  OutgoingNotification,
  Notifier,
  NotificationChannelType,
} from "./types.ts";
import { SubscriptionStore, defaultSubscriptionStore } from "./store.ts";
import { WebhookNotifier, EmailNotifier, TelegramNotifier } from "./notifiers.ts";

export interface RetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
  jitterFactor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseDelayMs: 1000,  // 1 second base delay
  maxDelayMs: 32000,  // 32 seconds maximum delay
  maxRetries: 5,      // 5 maximum attempts
  jitterFactor: 0.2,  // +/- 20% random jitter
};

/**
 * Calculates exponential backoff with full jitter:
 * delay(n) = min(maxDelay, baseDelay * 2^attempt) * (1 +/- jitter)
 *
 * Mathematical Rationale:
 * - Exponential progression (1s, 2s, 4s, 8s, 16s, 32s) matches transient recovery
 *   timeframes of downstream webhook sinks and external APIs without flooding.
 * - Jitter (+/- 20%) decorrelates synchronized retry attempts across multiple
 *   concurrent notifications, preventing the 'thundering herd' spike when downstream
 *   services recover.
 */
export function computeExponentialBackoff(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  const exponent = Math.max(0, attempt);
  const exponentialDelay = config.baseDelayMs * Math.pow(2, exponent);
  const cappedDelay = Math.min(config.maxDelayMs, exponentialDelay);
  const jitterRange = cappedDelay * config.jitterFactor;
  // Uniform random jitter between [-jitterRange, +jitterRange]
  const randomJitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(100, Math.round(cappedDelay + randomJitter));
}

export class NotificationDispatcher {
  private readonly store: SubscriptionStore;
  private readonly retryConfig: RetryConfig;
  private readonly notifiers = new Map<NotificationChannelType, Notifier>();

  constructor(
    store: SubscriptionStore = defaultSubscriptionStore,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
  ) {
    this.store = store;
    this.retryConfig = retryConfig;
    // Register standard default notifiers
    this.registerNotifier(new WebhookNotifier());
    this.registerNotifier(new EmailNotifier());
    this.registerNotifier(new TelegramNotifier());
  }

  registerNotifier(notifier: Notifier): void {
    this.notifiers.set(notifier.channel, notifier);
  }

  /**
   * Main entrypoint: matches a stream event to all active subscriptions
   * and dispatches them with at-least-once delivery guarantees.
   */
  async dispatchStreamEvent(event: StreamEvent): Promise<{
    dispatchedCount: number;
    successCount: number;
    failureCount: number;
  }> {
    const matchingSubscriptions = await this.store.findSubscriptionsForEvent(event);
    let successCount = 0;
    let failureCount = 0;

    for (const sub of matchingSubscriptions) {
      const notification: OutgoingNotification = {
        id: `notif_${randomBytes(12).toString("hex")}`,
        idempotencyKey: `${event.id}:${sub.id}`,
        subscriptionId: sub.id,
        address: sub.address,
        channel: sub.channel,
        event,
        config: sub.config,
        attempt: 0,
        createdAt: Math.floor(Date.now() / 1000),
      };

      const delivered = await this.deliverWithRetry(notification);
      if (delivered) {
        successCount++;
        await this.store.recordDeliverySuccess(sub.id);
      } else {
        failureCount++;
      }
    }

    return {
      dispatchedCount: matchingSubscriptions.length,
      successCount,
      failureCount,
    };
  }

  /**
   * Executes channel delivery with bounded exponential backoff retries.
   */
  async deliverWithRetry(notification: OutgoingNotification): Promise<boolean> {
    const notifier = this.notifiers.get(notification.channel);
    if (!notifier) {
      await this.store.recordDeliveryFailure(notification.subscriptionId, {
        reason: `No registered notifier found for channel: ${notification.channel}`,
      });
      return false;
    }

    let attempt = 0;
    while (attempt <= this.retryConfig.maxRetries) {
      notification.attempt = attempt;
      const result = await notifier.deliver(notification);

      if (result.success) {
        return true;
      }

      if (result.isBounce) {
        // Immediate hard bounce: update subscription status directly
        await this.store.recordDeliveryFailure(notification.subscriptionId, {
          isBounce: true,
          reason: result.statusMessage,
        });
        return false;
      }

      if (result.fatal || !result.retryable || attempt >= this.retryConfig.maxRetries) {
        await this.store.recordDeliveryFailure(notification.subscriptionId, {
          reason: result.statusMessage,
        });
        return false;
      }

      // Calculate backoff and wait before the next attempt
      const delayMs = computeExponentialBackoff(attempt, this.retryConfig);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt++;
    }

    return false;
  }
}

export const defaultDispatcher = new NotificationDispatcher();
