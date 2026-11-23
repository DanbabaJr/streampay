"""On-chain index pagination helper."""
from __future__ import annotations

from typing import Callable, TypeVar

from ._generated import MAX_PAGE_SIZE

T = TypeVar("T")
IndexRole = str  # "sender" | "recipient"


def collect_pages(
    fetch_page: Callable[[int, int], list[T]],
    page_size: int = MAX_PAGE_SIZE,
) -> list[T]:
    """Follows ``offset``/``limit`` pages until a short page is returned.

    The effective page size is clamped to ``MAX_PAGE_SIZE`` first: the
    contract clamps too, so a caller passing a larger limit would otherwise
    mistake a full 50-id page for the final one.
    """
    limit = max(1, min(page_size, MAX_PAGE_SIZE))
    items: list[T] = []
    offset = 0
    while True:
        page = fetch_page(offset, limit)
        items.extend(page)
        if len(page) < limit:
            return items
        offset += len(page)
