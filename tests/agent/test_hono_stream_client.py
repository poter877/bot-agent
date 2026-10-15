"""Hono model stream client (doc《流式服务端重构》§4): SSE parsing per the
protocol rules (UTF-8 across chunks, multi-line data, heartbeats, id sequence),
Core-event → OpenAI-chunk translation, the wire request mapping, and the
client/transport integration that lands everything in NormalizedResponse.

The SSE frames below mirror the server-side contract tests in
bot-backend/tests/llm-stream.test.ts — keep the two in sync (one protocol).
"""

from __future__ import annotations

import json
from http.cookiejar import CookieJar
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from agent.chat_completion_helpers import ProviderStreamError
from agent.hono_stream_client import (
    MODEL_STREAM_VERSION,
    HonoHttpError,
    HonoProtocolError,
    HonoRequestError,
    HonoStreamClient,
    SseParser,
    _StreamState,
    _map_messages,
    _build_payload,
    check_stream_ids,
    translate_stream_part,
)
from agent.transports.chat_completions import ChatCompletionsTransport
from agent.transports.types import NormalizedResponse

STREAM_HEADERS = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-model-stream-version": str(MODEL_STREAM_VERSION),
    "x-request-id": "req_123",
}


def frame(event: str, id_: str, data: dict) -> bytes:
    return f"id: {id_}\nevent: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


def sse_body(*frames: bytes) -> bytes:
    return b"".join(frames)


def make_client(handler, cookie_jar: CookieJar | None = None) -> HonoStreamClient:
    return HonoStreamClient(
        "http://backend.test", cookie_jar, transport=httpx.MockTransport(handler), max_request_seconds=30.0
    )


def text_stream_frames() -> list[bytes]:
    return [
        frame("ai-sdk", "req_123:1", {"type": "start"}),
        frame("ai-sdk", "req_123:2", {"type": "start-step", "request": {}, "warnings": []}),
        frame("ai-sdk", "req_123:3", {"type": "text-start", "id": "text_1"}),
        frame("ai-sdk", "req_123:4", {"type": "text-delta", "id": "text_1", "text": "你好"}),
        frame("ai-sdk", "req_123:5", {"type": "text-delta", "id": "text_1", "text": "，世界"}),
        frame("ai-sdk", "req_123:6", {"type": "text-end", "id": "text_1"}),
        frame(
            "ai-sdk", "req_123:7",
            {
                "type": "finish", "finishReason": "stop",
                "totalUsage": {
                    "inputTokens": 12, "outputTokens": 5, "totalTokens": 17,
                    "inputTokenDetails": {"cacheReadTokens": 2, "cacheWriteTokens": 1, "noCacheTokens": 10},
                    "outputTokenDetails": {"reasoningTokens": 1, "textTokens": 4},
                },
            },
        ),
        frame("end", "req_123:8", {"request_id": "req_123", "status": "complete"}),
    ]


# ── SSE parsing ───────────────────────────────────────────────────────────────

class TestSseParser:
    def test_decodes_utf8_split_across_network_chunks(self):
        parser = SseParser()
        raw = 'event: ai-sdk\nid: r:1\ndata: {"type":"text-delta","text":"你好"}\n\n'.encode()
        split = raw.index("你".encode()) + 1  # inside the multi-byte sequence
        events = parser.feed_bytes(raw[:split]) + parser.feed_bytes(raw[split:]) + parser.close()
        assert [(event.event, event.id) for event in events] == [("ai-sdk", "r:1")]
        assert json.loads(events[0].data)["text"] == "你好"

    def test_joins_multi_line_data_and_skips_comments(self):
        parser = SseParser()
        events = parser.feed_text(": heartbeat\n\ndata: first\ndata: second\n\n")
        assert len(events) == 1
        assert events[0].data == "first\nsecond"

    def test_crlf_framing(self):
        parser = SseParser()
        events = parser.feed_bytes(b"event: end\r\ndata: {\"status\":\"complete\"}\r\n\r\n")
        assert events[0].event == "end"

    def test_id_sequence_gap_is_a_protocol_error(self):
        assert check_stream_ids(None, "req:1", "req") == 1
        assert check_stream_ids(1, "req:2", "req") == 2
        with pytest.raises(HonoProtocolError, match="gap"):
            check_stream_ids(1, "req:3", "req")
        # Foreign ids (heartbeats carry none; other streams must not stall us).
        assert check_stream_ids(2, None, "req") == 2


# ── event translation ─────────────────────────────────────────────────────────

