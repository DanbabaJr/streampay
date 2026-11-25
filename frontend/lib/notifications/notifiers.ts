import { createHmac } from "node:crypto";
import type {
  Notifier,
  OutgoingNotification,
  DeliveryResult,
  NotificationChannelType,
} from "./types.ts";

export type FetchFunction = typeof globalThis.fetch;

/**
 * Webhook delivery adapter with at-least-once guarantee, idempotency keys,
 * and HMAC-SHA256 request signatures.
 */
export class WebhookNotifier implements Notifier {
  readonly channel: NotificationChannelType = "webhook";
  private readonly customFetch: FetchFunction;

  constructor(customFetch: FetchFunction = globalThis.fetch) {
    this.customFetch = customFetch;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    const config = notification.config.webhook;
    if (!config || !config.url) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Missing webhook URL configuration.",
        retryable: false,
        fatal: true,
      };
    }

    const payload = JSON.stringify({
      id: notification.id,
      idempotencyKey: notification.idempotencyKey,
      event: notification.event.type,
      timestamp: notification.event.timestamp,
      address: notification.address,
      data: notification.event.payload,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = config.secret
      ? createHmac("sha256", config.secret)
          .update(`${timestamp}.${payload}`)
          .digest("hex")
      : "";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "StreamPay-Notifier/1.0",
      "Idempotency-Key": notification.idempotencyKey,
      "X-StreamPay-Timestamp": String(timestamp),
      ...(signature ? { "X-StreamPay-Signature": `t=${timestamp},v1=${signature}` } : {}),
      ...(config.customHeaders ?? {}),
    };

    try {
      const res = await this.customFetch(config.url, {
        method: "POST",
        headers,
        body: payload,
      });

      const now = Math.floor(Date.now() / 1000);
      if (res.ok) {
        return {
          success: true,
          deliveredAt: now,
          statusMessage: `Delivered with HTTP ${res.status}`,
          statusCode: res.status,
          retryable: false,
        };
      }

      // 4xx client errors (except 429) mean the endpoint rejected the payload format or auth: fatal, do not retry
      const isClientError = res.status >= 400 && res.status < 500 && res.status !== 429;
      return {
        success: false,
        deliveredAt: now,
        statusMessage: `Webhook target returned HTTP ${res.status}`,
        statusCode: res.status,
        retryable: !isClientError,
        fatal: isClientError,
      };
    } catch (err) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: `Network error delivering webhook: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      };
    }
  }
}

export interface EmailProvider {
  send(to: string, subject: string, text: string): Promise<{ ok: boolean; status?: number; error?: string; isBounce?: boolean }>;
}

/**
 * Pluggable email delivery adapter supporting SMTP or transactional HTTP APIs (Resend/SendGrid).
 * Includes bounce detection to pause failed addresses.
 */
export class EmailNotifier implements Notifier {
  readonly channel: NotificationChannelType = "email";
  private readonly provider?: EmailProvider;

  constructor(provider?: EmailProvider) {
    this.provider = provider;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    const config = notification.config.email;
    if (!config || !config.email) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Missing destination email address.",
        retryable: false,
        fatal: true,
      };
    }

    const { subject, body } = this.formatContent(notification);

    if (this.provider) {
      const res = await this.provider.send(config.email, subject, body);
      const now = Math.floor(Date.now() / 1000);
      if (res.ok) {
        return {
          success: true,
          deliveredAt: now,
          statusMessage: `Email accepted by delivery provider.`,
          retryable: false,
        };
      }
      return {
        success: false,
        deliveredAt: now,
        statusMessage: res.error || "Provider rejected email transmission.",
        statusCode: res.status,
        retryable: !res.isBounce,
        isBounce: res.isBounce,
      };
    }

    // Default mock behavior when no SMTP provider is injected
    return {
      success: true,
      deliveredAt: Math.floor(Date.now() / 1000),
      statusMessage: `Delivered to simulated inbox for ${config.email}`,
      retryable: false,
    };
  }

  private formatContent(notification: OutgoingNotification): { subject: string; body: string } {
    const event = notification.event;
    const typeLabel = event.type.toUpperCase();
    const streamId = event.payload.streamId;

    return {
      subject: `[StreamPay] ${typeLabel} Alert for Stream #${streamId}`,
      body: [
        `StreamPay Event: ${event.type}`,
        `Stream ID: #${streamId}`,
        `Address: ${notification.address}`,
        event.payload.amount ? `Amount: ${event.payload.amount}` : "",
        event.payload.reason ? `Reason: ${event.payload.reason}` : "",
        `Time: ${new Date(event.timestamp * 1000).toUTCString()}`,
        `Idempotency Key: ${notification.idempotencyKey}`,
      ].filter(Boolean).join("\n"),
    };
  }
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<{ ok: boolean; statusCode?: number; retryAfter?: number; error?: string }>;
}

/**
 * Telegram Bot API notification adapter with Markdown formatting and rate-limit handling.
 */
export class TelegramNotifier implements Notifier {
  readonly channel: NotificationChannelType = "telegram";
  private readonly client?: TelegramClient;

  constructor(client?: TelegramClient) {
    this.client = client;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    const config = notification.config.telegram;
    if (!config || !config.chatId) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Missing Telegram chatId configuration.",
        retryable: false,
        fatal: true,
      };
    }

    const message = this.formatTelegramMessage(notification);

    if (this.client) {
      const res = await this.client.sendMessage(config.chatId, message);
      const now = Math.floor(Date.now() / 1000);
      if (res.ok) {
        return {
          success: true,
          deliveredAt: now,
          statusMessage: "Message sent via Telegram Bot API.",
          retryable: false,
        };
      }

      // 403 Forbidden indicates user blocked the bot: fatal
      const isFatal = res.statusCode === 403;
      return {
        success: false,
        deliveredAt: now,
        statusMessage: res.error || "Telegram Bot API error",
        statusCode: res.statusCode,
        retryable: !isFatal,
        fatal: isFatal,
      };
    }

    return {
      success: true,
      deliveredAt: Math.floor(Date.now() / 1000),
      statusMessage: `Delivered to simulated Telegram chat ${config.chatId}`,
      retryable: false,
    };
  }

  private formatTelegramMessage(notification: OutgoingNotification): string {
    const { event } = notification;
    return [
      `🔔 *StreamPay Alert: ${event.type.toUpperCase()}*`,
      `*Stream:* \`#${event.payload.streamId}\``,
      `*Address:* \`${notification.address}\``,
      event.payload.amount ? `*Amount:* \`${event.payload.amount}\`` : "",
      event.payload.reason ? `*Details:* ${event.payload.reason}` : "",
      `*Time:* ${new Date(event.timestamp * 1000).toISOString()}`,
    ].filter(Boolean).join("\n");
  }
}

/**
 * In-memory test sink for recording dispatched events in integration tests.
 */
export class MockSinkNotifier implements Notifier {
  readonly channel: NotificationChannelType;
  readonly delivered: OutgoingNotification[] = [];
  failAttempts = 0;
  isBounce = false;

  constructor(channel: NotificationChannelType = "webhook") {
    this.channel = channel;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    if (this.failAttempts > 0) {
      this.failAttempts -= 1;
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Simulated mock transmission failure",
        statusCode: 500,
        retryable: true,
      };
    }

    if (this.isBounce) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "550 5.1.1 User unknown",
        statusCode: 550,
        retryable: false,
        isBounce: true,
      };
    }

    this.delivered.push(notification);
    return {
      success: true,
      deliveredAt: Math.floor(Date.now() / 1000),
      statusMessage: "Delivered to mock sink",
      retryable: false,
    };
  }
}
