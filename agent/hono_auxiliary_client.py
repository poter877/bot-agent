"""Async auxiliary calls over the authenticated Hono stream transport."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, AsyncIterator, Coroutine, Generator

from agent.auxiliary_client_async import AsyncCompletionsAdapter
from agent.hono_stream_client import HonoStreamClient

_END = object()


class AsyncHonoStreamClient:
    """Keep the original session-cookie transport when vision tools await a call."""

    HERMES_SKIP_TRANSPORT_WRAP = True

    def __init__(self, sync_client: HonoStreamClient):
        self._real_client = sync_client
        self.api_key, self.base_url = sync_client.api_key, sync_client.base_url
        self._completions = AsyncCompletionsAdapter(sync_client.chat.completions)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _await_worker(self, work: Coroutine[Any, Any, Any]) -> Any:
        pending = asyncio.create_task(work)
        try:
            await asyncio.wait({pending})
            return pending.result()
        except asyncio.CancelledError:
            # Cancelling to_thread alone leaves the HTTP reader running. Close
            # its response, then join it before another request can reuse it.
            self.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            raise

    async def _create(self, **kwargs: Any) -> Any:
        result = await self._await_worker(self._completions.create(**kwargs))
        return self._stream(result) if kwargs.get("stream") else result

    async def _stream(self, iterator: Generator[Any, None, Any]) -> AsyncIterator[Any]:
        try:
            while True:
                chunk = await self._await_worker(asyncio.to_thread(next, iterator, _END))
                if chunk is _END:
                    break
                yield chunk
        finally:
            iterator.close()

    def cancel(self) -> None:
        from agent.auxiliary_client import _evict_cached_client_instance

        try:
            self._real_client.cancel()
        finally:
            _evict_cached_client_instance(self._real_client)

    def close(self) -> None:
        # The auxiliary cache may close clients after their event loop exits;
        # the owned transport is synchronous and does not need that loop.
        self._real_client.close()
