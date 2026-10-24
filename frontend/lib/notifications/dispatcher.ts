import { randomBytes } from "node:crypto";
import type {
  StreamEvent,
  OutgoingNotification,
  Notifier,
  NotificationChannelType,
} from "./types.ts";
import { SubscriptionStore, defaultSubscriptionStore } from "./store.ts";
import { WebhookNotifier, EmailNotifier, TelegramNotifier } from "./notifiers.ts";
import {
  globalFrontendTracer,
  W3CTraceContextPropagator,
  type Span,
} from "../telemetry.ts";
import {
  sanitizeAddress,
  sanitizeWebhookUrl,
  sanitizeEmail,
  sanitizeTelegramChatId,
  sanitizeError,
} from "../privacy.ts";

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
 */
export function computeExponentialBackoff(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  const exponent = Math.max(0, attempt);
  const exponentialDelay = config.baseDelayMs * Math.pow(2, exponent);
  const cappedDelay = Math.min(config.maxDelayMs, exponentialDelay);
  const jitterRange = cappedDelay * config.jitterFactor;
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
    this.registerNotifier(new WebhookNotifier());
    this.registerNotifier(new EmailNotifier());
    this.registerNotifier(new TelegramNotifier());
  }

  registerNotifier(notifier: Notifier): void {
    this.notifiers.set(notifier.channel, notifier);
  }

  /**
   * Main entrypoint: matches a stream event to all active subscriptions
   * and dispatches them with OpenTelemetry push tracing.
   */
  async dispatchStreamEvent(
    event: StreamEvent,
    options: { parentSpan?: Span | null } = {}
  ): Promise<{
    dispatchedCount: number;
    successCount: number;
    failureCount: number;
  }> {
    return globalFrontendTracer.withSpan(
      "push.dispatch",
      async (span) => {
        span.setAttributes({
          "notification.event_type": event.type,
          "notification.event_id": event.id,
          "stream.id": event.payload?.streamId || "unknown",
          "recipient.address": sanitizeAddress(event.address),
        });

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
            config: { ...sub.config },
            attempt: 0,
            createdAt: Math.floor(Date.now() / 1000),
          };

          const delivered = await this.deliverWithRetry(notification, span);
          if (delivered) {
            successCount++;
            await this.store.recordDeliverySuccess(sub.id);
          } else {
            failureCount++;
          }
        }

        span.setAttribute("push.dispatched_count", matchingSubscriptions.length);
        span.setAttribute("push.success_count", successCount);
        span.setAttribute("push.failure_count", failureCount);

        if (failureCount > 0 && successCount === 0 && matchingSubscriptions.length > 0) {
          span.setStatus("ERROR", "All notification deliveries failed");
        } else {
          span.setStatus("OK");
        }

        return {
          dispatchedCount: matchingSubscriptions.length,
          successCount,
          failureCount,
        };
      },
      { parent: options.parentSpan, kind: "PRODUCER" }
    );
  }

  /**
   * Executes channel delivery with bounded exponential backoff retries and channel-level OTel tracing.
   */
  async deliverWithRetry(
    notification: OutgoingNotification,
    parentSpan?: Span
  ): Promise<boolean> {
    const destination = notification.config.webhook?.url
      ? sanitizeWebhookUrl(notification.config.webhook.url)
      : notification.config.email?.email
      ? sanitizeEmail(notification.config.email.email)
      : notification.config.telegram?.chatId
      ? sanitizeTelegramChatId(notification.config.telegram.chatId)
      : "unknown";

    return globalFrontendTracer.withSpan(
      `push.deliver_${notification.channel}`,
      async (channelSpan) => {
        channelSpan.setAttributes({
          "notification.channel": notification.channel,
          "notification.id": notification.id,
          "notification.subscription_id": notification.subscriptionId,
          "notification.destination": destination,
          "recipient.address": sanitizeAddress(notification.address),
          "notification.event_type": notification.event.type,
        });

        // Inject traceparent into outgoing webhook request headers for downstream trace continuation
        if (notification.channel === "webhook" && notification.config.webhook) {
          notification.config.webhook = {
            ...notification.config.webhook,
            customHeaders: {
              ...(notification.config.webhook.customHeaders || {}),
              traceparent: W3CTraceContextPropagator.formatTraceParent(channelSpan.context),
            },
          };
        }

        const notifier = this.notifiers.get(notification.channel);
        if (!notifier) {
          const reason = `No registered notifier found for channel: ${notification.channel}`;
          channelSpan.setStatus("ERROR", reason);
          await this.store.recordDeliveryFailure(notification.subscriptionId, {
            reason,
          });
          return false;
        }

        let attempt = 0;
        while (attempt <= this.retryConfig.maxRetries) {
          notification.attempt = attempt;
          channelSpan.setAttribute("notification.attempt", attempt);
          const result = await notifier.deliver(notification);

          if (result.success) {
            channelSpan.setStatus("OK");
            return true;
          }

          if (result.isBounce) {
            channelSpan.setStatus("ERROR", `Bounce: ${sanitizeError(result.statusMessage)}`);
            await this.store.recordDeliveryFailure(notification.subscriptionId, {
              isBounce: true,
              reason: result.statusMessage,
            });
            return false;
          }

          if (result.fatal || !result.retryable || attempt >= this.retryConfig.maxRetries) {
            channelSpan.setStatus("ERROR", sanitizeError(result.statusMessage));
            await this.store.recordDeliveryFailure(notification.subscriptionId, {
              reason: result.statusMessage,
            });
            return false;
          }

          const delayMs = computeExponentialBackoff(attempt, this.retryConfig);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          attempt++;
        }

        channelSpan.setStatus("ERROR", "Max delivery retries exceeded");
        return false;
      },
      { parent: parentSpan, kind: "CLIENT" }
    );
  }
}

export const defaultDispatcher = new NotificationDispatcher();