class TestTranslateStreamPart:
    def test_text_delta_becomes_content_chunk(self):
        state = _StreamState("m", "req_123")
        (chunk,) = translate_stream_part(state, {"type": "text-delta", "id": "t", "text": "你好"})
        assert chunk.choices[0].delta.content == "你好"
        assert chunk.id == "req_123" and chunk.model == "m"

    def test_reasoning_delta_carries_details_with_signature(self):
        state = _StreamState("m", "req_123")
        (chunk,) = translate_stream_part(state, {
            "type": "reasoning-delta", "id": "r", "text": "想",
            "providerMetadata": {"anthropic": {"signature": "sigABC"}},
        })
        assert chunk.choices[0].delta.reasoning == "想"
        assert chunk.choices[0].delta.reasoning_details == [{"type": "reasoning.text", "text": "想", "signature": "sigABC"}]

    def test_tool_input_fragments_are_buffered_then_superseded_by_tool_call(self):
        state = _StreamState("m", "req_123")
        (start_chunk,) = translate_stream_part(state, {"type": "tool-input-start", "id": "c1", "toolName": "get_weather"})
        delta = start_chunk.choices[0].delta.tool_calls[0]
        assert (delta.index, delta.id, delta.function.name, delta.function.arguments) == (0, "c1", "get_weather", "")
        assert translate_stream_part(state, {"type": "tool-input-delta", "id": "c1", "delta": '{"city":'}) == []
        # A parallel second call gets its own slot.
        (second,) = translate_stream_part(state, {"type": "tool-input-start", "id": "c2", "toolName": "read_file"})
        assert second.choices[0].delta.tool_calls[0].index == 1
        (call_chunk,) = translate_stream_part(state, {"type": "tool-call", "toolCallId": "c1", "toolName": "get_weather", "input": {"city": "北京"}})
        call_delta = call_chunk.choices[0].delta.tool_calls[0]
        assert (call_delta.index, call_delta.id) == (0, "c1")
        assert json.loads(call_delta.function.arguments) == {"city": "北京"}

    def test_finish_maps_reason_and_emits_usage_chunk(self):
        state = _StreamState("m", "req_123")
        chunks = translate_stream_part(state, {
            "type": "finish", "finishReason": "tool-calls",
            "totalUsage": {"inputTokens": 12, "outputTokens": 5, "totalTokens": 17, "inputTokenDetails": {"cacheReadTokens": 2}},
        })
        assert chunks[0].choices[0].finish_reason == "tool_calls"
        assert chunks[1].choices == []
        assert chunks[1].usage.prompt_tokens == 12
        assert chunks[1].usage.prompt_tokens_details.cached_tokens == 2
        assert state.saw_finish is True

    def test_error_part_raises_provider_stream_error(self):
        state = _StreamState("m", "req_123")
        with pytest.raises(ProviderStreamError) as excinfo:
            translate_stream_part(state, {"type": "error", "error": {"message": "quota out", "status": 429}})
        assert excinfo.value.status_code == 429
        assert excinfo.value.body["error"]["message"] == "quota out"

    def test_unsupported_parts_are_counted_never_completed(self):
        state = _StreamState("m", "req_123")
        assert translate_stream_part(state, {"type": "unsupported", "originalType": "file"}) == []
        assert state.unsupported == {"file": 1}
        assert translate_stream_part(state, {"type": "mystery"}) == []
        assert state.unsupported == {"file": 1, "unknown:mystery": 1}


# ── request mapping ───────────────────────────────────────────────────────────

