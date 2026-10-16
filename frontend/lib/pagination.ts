export interface StreamView {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
}

export type StreamRoleFilter = "all" | "incoming" | "outgoing";
export type StreamStatusFilter = "all" | "active" | "ended";
export type PaginationDirection = "forward" | "backward";

export interface CursorPaginationOptions {
  cursor?: string | null;
  limit?: number;
  direction?: PaginationDirection;
  role?: StreamRoleFilter;
  status?: StreamStatusFilter;
}

export interface PaginatedStreamsResponse {
  streams: StreamView[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasMore: boolean;
  hasPrev: boolean;
  totalMatching: number;
  asOfTimestamp: number;
}

/**
 * Deterministic cursor pagination over monotonically increasing stream IDs.
 *
 * StreamPay streams have immutable, strictly monotonically increasing u64 IDs.
 * Ordering by stream ID descending (newest first) produces an append-only sequence where:
 * 1. An item's position in the ordering never changes.
 * 2. Newly minted streams prepend without shifting existing pages.
 * 3. Status changes (cancellations or completions) never cause page-shift bugs
 *    because the cursor anchors the query window to a specific stream ID bound
 *    (id < cursor for older, id > cursor for newer), rather than a volatile offset.
 */
export function paginateStreamsByCursor(
  allStreams: StreamView[],
  options: CursorPaginationOptions = {},
  asOfTimestamp: number = Math.floor(Date.now() / 1000)
): PaginatedStreamsResponse {
  const {
    cursor = null,
    limit = 10,
    direction = "forward",
    status = "all",
  } = options;

  let filtered = allStreams;
  if (status === "active") {
    filtered = filtered.filter((s) => s.status === "Active");
  } else if (status === "ended") {
    filtered = filtered.filter((s) => s.status !== "Active");
  }

  // Sort strictly by stream ID descending (newest first)
  const sorted = [...filtered].sort((a, b) => {
    const idA = BigInt(a.id);
    const idB = BigInt(b.id);
    if (idA > idB) return -1;
    if (idA < idB) return 1;
    return 0;
  });

  const totalMatching = sorted.length;
  const pageSize = Math.max(1, Math.min(limit, 100));

  if (sorted.length === 0) {
    return {
      streams: [],
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
      hasPrev: false,
      totalMatching: 0,
      asOfTimestamp,
    };
  }

  if (!cursor) {
    const pageItems = sorted.slice(0, pageSize);
    const hasMore = sorted.length > pageSize;
    return {
      streams: pageItems,
      nextCursor: hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1].id : null,
      prevCursor: null,
      hasMore,
      hasPrev: false,
      totalMatching,
      asOfTimestamp,
    };
  }

  let cursorBigInt: bigint;
  try {
    cursorBigInt = BigInt(cursor);
  } catch {
    // If an invalid cursor is passed, fallback to initial page
    const pageItems = sorted.slice(0, pageSize);
    const hasMore = sorted.length > pageSize;
    return {
      streams: pageItems,
      nextCursor: hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1].id : null,
      prevCursor: null,
      hasMore,
      hasPrev: false,
      totalMatching,
      asOfTimestamp,
    };
  }

  if (direction === "forward") {
    // Forward (older items): id < cursorBigInt in descending order
    const afterCursor = sorted.filter((s) => BigInt(s.id) < cursorBigInt);
    const pageItems = afterCursor.slice(0, pageSize);
    const hasMore = afterCursor.length > pageSize;
    const hasPrev = sorted.some((s) => BigInt(s.id) >= cursorBigInt);

    return {
      streams: pageItems,
      nextCursor: hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1].id : null,
      prevCursor: hasPrev && pageItems.length > 0 ? pageItems[0].id : null,
      hasMore,
      hasPrev,
      totalMatching,
      asOfTimestamp,
    };
  } else {
    // Backward (newer items): id > cursorBigInt in descending order
    // In sorted (descending), items with id > cursor appear BEFORE cursor.
    const beforeCursor = sorted.filter((s) => BigInt(s.id) > cursorBigInt);
    // Take the closest pageSize items ending right before the cursor
    const pageItems = beforeCursor.slice(Math.max(0, beforeCursor.length - pageSize));
    const hasPrev = beforeCursor.length > pageSize;
    const hasMore = sorted.some((s) => BigInt(s.id) <= cursorBigInt);

    return {
      streams: pageItems,
      nextCursor: hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1].id : null,
      prevCursor: hasPrev && pageItems.length > 0 ? pageItems[0].id : null,
      hasMore,
      hasPrev,
      totalMatching,
      asOfTimestamp,
    };
  }
}
