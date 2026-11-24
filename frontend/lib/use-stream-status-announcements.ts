"use client";

import { useEffect, useRef } from "react";
import { useToast } from "../components/toast";
import { useT } from "./i18n/provider";
import type { StreamView } from "./pagination";

type StreamStatus = Pick<StreamView, "id" | "status">;

export function normalizeStreamStatus(status: string): string {
  return status.trim().toLowerCase();
}

export function useStreamStatusAnnouncements(streams: readonly StreamStatus[]): void {
  const toast = useToast();
  const t = useT();
  const previousStatuses = useRef(new Map<string, string>());

  useEffect(() => {
    const nextStatuses = new Map<string, string>();
    for (const stream of streams) {
      const status = normalizeStreamStatus(stream.status);
      if (!status) continue;
      nextStatuses.set(stream.id, status);
      const previous = previousStatuses.current.get(stream.id);
      if (previous === undefined || previous === status) continue;

      const dedupeKey = `stream-status:${stream.id}:${status}`;
      if (status === "cancelled") {
        toast.announce(t("home.cancelled", { id: stream.id }), "info", dedupeKey);
      } else {
        toast.announce(
          t("home.statusChanged", { id: stream.id, status }),
          "info",
          dedupeKey
        );
      }
    }
    previousStatuses.current = nextStatuses;
  }, [streams, toast, t]);
}