class TestRequestMapping:
    def test_maps_full_history_to_wire_contract(self):
        system, messages = _map_messages([
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "天气？"},
            {"role": "assistant", "content": "查一下", "reasoning": "需要工具", "reasoning_details": [{"type": "reasoning.text", "text": "需要工具", "signature": "s"}],
             "tool_calls": [{"id": "c1", "function": {"name": "get_weather", "arguments": '{"city": "北京"}'}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "晴"},
        ])
        assert system == "be brief"
        assert messages[0] == {"role": "user", "content": "天气？"}
        assistant = messages[1]
        assert assistant["role"] == "assistant"
        assert {"type": "reasoning", "text": "需要工具", "providerMetadata": {"hono": {"details": [{"type": "reasoning.text", "text": "需要工具", "signature": "s"}]}}} in assistant["content"]
        assert {"type": "tool-call", "toolCallId": "c1", "toolName": "get_weather", "input": {"city": "北京"}} in assistant["content"]
        assert messages[2] == {
            "role": "tool",
            "content": [{"type": "tool-result", "toolCallId": "c1", "toolName": "get_weather", "output": {"type": "text", "value": "晴"}}],
        }

    def test_tool_result_without_matching_call_fails_loud(self):
        with pytest.raises(HonoRequestError, match="no matching assistant tool call"):
            _map_messages([{"role": "user", "content": "hi"}, {"role": "tool", "tool_call_id": "ghost", "content": "x"}])

    def test_image_content_is_rejected_not_downgraded(self):
        with pytest.raises(HonoRequestError, match="protocol v1"):
            _map_messages([{"role": "user", "content": [{"type": "text", "text": "看"}]}])

    def test_payload_whitelists_params_and_maps_tools(self):
        payload = _build_payload(
            "company-default",
            [{"role": "user", "content": "hi"}],
            [{"type": "function", "function": {"name": "f", "description": "d", "parameters": {"type": "object"}}}],
            {"temperature": 0.4, "top_p": 0.9, "max_tokens": 128, "stop": ["END"], "seed": 3,
             "tool_choice": {"type": "function", "function": {"name": "f"}}, "presence_penalty": 1},
        )
        assert payload["model"] == "company-default"
        assert payload["tools"] == [{"name": "f", "description": "d", "inputSchema": {"type": "object"}}]
        assert payload["toolChoice"] == {"tool": "f"}
        assert payload["maxOutputTokens"] == 128
        assert payload["stopSequences"] == ["END"]
        assert "presencePenalty" not in payload

    def test_n_greater_than_one_is_rejected(self):
        with pytest.raises(HonoRequestError, match="n > 1"):
            _build_payload("m", [{"role": "user", "content": "hi"}], None, {"n": 2})


# ── client over httpx.MockTransport ───────────────────────────────────────────

class TestClientEndToEnd:
    def _handler(self, requests_log: list[httpx.Request], body: bytes, status: int = 200, headers: dict | None = None):
        def handle(request: httpx.Request) -> httpx.Response:
            requests_log.append(request)
            return httpx.Response(status, headers={**STREAM_HEADERS, **(headers or {})}, content=body)
        return handle

    def test_non_stream_assembles_a_response_the_transport_normalizes(self):
        log: list[httpx.Request] = []
        with make_client(self._handler(log, sse_body(*text_stream_frames()))) as client:
            response = client.chat.completions.create(
                model="company-default",
                messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "你好"}],
                temperature=0.5,
            )
        normalized = ChatCompletionsTransport().normalize_response(response)
        assert isinstance(normalized, NormalizedResponse)
        assert normalized.content == "你好，世界"
        assert normalized.finish_reason == "stop"
        assert normalized.tool_calls is None
        assert normalized.usage.prompt_tokens == 12
        assert normalized.reasoning is None
        # Wire: cookies + Origin + strict payload.
        sent = log[0]
        assert sent.headers["origin"] == "http://backend.test"
        assert sent.headers["accept"] == "text/event-stream"
        payload = json.loads(sent.content)
        assert payload["system"] == "s"
        assert payload["model"] == "company-default"

    def test_non_stream_assembles_tool_calls_and_reasoning(self):
        body = sse_body(
            frame("ai-sdk", "req_123:1", {"type": "start"}),
            frame("ai-sdk", "req_123:2", {"type": "reasoning-start", "id": "r"}),
            frame("ai-sdk", "req_123:3", {"type": "reasoning-delta", "id": "r", "text": "想想"}),
            frame("ai-sdk", "req_123:4", {"type": "reasoning-end", "id": "r"}),
            frame("ai-sdk", "req_123:5", {"type": "tool-input-start", "id": "c1", "toolName": "get_weather"}),
            frame("ai-sdk", "req_123:6", {"type": "tool-input-delta", "id": "c1", "delta": '{"city":"北"}'}),
            frame("ai-sdk", "req_123:7", {"type": "tool-input-delta", "id": "c1", "delta": '京"}'}),
            frame("ai-sdk", "req_123:8", {"type": "tool-input-end", "id": "c1"}),
            frame("ai-sdk", "req_123:9", {"type": "tool-call", "toolCallId": "c1", "toolName": "get_weather", "input": {"city": "北京"}}),
            frame("ai-sdk", "req_123:10", {"type": "finish", "finishReason": "tool-calls", "totalUsage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}}),
            frame("end", "req_123:11", {"request_id": "req_123", "status": "complete"}),
        )
        with make_client(self._handler([], body)) as client:
            response = client.chat.completions.create(model="m", messages=[{"role": "user", "content": "天气？"}])
        normalized = ChatCompletionsTransport().normalize_response(response)
        assert normalized.finish_reason == "tool_calls"
        assert normalized.reasoning == "想想"
        # The streamed reasoning detail (no signature here) is preserved for replay.
        assert (normalized.provider_data or {}).get("reasoning_details") == [{"type": "reasoning.text", "text": "想想"}]
        (tool_call,) = normalized.tool_calls
        assert json.loads(tool_call.arguments) == {"city": "北京"}
        assert tool_call.name == "get_weather"

    def test_stream_mode_yields_chunks_in_order(self):
        with make_client(self._handler([], sse_body(*text_stream_frames()))) as client:
            chunks = list(client.chat.completions.create(model="m", messages=[{"role": "user", "content": "你好"}], stream=True))
        finish_reasons = [
            choice.finish_reason for chunk in chunks if chunk.choices
            for choice in chunk.choices if choice.finish_reason
        ]
        assert finish_reasons == ["stop"]
        contents = [chunk.choices[0].delta.content for chunk in chunks if chunk.choices and chunk.choices[0].delta.content]
        assert contents == ["你好", "，世界"]
        usage_chunks = [chunk for chunk in chunks if not chunk.choices]
        assert usage_chunks[-1].usage.total_tokens == 17

    def test_http_error_carries_status_and_body_for_the_classifier(self):
        error_body = json.dumps({"error": {"code": "unauthorized", "message": "Authentication required."}}).encode()
        with make_client(self._handler([], error_body, status=401, headers={"content-type": "application/json"})) as client:
            with pytest.raises(HonoHttpError) as excinfo:
                client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}])
        assert excinfo.value.status_code == 401
        assert excinfo.value.body["error"]["code"] == "unauthorized"

    def test_protocol_version_mismatch_is_refused(self):
        with make_client(self._handler([], sse_body(*text_stream_frames()), headers={"x-model-stream-version": "99"})) as client:
            stream = client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}], stream=True)
            with pytest.raises(HonoProtocolError, match="protocol version"):
                next(stream)

    def test_failed_end_sentinel_raises_after_partial_content(self):
        body = sse_body(
            frame("ai-sdk", "req_123:1", {"type": "start"}),
            frame("ai-sdk", "req_123:2", {"type": "text-start", "id": "t"}),
            frame("ai-sdk", "req_123:3", {"type": "text-delta", "id": "t", "text": "partial"}),
            frame("end", "req_123:4", {"request_id": "req_123", "status": "failed", "error": {"message": "upstream died"}}),
        )
        chunks: list[Any] = []
        with make_client(self._handler([], body)) as client:
            stream = client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}], stream=True)
            with pytest.raises(ProviderStreamError, match="upstream died"):
                while True:
                    try:
                        chunks.append(next(stream))
                    except StopIteration:  # pragma: no cover - the error raises first
                        break
        assert any(chunk.choices and chunk.choices[0].delta.content == "partial" for chunk in chunks)

    def test_abnormal_eof_never_reads_as_completion(self):
        body = sse_body(
            frame("ai-sdk", "req_123:1", {"type": "start"}),
            frame("ai-sdk", "req_123:2", {"type": "text-start", "id": "t"}),
        )
        with make_client(self._handler([], body)) as client:
            with pytest.raises(ProviderStreamError, match="without a finish event"):
                list(client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}], stream=True))

    def test_cancel_surfaces_as_interrupted_error(self):
        def handle(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers=STREAM_HEADERS, content=sse_body(*text_stream_frames()))
        client = make_client(handle)
        stream = client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}], stream=True)
        next(stream)
        client.cancel()
        with pytest.raises(InterruptedError):
            for _ in stream:
                pass

    def test_cookies_from_the_session_jar_ride_along(self):
        log: list[httpx.Request] = []
        jar = CookieJar()
        import http.cookiejar

        cookie = http.cookiejar.Cookie(
            version=0, name="better-auth.session_token", value="tok123", port=None, port_specified=False,
            domain="backend.test", domain_specified=True, domain_initial_dot=False, path="/", path_specified=True,
            secure=False, expires=None, discard=False, comment=None, comment_url=None, rest={}, rfc2109=False,
        )
        jar.set_cookie(cookie)
        with make_client(self._handler(log, sse_body(*text_stream_frames())), cookie_jar=jar) as client:
            client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}])
        assert "better-auth.session_token=tok123" in log[0].headers.get("cookie", "")
