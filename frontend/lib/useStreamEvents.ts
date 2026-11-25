"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { StreamView } from "./pagination";

export type StreamEventType =
  | "stream_created"
  | "withdrawn"
  | "stream_cancelled"
  | "stream_topped_up"
  | "stream_paused"
  | "stream_resumed";

export interface StreamEventData {
  id: string;
  streamId: string;
  eventType: StreamEventType | string;
  ledger: number;
  ledgerClosedAt: string;
  data: Record<string, unknown>;
  stream?: {
    id?: string;
    streamId: string;
    sender: string | null;
    recipient: string | null;
    token: string | null;
    deposit: string | null;
    withdrawn: string;
    startTime: string | null;
    endTime: string | null;
    cancelable: boolean | null;
    status: string;
    cancelled_by?: string | null;
    recipient_amount?: string | null;
    sender_amount?: string | null;
    lastLedger: number;
    updatedAt: string;
  };
}

export type SseConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "fallback_polling";

export interface UseStreamEventsOptions {
  address?: string | null;
  streamId?: string;
  enabled?: boolean;
  onEvent?: (event: StreamEventData) => void;
  onStreamUpdate?: (stream: NonNullable<StreamEventData["stream"]>) => void;
  onFallbackPoll?: () => Promise<void> | void;
  fallbackPollIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface UseStreamEventsReturn {
  status: SseConnectionStatus;
  isLive: boolean;
  isPollingFallback: boolean;
  lastEventId: string | null;
  lastEventAt: Date | null;
  error: Error | null;
  reconnect: () => void;
}

const MAX_DEDUPE_CACHE_SIZE = 1000;

/**
 * Custom React hook managing the lifecycle of Server-Sent Events (SSE)
 * streamed from the indexer via /api/stream-events.
 *
 * Guarantees:
 * - Exponential backoff with jitter on disconnect
 * - Client-side event deduplication by event id (idempotent at-least-once)
 * - Graceful degradation to poll fallback when connection drops
 * - Auto-recovery to live SSE push when backend resumes
 */
export function useStreamEvents({
  address,
  streamId,
  enabled = true,
  onEvent,
  onStreamUpdate,
  onFallbackPoll,
  fallbackPollIntervalMs = 12_000,
  initialBackoffMs = 1_000,
  maxBackoffMs = 30_000,
}: UseStreamEventsOptions): UseStreamEventsReturn {
  const isConfigured = Boolean(enabled && address);
  const [connectionState, setConnectionState] = useState<
    "connected" | "fallback_polling" | "reconnecting" | null
  >(null);

  const status: SseConnectionStatus = !isConfigured
    ? "idle"
    : connectionState === "connected"
    ? "connected"
    : connectionState === "fallback_polling"
    ? "fallback_polling"
    : connectionState === "reconnecting"
    ? "reconnecting"
    : "connecting";

  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // References to keep callbacks fresh across renders without reconnecting
  const onEventRef = useRef(onEvent);
  const onStreamUpdateRef = useRef(onStreamUpdate);
  const onFallbackPollRef = useRef(onFallbackPoll);

  useEffect(() => {
    onEventRef.current = onEvent;
    onStreamUpdateRef.current = onStreamUpdate;
    onFallbackPollRef.current = onFallbackPoll;
  });

  // Deduplication cache: bounded FIFO set of recent event IDs
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenEventOrderRef = useRef<string[]>([]);
  const retryCountRef = useRef(0);

  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  const recordEventId = useCallback((id: string): boolean => {
    if (seenEventIdsRef.current.has(id)) {
      return false; // Duplicate!
    }
    seenEventIdsRef.current.add(id);
    seenEventOrderRef.current.push(id);
    if (seenEventOrderRef.current.length > MAX_DEDUPE_CACHE_SIZE) {
      const oldest = seenEventOrderRef.current.shift();
      if (oldest) seenEventIdsRef.current.delete(oldest);
    }
    return true; // Fresh event
  }, []);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    setConnectionState("reconnecting");
    setReconnectTrigger((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !address) {
      return;
    }

    const params = new URLSearchParams({ address });
    if (streamId) params.set("streamId", streamId);
    if (lastEventId) params.set("lastEventId", lastEventId);

    const sseUrl = `/api/stream-events?${params.toString()}`;

    let es: EventSource | null = null;
    let pollInterval: NodeJS.Timeout | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let destroyed = false;

    function cleanup() {
      if (es) {
        es.close();
        es = null;
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
    }

    function startPollFallback() {
      if (pollInterval) clearInterval(pollInterval);
      if (onFallbackPollRef.current) {
        Promise.resolve(onFallbackPollRef.current()).catch(() => {});
      }
      pollInterval = setInterval(() => {
        if (onFallbackPollRef.current) {
          Promise.resolve(onFallbackPollRef.current()).catch(() => {});
        }
      }, fallbackPollIntervalMs);
    }

    const handleRawPayload = (rawString: string) => {
      try {
        const parsed = JSON.parse(rawString) as StreamEventData;
        if (!parsed.id) return;

        // Perform client-side deduplication
        const isFresh = recordEventId(parsed.id);
        if (!isFresh) {
          return;
        }

        setLastEventId(parsed.id);
        setLastEventAt(new Date());

        if (onEventRef.current) {
          onEventRef.current(parsed);
        }
        if (parsed.stream && onStreamUpdateRef.current) {
          onStreamUpdateRef.current(parsed.stream);
        }
      } catch {
        // Ignore non-JSON keep-alive pings
      }
    };

    function init() {
      if (destroyed) return;
      try {
        es = new EventSource(sseUrl);

        es.onopen = () => {
          if (destroyed) return;
          setConnectionState("connected");
          setError(null);
          retryCountRef.current = 0;
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        };

        es.onmessage = (event) => {
          handleRawPayload(event.data);
        };

        const knownEvents: StreamEventType[] = [
          "stream_created",
          "withdrawn",
          "stream_cancelled",
          "stream_topped_up",
          "stream_paused",
          "stream_resumed",
        ];

        for (const eventName of knownEvents) {
          es.addEventListener(eventName, (e: MessageEvent) => {
            handleRawPayload(e.data);
          });
        }

        es.onerror = () => {
          if (destroyed) return;
          if (es) {
            es.close();
            es = null;
          }

          const attempt = retryCountRef.current + 1;
          retryCountRef.current = attempt;

          setError(new Error(`SSE connection failed (attempt ${attempt})`));
          setConnectionState("fallback_polling");
          startPollFallback();

          const base = Math.min(
            maxBackoffMs,
            initialBackoffMs * Math.pow(2, Math.min(attempt, 6))
          );
          const jitter = Math.random() * 1000;
          const delay = Math.round(base + jitter);

          reconnectTimeout = setTimeout(() => {
            if (!destroyed) {
              setConnectionState("reconnecting");
              init();
            }
          }, delay);
        };
      } catch (err) {
        queueMicrotask(() => {
          if (!destroyed) {
            setError(err instanceof Error ? err : new Error(String(err)));
            setConnectionState("fallback_polling");
            startPollFallback();
          }
        });
      }
    }

    init();

    return () => {
      destroyed = true;
      cleanup();
    };
  }, [
    address,
    streamId,
    enabled,
    lastEventId,
    recordEventId,
    fallbackPollIntervalMs,
    initialBackoffMs,
    maxBackoffMs,
    reconnectTrigger,
  ]);

  return {
    status,
    isLive: status === "connected",
    isPollingFallback: status === "fallback_polling",
    lastEventId,
    lastEventAt,
    error,
    reconnect,
  };
}

/**
 * Maps raw indexed stream projection to UI StreamView model.
 */
export function toStreamView(raw: NonNullable<StreamEventData["stream"]>): StreamView {
  return {
    id: raw.id ?? raw.streamId,
    sender: raw.sender ?? "",
    recipient: raw.recipient ?? "",
    token: raw.token ?? "",
    deposit: raw.deposit ?? "0",
    withdrawn: raw.withdrawn ?? "0",
    startTime: raw.startTime ? Number(raw.startTime) : 0,
    endTime: raw.endTime ? Number(raw.endTime) : 0,
    cancelable: Boolean(raw.cancelable),
    status: raw.status ?? "active",
  };
}
