import { describe, expect, it } from "vitest";
import {
  parseAddressExplorerUrlState,
  serializeAddressExplorerUrlState,
} from "./address-explorer-url";

describe("address explorer URL state", () => {
  it("round-trips filters and opaque cursor pagination", () => {
    const source = new URLSearchParams(
      "page=4&cursor=opaque%2Findexer-token&dir=backward&tab=incoming&status=ended&limit=25&sort=id-desc"
    );
    const parsed = parseAddressExplorerUrlState(Object.fromEntries(source));

    expect(parsed).toEqual({
      page: 4,
      cursor: "opaque/indexer-token",
      direction: "backward",
      tab: "incoming",
      status: "ended",
      sort: "id-desc",
      limit: 25,
    });
    expect(parseAddressExplorerUrlState(Object.fromEntries(new URLSearchParams(
      serializeAddressExplorerUrlState(parsed)
    )))).toEqual(parsed);
  });

  it("falls back safely for malformed values and ignores unknown params", () => {
    expect(parseAddressExplorerUrlState({
      page: "-3",
      cursor: "opaque-cursor",
      dir: "sideways",
      tab: "unknown",
      status: "pending",
      limit: "9000",
      sort: "recent",
      surprise: "ignored",
    })).toEqual({
      page: 1,
      cursor: "opaque-cursor",
      direction: "forward",
      tab: "all",
      status: "all",
      sort: "id-desc",
      limit: 10,
    });
    expect(parseAddressExplorerUrlState({ page: "2", cursor: "" }).page).toBe(1);
  });
});
