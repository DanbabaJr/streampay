import type { StreamRoleFilter, StreamStatusFilter, PaginationDirection } from "@/lib/stellar";

export interface AddressExplorerUrlState {
  page: number;
  cursor: string | null;
  direction: PaginationDirection;
  tab: StreamRoleFilter;
  status: StreamStatusFilter;
  sort: "id-desc";
  limit: number;
}

type SearchParamValue = string | string[] | undefined;

function single(value: SearchParamValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : fallback;
}

export function parseAddressExplorerUrlState(
  params: Record<string, SearchParamValue>
): AddressExplorerUrlState {
  const rawTab = single(params.tab);
  const rawStatus = single(params.status);
  const rawDirection = single(params.dir);
  const rawSort = single(params.sort);
  const rawCursor = single(params.cursor);

  const cursor = rawCursor && rawCursor.length <= 2048 ? rawCursor : null;

  return {
    // A page number is only a display/index hint. The opaque cursor remains
    // the source of truth for fetching, so page > 1 without a cursor is invalid.
    page: cursor ? boundedInteger(single(params.page), 1, 1_000_000) : 1,
    cursor,
    direction: rawDirection === "backward" ? "backward" : "forward",
    tab: rawTab === "incoming" || rawTab === "outgoing" ? rawTab : "all",
    status: rawStatus === "active" || rawStatus === "ended" ? rawStatus : "all",
    sort: rawSort === "id-desc" ? "id-desc" : "id-desc",
    limit: boundedInteger(single(params.limit), 10, 50),
  };
}

export function serializeAddressExplorerUrlState(state: AddressExplorerUrlState): string {
  const params = new URLSearchParams();
  if (state.page > 1 && state.cursor) params.set("page", String(state.page));
  if (state.cursor) params.set("cursor", state.cursor);
  if (state.direction === "backward" && state.cursor) params.set("dir", state.direction);
  if (state.tab !== "all") params.set("tab", state.tab);
  if (state.status !== "all") params.set("status", state.status);
  if (state.sort !== "id-desc") params.set("sort", state.sort);
  if (state.limit !== 10) params.set("limit", String(state.limit));
  return params.toString();
}
