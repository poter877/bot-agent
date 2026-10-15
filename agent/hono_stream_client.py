"""Hono model stream client (doc《流式服务端重构》§4).

An OpenAI-SDK-compatible facade over the company backend's ``POST /api/llm/stream``:
``client.chat.completions.create(**kwargs)`` accepts the standard chat-completions
kwargs, maps them to the wire contract (AI SDK input format: messages without a
system role plus a top-level ``system``, tool JSON Schemas, whitelisted params),
parses the SSE feed of AI SDK Core events, and surfaces OpenAI-shaped stream
chunks (stream mode) or an assembled OpenAI-shaped response (non-stream mode).
The agent's own stream loop, tool-call accumulator, interrupt plumbing and
``normalize_response`` then work unchanged — the GeminiNativeClient pattern.

Vendor keys and upstream model strings never appear here: the client names a
server catalog id, and auth is the profile's Better Auth session cookie jar
(shared with the accountAuth bridge). Failures raise ``HonoHttpError`` (with
``.status_code``/``.body`` so classify_api_error integrates) or the shared
``ProviderStreamError`` for in-stream error events / abnormal EOF.
"""

from __future__ import annotations

import codecs
import json
import logging
import time
from http.cookiejar import CookieJar
from types import SimpleNamespace
from typing import Any, Iterator

import httpx

from agent.chat_completion_helpers import ProviderStreamError
from agent.chat_completion_helpers_tool_calls import _ToolCallAccumulator

logger = logging.getLogger(__name__)

# Wire protocol (doc §4.2): response header X-Model-Stream-Version must match.
MODEL_STREAM_VERSION = 1

_STREAM_PATH = "/api/llm/stream"
_CONNECT_TIMEOUT_SECONDS = 10.0
# Idle budget BETWEEN network reads; the server heartbeats every ~15s, so a
# healthy stream never trips this even during long model thinking.
_IDLE_TIMEOUT_SECONDS = 90.0
_MAX_REQUEST_SECONDS = 600.0

# Core finishReason -> OpenAI finish_reason (doc §5: 显式映射，未知归 stop).
_FINISH_REASON_MAP = {
    "stop": "stop",
    "length": "length",
    "content-filter": "content_filter",
    "tool-calls": "tool_calls",
    "error": "stop",
    "other": "stop",
}


class HonoHttpError(Exception):
    """Non-200 from the backend before (or instead of) a stream. Carries the
    OpenAI-shaped ``body`` the error classifier reads."""

    def __init__(self, status_code: int, body: dict[str, Any], headers: Any = None):
        self.status_code = status_code
        self.body = body
        self.response = SimpleNamespace(headers=headers or {})
        message = str(((body or {}).get("error") or {}).get("message") or f"HTTP {status_code}")
        super().__init__(message)


class HonoProtocolError(Exception):
    """The backend spoke a stream protocol this client cannot consume."""


class HonoRequestError(Exception):
    """The local kwargs cannot be expressed in the wire contract (fail loud)."""


class SseEvent:
    __slots__ = ("data", "event", "id")

    def __init__(self, event: str, id_: str | None, data: str):
        self.event = event
        self.id = id_
        self.data = data


