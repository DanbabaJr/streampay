import type { StreamPayEvent } from "./generated.js";

export interface StreamFeedEvent {
  id: string;
  cursor: string;
  type: StreamPayEvent["type"];
  streamId: string | null;
  ledger: number;
  ledgerClosedAt: string;
  data: Record<string, unknown>;
  stream?: Record<string, unknown>;
}

export interface SubscribeEventsOptions {
  /** Base URL of the indexer event feed, e.g. `https://indexer.example/events/stream`. */
  eventFeedUrl: string;
  fromCursor?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onError?: (error: unknown) => void;
}

const GENERATED_EVENT_TYPES = [
  "StreamCreated",
  "StreamsCreated",
  "Withdrawn",
  "BatchWithdrawSummary",
  "StreamCancelled",
  "StreamToppedUp",
  "StreamPaused",
  "StreamResumed",
  "StreamScheduled",
  "ScheduledStreamExecuted",
  "ScheduledIntentCancelled",
  "ScheduledIntentExpired",
  "FeeCharged",
  "FeeWithdrawn",
  "DisputeRaised",
  "DisputeResolved",
  "DisputeExpired",
  "SponsorRegistered",
  "SponsorActiveSet",
  "BeneficiaryEnrolled",
  "OperatorKeyRotated",
  "SponsorClaim",
  "PolicyInitialized",
  "PolicyAssetQueued",
  "PolicyAssetExecuted",
  "PolicyHandoffProposed",
  "PolicyHandoffAccepted",
  "PolicyHandoffCancelled",
  "UpgradeProposed",
  "UpgradeCancelled",
  "ContractUpgraded",
  "ContractFrozenStateChanged",
  "StorageMigrated",
  "StreamRecordMigrated",
  "StreamPolicySet",
  "OracleConfigUpdated",
  "OracleTimeReported",
  "OracleStaleFallback",
  "OwnershipProposed",
  "OwnershipAccepted",
  "RateChangeProposed",
  "RateChangeAccepted",
  "GovernanceSignersSet",
  "GovernanceActionProposed",
  "GovernanceActionSigned",
  "GovernanceActionVetoed",
  "GovernanceActionExecuted",
  "SenderTransferProposed",
  "SenderTransferred",
  "SenderTransferExpired",
  "StreamRefundTargetChanged",
  "AdvanceDrawn",
  "AdvanceRepaid",
  "AdvanceLiquidated",
  "ConditionRegistered",
  "ConditionMet",
  "ConditionExpired",
  "TemplateApproved",
  "TemplateInstantiated",
  "HookRegistered",
  "HookInvoked",
  "HookFailed",
] as const satisfies readonly StreamPayEvent["type"][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventTypeFromName(name: string): StreamPayEvent["type"] | null {
  const type = name.replace(/(^|_)([a-z])/g, (_match, _separator: string, letter: string) =>
    letter.toUpperCase()
  );
  return GENERATED_EVENT_TYPES.find((generatedType) => generatedType === type) ?? null;
}

function parseFeedEvent(
  data: string,
  sseId: string | undefined
): StreamFeedEvent | null {
  const value: unknown = JSON.parse(data);
  if (!isRecord(value)) {
    throw new Error("event feed data must be a JSON object");
  }

  const id = sseId ?? value.id;
  if (typeof id !== "string" || typeof value.eventType !== "string") {
    throw new Error("event feed data is missing its id or eventType");
  }

  const type = eventTypeFromName(value.eventType);
  if (type === null) return null;
  const eventData = isRecord(value.data) ? value.data : null;
  if (
    (value.streamId !== null && typeof value.streamId !== "string") ||
    typeof value.ledger !== "number" ||
    typeof value.ledgerClosedAt !== "string" ||
    eventData === null
  ) {
    throw new Error(`event feed data for ${value.eventType} has an invalid shape`);
  }

  const event: StreamFeedEvent = {
    id,
    cursor: id,
    type,
    streamId: value.streamId,
    ledger: value.ledger,
    ledgerClosedAt: value.ledgerClosedAt,
    data: eventData,
  };
  if (isRecord(value.stream)) {
    event.stream = value.stream;
  }
  return event;
}

function abortError(): Error {
  return new DOMException("The event subscription was aborted", "AbortError");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function* readSse(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<{ id?: string; data: string }> {
  if (!response.body) throw new Error("event feed response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const dispatch = (): { id?: string; data: string } | null => {
    if (dataLines.length === 0) {
      eventId = undefined;
      return null;
    }
    const event = { ...(eventId === undefined ? {} : { id: eventId }), data: dataLines.join("\n") };
    eventId = undefined;
    dataLines = [];
    return event;
  };

  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        let line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const event = dispatch();
          if (event) yield event;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
          if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
          if (field === "id" && !fieldValue.includes("\0")) eventId = fieldValue;
          if (field === "data") dataLines.push(fieldValue);
        }
        boundary = buffer.indexOf("\n");
      }
      if (done) {
        const event = dispatch();
        if (event) yield event;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * Subscribes to the indexer's resumable SSE feed. Delivery is at-least-once;
 * use `id`/`cursor` as the deduplication key when applying state changes.
 */
export async function* subscribeEvents(
  streamId: bigint | number | string,
  options: SubscribeEventsOptions
): AsyncGenerator<StreamFeedEvent> {
  if (!/^\d+$/.test(String(streamId))) throw new Error("streamId must be an unsigned integer");
  const fetcher = options.fetch ?? globalThis.fetch;
  const initialBackoffMs = options.initialBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  let cursor = options.fromCursor;
  let attempt = 0;

  while (!options.signal?.aborted) {
    try {
      const url = new URL(options.eventFeedUrl);
      url.searchParams.set("streamId", String(streamId));
      const headers = new Headers({ Accept: "text/event-stream" });
      if (cursor !== undefined) headers.set("Last-Event-ID", cursor);

      const response = await fetcher(url, {
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok) throw new Error(`event feed returned HTTP ${response.status}`);
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new Error("event feed response is not text/event-stream");
      }

      for await (const sseEvent of readSse(response, options.signal)) {
        if (options.signal?.aborted) return;
        if (sseEvent.id !== undefined) cursor = sseEvent.id;
        const event = parseFeedEvent(sseEvent.data, sseEvent.id);
        attempt = 0;
        if (event) yield event;
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      options.onError?.(error);
      attempt += 1;
    }

    if (options.signal?.aborted) return;
    const delay = Math.min(
      maxBackoffMs,
      initialBackoffMs * 2 ** Math.min(Math.max(0, attempt - 1), 30)
    );
    try {
      await wait(delay, options.signal);
    } catch {
      return;
    }
  }
}
