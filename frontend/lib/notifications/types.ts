/**
 * Core type definitions for StreamPay event notifications.
 */

export type NotificationChannelType = "webhook" | "email" | "telegram";

export type StreamEventType =
  | "claim"       // Recipient claimed/withdrew accrued funds
  | "liveness"    // TTL Sentinel warning/critical cliff alert
  | "cancel"      // Stream was cancelled
  | "created"     // New stream created
  | "topped_up";  // Additional funds deposited into stream

export type NotificationDigestOption = "instant" | "hourly_digest" | "daily_digest";

export type SubscriptionStatus = "active" | "paused" | "bounced";

export interface WebhookConfig {
  url: string;
  secret: string; // Used for HMAC-SHA256 signature
  customHeaders?: Record<string, string>;
}

export interface EmailConfig {
  email: string;
  digest: NotificationDigestOption;
}

export interface TelegramConfig {
  chatId: string;
  handle?: string;
}

export interface SubscriptionConfig {
  webhook?: WebhookConfig;
  email?: EmailConfig;
  telegram?: TelegramConfig;
}

export interface StreamEventPayload {
  streamId: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn?: string;
  amount?: string;
  remainingLedgers?: number;
  reason?: string;
  txHash?: string;
}

export interface StreamEvent {
  id: string;
  type: StreamEventType;
  address: string; // The address associated with the event (sender or recipient)
  timestamp: number; // Unix seconds
  payload: StreamEventPayload;
}

export interface Subscription {
  id: string;
  address: string; // Stellar account address
  channel: NotificationChannelType;
  config: SubscriptionConfig;
  eventTypes: StreamEventType[];
  digest: NotificationDigestOption;
  status: SubscriptionStatus;
  verifiedAt: number;
  consecutiveFailures: number;
  lastDeliveredAt?: number;
  bounceReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryResult {
  success: boolean;
  deliveredAt: number;
  statusMessage: string;
  statusCode?: number;
  retryable: boolean;
  fatal?: boolean;
  isBounce?: boolean;
}

export interface OutgoingNotification {
  id: string;
  idempotencyKey: string;
  subscriptionId: string;
  address: string;
  channel: NotificationChannelType;
  event: StreamEvent;
  config: SubscriptionConfig;
  attempt: number;
  createdAt: number;
}

/**
 * Pluggable interface for channel delivery adapters.
 */
export interface Notifier {
  readonly channel: NotificationChannelType;
  deliver(notification: OutgoingNotification): Promise<DeliveryResult>;
}

export interface ChallengeMessage {
  address: string;
  nonce: string;
  timestamp: number;
  expiresAt: number;
  message: string;
}