class SseParser:
    """Incremental bytes → SSE events (doc §4.2: UTF-8 across network chunks,
    multi-line data, comment heartbeats; a network chunk is never an event)."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._event: str | None = None
        self._id: str | None = None
        self._data_lines: list[str] = []

    def feed_bytes(self, chunk: bytes) -> list[SseEvent]:
        return self.feed_text(self._decoder.decode(chunk, False))

    def close(self) -> list[SseEvent]:
        events = self.feed_text(self._decoder.decode(b"", True))
        if self._buffer:
            events.extend(self._complete_event())
        return events

    def feed_text(self, text: str) -> list[SseEvent]:
        self._buffer += text.replace("\r\n", "\n").replace("\r", "\n")
        events: list[SseEvent] = []
        while "\n" in self._buffer:
            line, _, self._buffer = self._buffer.partition("\n")
            event = self._line(line)
            if event is not None:
                events.append(event)
        return events

    def _line(self, line: str) -> SseEvent | None:
        if line == "":
            return self._complete_event()
        if line.startswith(":"):
            return None  # heartbeat comment
        field, _sep, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            self._event = value
        elif field == "id":
            self._id = value
        elif field == "data":
            self._data_lines.append(value)
        # Unknown fields (retry, ...) are ignored per the SSE grammar.
        return None

    def _complete_event(self) -> SseEvent | None:
        event, id_, data_lines = self._event, self._id, self._data_lines
        self._event = self._id = None
        self._data_lines = []
        if not data_lines:
            return None
        return SseEvent(event or "message", id_, "\n".join(data_lines))


def check_stream_ids(last_seq: int | None, id_value: str | None, request_id: str) -> int | None:
    """Validate the ``<request_id>:<n>`` id sequence (order checking + de-dup
    only — it does NOT imply resumability). Returns the new last seq."""
    if not id_value or not id_value.startswith(request_id + ":"):
        return last_seq
    try:
        seq = int(id_value.rsplit(":", 1)[1])
    except (IndexError, ValueError):
        raise HonoProtocolError(f"malformed stream event id {id_value!r}") from None
    if last_seq is not None and seq != last_seq + 1:
        raise HonoProtocolError(f"stream event id gap: expected {last_seq + 1}, got {seq}")
    return seq


def _json_value(value: Any) -> Any:
    """JSON-safe projection of a Core part field (server already sanitized)."""
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


class _StreamState:
    """Accumulated Core-event state for one model request."""

    def __init__(self, model: str, request_id: str):
        self.model = model
        self.request_id = request_id
        self.saw_finish = False
        self.finish_reason: str | None = None
        self.usage_raw: dict[str, Any] | None = None
        self.warnings: list[Any] = []
        self.unsupported: dict[str, int] = {}
        # tool-input id -> openai slot index (parallel calls keep distinct slots)
        self.tool_slot_by_id: dict[str, int] = {}
        self.next_tool_slot = 0
        # buffered tool argument fragments (doc §5: 暂存参数片段，不能执行半截 JSON)
        self.tool_args: dict[str, list[str]] = {}
        self.tool_names: dict[str, str] = {}
        self.tool_provider_metadata: dict[str, Any] = {}

    def tool_slot(self, tool_input_id: str) -> int:
        slot = self.tool_slot_by_id.get(tool_input_id)
        if slot is None:
            slot = self.tool_slot_by_id[tool_input_id] = self.next_tool_slot
            self.next_tool_slot += 1
        return slot

    def note_unsupported(self, part_type: str) -> None:
        self.unsupported[part_type] = self.unsupported.get(part_type, 0) + 1
        if self.unsupported[part_type] == 1:
            logger.warning("Hono stream sent %r part; protocol v1 does not carry it (counted, never treated as completion)", part_type)


def _delta_chunk(state: _StreamState, **delta: Any) -> Any:
    return SimpleNamespace(
        id=state.request_id,
        model=state.model,
        created=int(time.time()),
        choices=[SimpleNamespace(index=0, delta=SimpleNamespace(**delta), finish_reason=None)],
        usage=None,
    )


def _final_usage_ns(total_usage: dict[str, Any]) -> Any:
    input_details = total_usage.get("inputTokenDetails") or {}
    output_details = total_usage.get("outputTokenDetails") or {}
    return SimpleNamespace(
        prompt_tokens=total_usage.get("inputTokens") or 0,
        completion_tokens=total_usage.get("outputTokens") or 0,
        total_tokens=total_usage.get("totalTokens") or 0,
        prompt_tokens_details=SimpleNamespace(
            cached_tokens=input_details.get("cacheReadTokens") or 0,
            cache_write_tokens=input_details.get("cacheWriteTokens") or 0,
        ),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=output_details.get("reasoningTokens") or 0),
    )


def _reasoning_delta_chunk(state: _StreamState, part: dict[str, Any]) -> Any:
    delta: dict[str, Any] = {"reasoning": part.get("text") or ""}
    # Preserve the replay-critical opaque state: an anthropic thinking
    # signature rides reasoning_details, which the stream loop merges and the
    # transport parks in provider_data for next-turn replay. Broader provider
    # metadata mapping is a two-vendor acceptance concern (doc §8.5).
    provider_metadata = part.get("providerMetadata") or {}
    signature = (provider_metadata.get("anthropic") or {}).get("signature")
    details: list[dict[str, Any]] = [{"type": "reasoning.text", "text": part.get("text") or ""}]
    if isinstance(signature, str) and signature:
        details[0]["signature"] = signature
    delta["reasoning_details"] = details
    return _delta_chunk(state, **delta)


def translate_stream_part(state: _StreamState, part: dict[str, Any]) -> list[Any]:
    """One AI SDK Core event -> zero or more OpenAI-shaped stream chunks.

    Raises ``ProviderStreamError`` for error/abort parts (the agent's failure /
    retry ladder takes over with already-displayed content preserved)."""
    part_type = part.get("type")
    if part_type in ("start", "start-step"):
        if part_type == "start-step" and part.get("warnings"):
            state.warnings.extend(_json_value(part["warnings"]))
        return []
    if part_type == "text-delta":
        text = part.get("text")
        return [_delta_chunk(state, content=text)] if text else []
    if part_type in ("text-start", "text-end", "reasoning-start", "reasoning-end"):
        return []
    if part_type == "reasoning-delta":
        return [_reasoning_delta_chunk(state, part)]
    if part_type == "tool-input-start":
        if part.get("providerExecuted"):
            # Vendor-hosted tools are disabled server-side; one appearing here
            # is a contract violation, not a tool the local agent can run.
            raise HonoProtocolError("provider-executed tools are not part of protocol v1")
        slot = state.tool_slot(part["id"])
        state.tool_names[part["id"]] = part.get("toolName") or ""
        return [
            _delta_chunk(
                state,
                tool_calls=[
                    SimpleNamespace(
                        index=slot, id=part["id"], type="function",
                        function=SimpleNamespace(name=part.get("toolName") or "", arguments=""),
                    )
                ],
            )
        ]
    if part_type == "tool-input-delta":
        # Buffer the fragments; the authoritative input arrives with tool-call.
        state.tool_args.setdefault(part["id"], []).append(part.get("delta") or "")
        return []
    if part_type == "tool-input-end":
        return []
    if part_type == "tool-call":
        slot = state.tool_slot(part.get("toolCallId") or "")
        arguments = part.get("input")
        args_str = arguments if isinstance(arguments, str) else json.dumps(arguments or {}, ensure_ascii=False)
        state.tool_args.pop(part.get("toolCallId") or "", None)  # authoritative input supersedes buffered fragments
        if part.get("providerMetadata"):
            state.tool_provider_metadata[part.get("toolCallId") or ""] = part["providerMetadata"]
        return [
            _delta_chunk(
                state,
                tool_calls=[
                    SimpleNamespace(
                        index=slot, id=part.get("toolCallId"), type="function",
                        function=SimpleNamespace(name=part.get("toolName") or "", arguments=args_str),
                    )
                ],
            )
        ]
    if part_type == "finish-step":
        if part.get("warnings"):
            state.warnings.extend(_json_value(part["warnings"]))
        return []
    if part_type == "finish":
        state.saw_finish = True
        state.finish_reason = _FINISH_REASON_MAP.get(part.get("finishReason") or "", "stop")
        state.usage_raw = _json_value(part.get("totalUsage") or {})
        # Delta with the SDK's full field set (None where empty) so consumers
        # can attribute-access like they do on real OpenAI chunks.
        empty_delta = SimpleNamespace(
            role=None, content=None, refusal=None, reasoning=None, reasoning_content=None,
            reasoning_details=None, tool_calls=None,
        )
        return [
            # OpenAI order: the finish_reason chunk first, then the choiceless usage frame.
            SimpleNamespace(
                id=state.request_id, model=state.model, created=int(time.time()),
                choices=[SimpleNamespace(index=0, delta=empty_delta, finish_reason=state.finish_reason)],
                usage=None,
            ),
            SimpleNamespace(
                id=state.request_id, model=state.model, created=int(time.time()),
                choices=[], usage=_final_usage_ns(state.usage_raw or {}),
            ),
        ]
    if part_type == "error":
        error = part.get("error") or {}
        if not isinstance(error, dict):
            error = {"message": str(error)}
        body = {"error": {"message": error.get("message") or "model stream error", "code": error.get("code")}}
        raise ProviderStreamError(status_code=error.get("status"), body=body, raw_text=json.dumps(part, ensure_ascii=False))
    if part_type == "abort":
        raise ProviderStreamError(
            status_code=None, body={"error": {"message": "The model stream was aborted."}},
            raw_text=json.dumps(part, ensure_ascii=False),
        )
    if part_type == "unsupported":
        state.note_unsupported(str(part.get("originalType") or "unknown"))
        return []
    state.note_unsupported(f"unknown:{part_type}")
    return []


def _assemble_message(state: _StreamState, content_parts: list[str], reasoning_parts: list[str],
                      reasoning_details: list[Any], tool_calls: _ToolCallAccumulator) -> Any:
    """The OpenAI-shaped assistant message the transport's normalize_response reads."""
    tool_calls.materialize()
    assembled = []
    for idx in sorted(tool_calls.acc):
        entry = tool_calls.acc[idx]
        assembled.append(
            SimpleNamespace(
                id=entry["id"], type=entry["type"], extra_content=entry.get("extra_content"),
                function=SimpleNamespace(
                    name=entry["function"]["name"], arguments=entry["function"]["arguments"],
                    thought_signature=entry.get("thought_signature"),
                ),
            )
        )
    metadata = state.tool_provider_metadata
    if metadata:
        # General tool-call providerMetadata has no replay consumer yet; it is
        # logged so its loss is observable, never silent (doc §4.2).
        logger.debug("Hono stream tool-call providerMetadata dropped (no v1 consumer): %s", list(metadata))
    reasoning = "".join(reasoning_parts) or None
    return SimpleNamespace(
        role="assistant",
        content="".join(content_parts) or None,
        tool_calls=assembled or None,
        # Both spellings: ``reasoning`` is what normalize_response maps to
        # NormalizedResponse.reasoning; ``reasoning_content`` stays in
        # provider_data like every OpenAI-compat reasoning carrier.
        reasoning=reasoning,
        reasoning_content=reasoning,
        reasoning_details=reasoning_details or None,
    )


