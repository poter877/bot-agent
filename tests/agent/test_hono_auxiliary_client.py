"""Hono vision calls retain the authenticated transport through async routing."""

from __future__ import annotations

import asyncio
import base64
import json
import threading
from http.cookiejar import Cookie, MozillaCookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from agent.secret_scope import reset_secret_scope, set_secret_scope


@pytest.fixture
def hono_backend(monkeypatch, tmp_path):
    from account_backend_session import account_auth_cookie_path
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    class CatalogHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/api/llm/models"
            assert self.headers.get("Cookie") == "better-auth.session_token=test-session"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"models": [{"id": "company-vision", "displayName": "Vision",
                "capabilities": {"text": True, "tools": True, "vision": True, "video": True, "reasoning": False}}],
                "defaultModel": "company-vision"}).encode())

        def log_message(self, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), CatalogHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", base_url)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    home_token = set_hermes_home_override(tmp_path)
    secret_token = set_secret_scope({"HERMES_BOT_BACKEND_URL": base_url})
    (tmp_path / "config.yaml").write_text(
        "model:\n  provider: hono\n  model: company-vision\n"
        "auxiliary:\n  vision:\n    provider: hono\n    model: company-vision\n",
        encoding="utf-8",
    )
    jar = MozillaCookieJar(str(account_auth_cookie_path()))
    jar.set_cookie(Cookie(
        version=0, name="better-auth.session_token", value="test-session",
        port=None, port_specified=False, domain="127.0.0.1", domain_specified=True,
        domain_initial_dot=False, path="/", path_specified=True, secure=False,
        expires=None, discard=True, comment=None, comment_url=None, rest={},
    ))
    jar.save(ignore_discard=True)
    requests: list[httpx.Request] = []
    events = [
        {"type": "text-delta", "id": "t", "text": "A person walks across the room."},
        {"type": "finish", "finishReason": "stop", "totalUsage": {"inputTokens": 8, "outputTokens": 4, "totalTokens": 12}},
    ]
    body = b"".join(
        f"id: request:{index}\nevent: ai-sdk\ndata: {json.dumps(event)}\n\n".encode()
        for index, event in enumerate(events, start=1)
    )

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, headers={
            "content-type": "text/event-stream", "x-model-stream-version": "1", "x-request-id": "request",
        }, content=body)

    class MockBackendClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(**{**kwargs, "transport": httpx.MockTransport(handle)})

    monkeypatch.setattr("agent.hono_stream_client.httpx.Client", MockBackendClient)
    try:
        yield requests
    finally:
        from agent.auxiliary_client import shutdown_cached_clients

        shutdown_cached_clients()
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_resolved_async_vision_preserves_hono_session_and_response(hono_backend):
    from agent.auxiliary_client import _close_cached_client, resolve_vision_provider_client

    async def run():
        provider, client, model = resolve_vision_provider_client("hono", "company-vision", async_mode=True)
        try:
            assert (provider, model) == ("hono", "company-vision")
            response = await client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": "Describe the scene."}],
            )
            assert response.choices[0].message.content == "A person walks across the room."
            assert response.usage.total_tokens == 12
            return client._real_client
        finally:
            _close_cached_client(client)

    underlying = asyncio.run(run())
    assert underlying._http.is_closed
    assert len(hono_backend) == 1
    request = hono_backend[0]
    assert request.url.path == "/api/llm/stream"
    assert "better-auth.session_token=test-session" in request.headers["cookie"]
    assert "authorization" not in request.headers


def test_resolved_async_vision_exposes_stream_chunks(hono_backend):
    from agent.auxiliary_client import _close_cached_client, resolve_vision_provider_client

    async def run():
        _, client, model = resolve_vision_provider_client("hono", "company-vision", async_mode=True)
        try:
            chunks = await client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": "Describe."}], stream=True,
            )
            text = []
            async for chunk in chunks:
                if chunk.choices:
                    text.append(chunk.choices[0].delta.content or "")
            assert "".join(text) == "A person walks across the room."
        finally:
            _close_cached_client(client)

    asyncio.run(run())
    assert len(hono_backend) == 1


def test_video_analysis_uses_the_authenticated_async_hono_route(hono_backend, tmp_path):
    from tools.vision_tools import video_analyze_tool

    video_bytes = b"\x00\x00\x00\x18ftypmp42video-sample"
    video = tmp_path / "sample.mp4"
    video.write_bytes(video_bytes)
    result = json.loads(asyncio.run(video_analyze_tool(str(video), "Describe this video.")))

    assert result["success"] is True, result
    assert result["analysis"] == "A person walks across the room."
    assert len(hono_backend) == 1
    request = hono_backend[0]
    assert "better-auth.session_token=test-session" in request.headers["cookie"]
    payload = json.loads(request.content)
    assert payload["model"] == "company-vision"
    assert payload["messages"][0]["content"][1] == {
        "type": "file", "mediaType": "video/mp4",
        "data": {"type": "data", "data": base64.b64encode(video_bytes).decode("ascii")},
    }


def test_cancelling_async_vision_closes_the_active_hono_response(hono_backend, monkeypatch):
    from agent.auxiliary_client import _close_cached_client, resolve_vision_provider_client

    reading = threading.Event()
    closed = threading.Event()

    class WaitingStream(httpx.SyncByteStream):
        def __iter__(self):
            reading.set()
            if not closed.wait(timeout=10):
                raise AssertionError("Cancelling the request did not close its response")
            yield b""

        def close(self):
            closed.set()

    async def run():
        _, client, model = resolve_vision_provider_client("hono", "company-vision", async_mode=True)
        monkeypatch.setattr(client._real_client._http, "send", lambda *args, **kwargs: httpx.Response(
            200, headers={"x-model-stream-version": "1", "x-request-id": "request"}, stream=WaitingStream(),
        ))
        request = asyncio.create_task(client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": "Describe."}],
        ))
        try:
            assert await asyncio.to_thread(reading.wait, 10), "Hono never began reading the response"
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(request, timeout=10)
            assert closed.is_set()
            assert client._real_client._http.is_closed
            _, replacement, _ = resolve_vision_provider_client("hono", model, async_mode=True)
            assert replacement is not client
            response = await replacement.chat.completions.create(
                model=model, messages=[{"role": "user", "content": "Try the next video."}],
            )
            assert response.choices[0].message.content == "A person walks across the room."
        finally:
            closed.set()
            _close_cached_client(client)

    asyncio.run(run())
