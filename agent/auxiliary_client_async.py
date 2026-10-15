"""Shared worker-thread adapter for synchronous auxiliary model clients."""

from __future__ import annotations

import asyncio
from typing import Any


class AsyncCompletionsAdapter:
    """Expose an awaitable completion without blocking the caller's event loop."""

    def __init__(self, sync_adapter: Any):
        self._sync = sync_adapter

    async def create(self, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._sync.create, **kwargs)