def _build_response(state: _StreamState, message: Any) -> Any:
    return SimpleNamespace(
        id=state.request_id,
        model=state.model,
        created=int(time.time()),
        choices=[SimpleNamespace(index=0, message=message, finish_reason=state.finish_reason or "stop", logprobs=None)],
        usage=_final_usage_ns(state.usage_raw or {}),
    )


# ── request mapping: chat-completions kwargs -> wire contract ──────────────

_PARAM_WHITELIST = ("temperature", "top_p", "seed")
_PARAM_DROPPED_LOG = "Hono client dropped unsupported chat kwarg %r (protocol v1 does not carry it)"


def _map_messages(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """OpenAI-format history -> (system, wire messages). Vision parts are a
    later product surface; they fail loudly instead of degrading to text."""
    tool_names: dict[str, str] = {}
    for message in messages:
        for tool_call in message.get("tool_calls") or []:
            function = tool_call.get("function") or {}
            if tool_call.get("id") and function.get("name"):
                tool_names[tool_call["id"]] = function["name"]

    system_parts: list[str] = []
    mapped: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if role == "system":
            if isinstance(content, str):
                system_parts.append(content)
            else:
                raise HonoRequestError("system message content must be a string")
            continue
        if role == "user":
            if not isinstance(content, str):
                raise HonoRequestError("non-text user content (images/files) is not part of protocol v1")
            mapped.append({"role": "user", "content": content})
            continue
        if role == "assistant":
            parts: list[dict[str, Any]] = []
            reasoning = message.get("reasoning") or message.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning:
                reasoning_part: dict[str, Any] = {"type": "reasoning", "text": reasoning}
                details = message.get("reasoning_details")
                if details:
                    reasoning_part["providerMetadata"] = {"hono": {"details": _json_value(details)}}
                parts.append(reasoning_part)
            if isinstance(content, str) and content:
                parts.append({"type": "text", "text": content})
            elif isinstance(content, list):
                raise HonoRequestError("non-text assistant content is not part of protocol v1")
            for tool_call in message.get("tool_calls") or []:
                function = tool_call.get("function") or {}
                try:
                    tool_input = json.loads(function.get("arguments") or "{}")
                except json.JSONDecodeError as error:
                    raise HonoRequestError(f"stored tool call {tool_call.get('id')!r} has malformed arguments: {error}") from None
                parts.append({
                    "type": "tool-call",
                    "toolCallId": tool_call.get("id") or "",
                    "toolName": function.get("name") or "",
                    "input": tool_input,
                })
            mapped.append({"role": "assistant", "content": parts if parts else ""})
            continue
        if role == "tool":
            tool_call_id = message.get("tool_call_id") or ""
            tool_name = tool_names.get(tool_call_id)
            if tool_name is None:
                raise HonoRequestError(f"tool result for {tool_call_id!r} has no matching assistant tool call")
            if not isinstance(content, str):
                raise HonoRequestError("tool result content must be a string")
            mapped.append({
                "role": "tool",
                "content": [{
                    "type": "tool-result",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "output": {"type": "text", "value": content},
                }],
            })
            continue
        raise HonoRequestError(f"unsupported message role {role!r}")
    return "\n\n".join(system_parts), mapped


def _map_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    mapped = []
    for tool in tools:
        function = tool.get("function") if isinstance(tool, dict) and "function" in tool else (tool or {})
        name = function.get("name")
        if not name:
            raise HonoRequestError("tool definition without a name")
        mapped.append({
            "name": name,
            "description": function.get("description") or None,
            # Empty schema is legal JSON Schema; vendors require an object.
            "inputSchema": function.get("parameters") or {"type": "object", "properties": {}},
        })
    return mapped


def _build_payload(model: str, messages: Any, tools: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    system, wire_messages = _map_messages(list(messages or []))
    if not wire_messages:
        raise HonoRequestError("request carries no conversational messages")
    payload: dict[str, Any] = {"model": model, "messages": wire_messages}
    if system:
        payload["system"] = system
    mapped_tools = _map_tools(tools)
    if mapped_tools:
        payload["tools"] = mapped_tools
    for source, target in (("temperature", "temperature"), ("top_p", "topP"), ("seed", "seed")):
        if kwargs.get(source) is not None:
            payload[target] = kwargs[source]
    max_tokens = kwargs.get("max_completion_tokens") or kwargs.get("max_tokens")
    if max_tokens is not None:
        payload["maxOutputTokens"] = max_tokens
    stop = kwargs.get("stop")
    if stop:
        payload["stopSequences"] = [stop] if isinstance(stop, str) else list(stop)
    tool_choice = kwargs.get("tool_choice")
    if tool_choice == "auto" or tool_choice == "none" or tool_choice == "required":
        payload["toolChoice"] = tool_choice
    elif isinstance(tool_choice, dict) and tool_choice.get("type") == "function":
        payload["toolChoice"] = {"tool": (tool_choice.get("function") or {}).get("toolName") or (tool_choice.get("function") or {}).get("name") or ""}
    for dropped in ("presence_penalty", "frequency_penalty", "logprobs", "response_format", "user", "n"):
        if kwargs.get(dropped) is not None and dropped != "n":
            logger.debug(_PARAM_DROPPED_LOG, dropped)
    if kwargs.get("n") not in (None, 1):
        raise HonoRequestError("n > 1 is not supported by the model stream")
    return payload


class HonoStreamClient:
    """OpenAI-SDK-shaped client over the company backend's model stream."""

    # Auxiliary/relay layers must not wrap this client: it speaks the full wire itself.
    HERMES_SKIP_TRANSPORT_WRAP = True

    def __init__(
        self,
        base_url: str,
        cookie_jar: CookieJar | None = None,
        *,
        timeout_seconds: float = _IDLE_TIMEOUT_SECONDS,
        max_request_seconds: float = _MAX_REQUEST_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._max_request_seconds = max_request_seconds
        cookies = httpx.Cookies()
        if cookie_jar is not None:
            cookies.update(cookie_jar)
        self._http = httpx.Client(
            cookies=cookies, transport=transport,
            timeout=httpx.Timeout(connect=_CONNECT_TIMEOUT_SECONDS, read=timeout_seconds, write=30.0, pool=_CONNECT_TIMEOUT_SECONDS),
            follow_redirects=False,
        )
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))
        self._cancelled = False
        self._active_response: httpx.Response | None = None

    # Lifecycle: the agent's client slot sweep duck-types close()/cancel().
    def close(self) -> None:
        self._http.close()

    def cancel(self) -> None:
        """Interrupt path: force-close the in-flight response so a blocked
        read raises immediately; the stream loop then raises InterruptedError."""
        self._cancelled = True
        response = self._active_response
        if response is not None:
            try:
                response.close()
            except Exception:
                # The interrupt must land even if the socket is already gone.
                logger.debug("cancel-time response close failed", exc_info=True)
        self.close()

    def __enter__(self) -> HonoStreamClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ── wire ──────────────────────────────────────────────────────────────

    def _create(self, **kwargs: Any) -> Any:
        stream = bool(kwargs.get("stream"))
        model = str(kwargs.get("model") or "")
        payload = _build_payload(model, kwargs.get("messages"), kwargs.get("tools"), kwargs)
        timeout = kwargs.get("timeout") if isinstance(kwargs.get("timeout"), httpx.Timeout) else None
        request = self._http.build_request(
            "POST", self._base + _STREAM_PATH, json=payload,
            headers={"Origin": self._base, "Accept": "text/event-stream"},
            timeout=timeout,
        )
        if stream:
            return self._stream_events(request, model)
        return self._collect_events(request, model)

    def _open(self, request: httpx.Request) -> tuple[httpx.Response, str]:
        if self._cancelled:
            raise InterruptedError("hono stream client cancelled before request")
        response = self._http.send(request, stream=True)
        self._active_response = response
        try:
            if response.status_code != 200:
                body_text = ""
                try:
                    body_text = response.read().decode("utf-8", "replace")
                except httpx.HTTPError as read_error:
                    logger.debug("error body unreadable on HTTP %s: %s", response.status_code, read_error)
                body: dict[str, Any] = {}
                parsed = None
                try:
                    parsed = json.loads(body_text) if body_text else None
                except json.JSONDecodeError:
                    parsed = None
                if isinstance(parsed, dict):
                    body = parsed
                raise HonoHttpError(response.status_code, body, headers=dict(response.headers))
            version = response.headers.get("x-model-stream-version")
            if version is None:
                raise HonoProtocolError("response is missing X-Model-Stream-Version")
            if version.strip() != str(MODEL_STREAM_VERSION):
                raise HonoProtocolError(
                    f"unsupported stream protocol version {version!r} (client speaks {MODEL_STREAM_VERSION})"
                )
            return response, response.headers.get("x-request-id") or ""
        except Exception:
            response.close()
            self._active_response = None
            raise

    def _entry(self, request: httpx.Request) -> tuple[httpx.Response, str]:
        """Interrupt-aware open: a cancel racing the connect surfaces as InterruptedError."""
        try:
            return self._open(request)
        except (httpx.TransportError, InterruptedError) as error:
            if self._cancelled:
                raise InterruptedError("hono stream cancelled") from error
            raise

    def _stream_events(self, request: httpx.Request, model: str) -> Iterator[Any]:
        response, request_id = self._entry(request)
        try:
            yield from self._consume(response, request_id, model)
        finally:
            self._active_response = None
            response.close()

    def _collect_events(self, request: httpx.Request, model: str) -> Any:
        response, request_id = self._entry(request)
        try:
            generator = self._consume(response, request_id, model)
            while True:
                try:
                    next(generator)
                except StopIteration as finished:
                    return finished.value
        finally:
            self._active_response = None
            response.close()

    def _consume(self, response: httpx.Response, request_id: str, model: str) -> Iterator[Any]:
        state = _StreamState(model, request_id)
        parser = SseParser()
        last_seq: int | None = None
        deadline = time.monotonic() + self._max_request_seconds
        end_failure: str | None = None
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        reasoning_details: list[Any] = []
        accumulator = _ToolCallAccumulator()

        def observe(chunk: Any) -> None:
            # Mirror of the agent-side accumulation so non-stream mode can
            # assemble without a second code path.
            choice = chunk.choices[0] if chunk.choices else None
            if choice is None:
                return
            delta = choice.delta
            text = getattr(delta, "content", None)
            if isinstance(text, str) and text:
                content_parts.append(text)
            reasoning = getattr(delta, "reasoning", None) or getattr(delta, "reasoning_content", None)
            if isinstance(reasoning, str) and reasoning:
                reasoning_parts.append(reasoning)
            for detail in getattr(delta, "reasoning_details", None) or []:
                if isinstance(detail, dict):
                    if reasoning_details and reasoning_details[-1].get("type") == detail.get("type") == "reasoning.text":
                        reasoning_details[-1]["text"] = (reasoning_details[-1].get("text") or "") + detail.get("text", "")
                        reasoning_details[-1].setdefault("signature", detail.get("signature"))
                    else:
                        reasoning_details.append(dict(detail))
            for tool_delta in getattr(delta, "tool_calls", None) or []:
                accumulator.feed(tool_delta)

        try:
            for raw_chunk in response.iter_bytes():
                if self._cancelled:
                    raise InterruptedError("hono stream cancelled")
                if time.monotonic() > deadline:
                    raise ProviderStreamError(
                        status_code=None, body={"error": {"message": "The model stream exceeded the client time budget."}},
                        raw_text="",
                    )
                for sse_event in parser.feed_bytes(raw_chunk):
                    if self._cancelled:
                        raise InterruptedError("hono stream cancelled")
                    last_seq = check_stream_ids(last_seq, sse_event.id, request_id)
                    if sse_event.event == "end":
                        end_payload = json.loads(sse_event.data)
                        if end_payload.get("status") == "failed":
                            end_failure = str((end_payload.get("error") or {}).get("message") or "the backend reported a failed stream")
                        break
                    if sse_event.event != "ai-sdk":
                        raise HonoProtocolError(f"unexpected SSE event {sse_event.event!r}")
                    try:
                        part = json.loads(sse_event.data)
                    except json.JSONDecodeError as error:
                        raise HonoProtocolError(f"stream event is not valid JSON: {error}") from None
                    for chunk in translate_stream_part(state, part):
                        observe(chunk)
                        yield chunk
                if end_failure is not None:
                    break
            for sse_event in parser.close():
                if sse_event.event == "end":
                    end_payload = json.loads(sse_event.data)
                    if end_payload.get("status") == "failed":
                        end_failure = str((end_payload.get("error") or {}).get("message") or "the backend reported a failed stream")
        except (httpx.TransportError, InterruptedError) as error:
            if self._cancelled:
                raise InterruptedError("hono stream cancelled") from error
            raise
        finally:
            self._active_response = None

        if end_failure is not None:
            raise ProviderStreamError(
                status_code=None, body={"error": {"message": end_failure}}, raw_text="",
            )
        if not state.saw_finish:
            # Abnormal EOF (doc §8.4): a drop is never a completion.
            raise ProviderStreamError(
                status_code=None, body={"error": {"message": "The model stream ended without a finish event."}},
                raw_text="",
            )
        if state.unsupported:
            logger.info("Hono stream carried unsupported parts (never executed): %s", state.unsupported)
        return _build_response(state, _assemble_message(state, content_parts, reasoning_parts, reasoning_details, accumulator))
