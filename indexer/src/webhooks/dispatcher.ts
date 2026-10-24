import { WebhookStore } from "./store.js";
import { validateWebhookUrl } from "./ssrf.js";
import { canonicalizeJson, generateSignatureHeader } from "./hmac.js";
import type { WebhookDelivery, WebhookEventEnvelope } from "./types.js";

export class WebhookDispatcher {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: WebhookStore,
    private readonly pollIntervalMs = 2000
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.dispatchDueDeliveries();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async dispatchDueDeliveries(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    let processedCount = 0;
    try {
      const due = this.store.getDueDeliveries(25);
      for (const delivery of due) {
        await this.deliverSingle(delivery);
        processedCount++;
      }
    } catch (err) {
      console.error("Webhook dispatch loop error:", err);
    } finally {
      this.running = false;
    }

    return processedCount;
  }

  async deliverSingle(delivery: WebhookDelivery): Promise<{
    success: boolean;
    statusCode?: number;
    error?: string;
  }> {
    const endpoint = this.store.getEndpoint(delivery.endpoint_id);
    if (!endpoint || endpoint.status !== "active") {
      this.store.recordDeliveryFailure(
        delivery.id,
        undefined,
        "Endpoint was deleted or disabled",
        0
      );
      return { success: false, error: "Endpoint inactive" };
    }

    const start = Date.now();
    let currentUrl = endpoint.url;

    // Build canonical envelope
    const envelope: WebhookEventEnvelope = {
      event_id: delivery.event_id,
      event_type: delivery.event_type,
      stream_id: delivery.stream_id,
      timestamp: Math.floor(Date.now() / 1000),
      payload: delivery.payload,
    };
    const bodyString = canonicalizeJson(envelope);

    // Generate Streampay-Signature header
    const signatureHeader = generateSignatureHeader(
      endpoint.secret,
      envelope.timestamp,
      bodyString,
      endpoint.previous_secret
    );

    // Handle up to 3 redirects with SSRF guard on every hop
    let redirectHops = 0;
    const maxRedirects = 3;

    while (redirectHops <= maxRedirects) {
      // SSRF check on target URL
      const ssrf = await validateWebhookUrl(currentUrl);
      if (!ssrf.safe) {
        const duration = Date.now() - start;
        const errMsg = `SSRF protection blocked destination: ${ssrf.reason}`;
        this.store.recordDeliveryFailure(delivery.id, 403, errMsg, duration);
        return { success: false, statusCode: 403, error: errMsg };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(currentUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "StreamPay-Webhooks/1.0",
            "Streampay-Signature": signatureHeader,
            "Streampay-Event": delivery.event_type,
            "Streampay-Delivery": delivery.id,
          },
          body: bodyString,
          redirect: "manual",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const duration = Date.now() - start;

        // Check for redirect (3xx)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            const errMsg = `Redirect ${response.status} missing Location header`;
            this.store.recordDeliveryFailure(delivery.id, response.status, errMsg, duration);
            return { success: false, statusCode: response.status, error: errMsg };
          }

          // Resolve relative redirect against current URL
          currentUrl = new URL(location, currentUrl).toString();
          redirectHops++;
          continue;
        }

        // Only 2xx HTTP status codes are considered successful
        if (response.status >= 200 && response.status < 300) {
          this.store.markDeliverySuccess(delivery.id, response.status, duration);
          return { success: true, statusCode: response.status };
        } else {
          // 4xx or 5xx: failure triggering backoff retry
          const bodyText = await response.text().catch(() => "");
          const errMsg = `HTTP ${response.status}: ${bodyText.slice(0, 200) || "Remote server rejected webhook"}`;
          this.store.recordDeliveryFailure(delivery.id, response.status, errMsg, duration);
          return { success: false, statusCode: response.status, error: errMsg };
        }
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        const duration = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.store.recordDeliveryFailure(delivery.id, undefined, errMsg, duration);
        return { success: false, error: errMsg };
      }
    }

    const duration = Date.now() - start;
    const errMsg = "Exceeded maximum of 3 HTTP redirects";
    this.store.recordDeliveryFailure(delivery.id, 310, errMsg, duration);
    return { success: false, statusCode: 310, error: errMsg };
  }

  async testFireEndpoint(endpointId: string): Promise<{
    success: boolean;
    deliveryId?: string;
    statusCode?: number;
    error?: string;
  }> {
    const ep = this.store.getEndpoint(endpointId);
    if (!ep) {
      return { success: false, error: "Endpoint not found" };
    }

    const event = {
      id: `test_${Date.now()}`,
      name: "stream_ping",
      streamId: null,
      ledgerClosedAt: new Date().toISOString(),
      data: {
        ping: true,
        endpoint_id: endpointId,
        message: "Test webhook event triggered from StreamPay dashboard",
      },
    };

    this.store.queueDeliveriesForEvent(event);
    const due = this.store.getDueDeliveries(1);
    const delivery = due.find((d) => d.event_id === event.id);
    if (!delivery) {
      return { success: false, error: "Failed to queue test delivery" };
    }

    const outcome = await this.deliverSingle(delivery);
    return {
      success: outcome.success,
      deliveryId: delivery.id,
      statusCode: outcome.statusCode,
      error: outcome.error,
    };
  }
}
