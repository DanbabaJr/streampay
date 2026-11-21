import { MAX_PAGE_SIZE } from "./generated.js";

/**
 * Follows `offset`/`limit` pages until a short page is returned.
 *
 * The contract clamps `limit` to `MAX_PAGE_SIZE`, so the effective page size
 * is clamped here first; otherwise a caller passing 100 would treat a full
 * 50-id response as the final page. The offset advances by the number of ids
 * actually returned, which stays correct if the on-chain clamp changes.
 */
export async function collectPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<readonly T[]>,
  pageSize: number = MAX_PAGE_SIZE
): Promise<T[]> {
  const limit = Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE));
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset, limit);
    items.push(...page);
    if (page.length < limit) return items;
    offset += page.length;
  }
}

/** Which on-chain address index to walk. */
export type IndexRole = "sender" | "recipient";
