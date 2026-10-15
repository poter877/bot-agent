"""Media survives the authenticated Hono boundary without rewriting history."""

from __future__ import annotations

import copy
import json

import httpx
import pytest

from agent.hono_stream_client import HonoRequestError, HonoStreamClient, _map_messages
from agent.transports.chat_completions import ChatCompletionsTransport


PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9a0AAAAASUVORK5CYII="
VIDEO = "AAAAFGZ0eXBpc29tAAACAGlzb20="


def _file(media_type, data, **extra):
    return {"type": "file", "mediaType": media_type, "data": {"type": "data", "data": data}, **extra}


@pytest.mark.parametrize("media_kind,media_type,data", [
    ("image_url", "image/png", PNG),
    ("video_url", "video/mp4", VIDEO),
])
def test_native_media_reaches_hono_and_response_still_normalizes(media_kind, media_type, data):
    from tools.vision_tools import _media_messages

    history = _media_messages("Describe this media", media_kind, f"data:{media_type};base64,{data}")
    original = copy.deepcopy(history)
    requests = []

    def handle(request):
        requests.append(json.loads(request.content))
        events = [
            ("ai-sdk", {"type": "start"}),
            ("ai-sdk", {"type": "text-delta", "id": "t1", "text": "Description"}),
            ("ai-sdk", {"type": "finish", "finishReason": "stop", "totalUsage": {"inputTokens": 2, "outputTokens": 1, "totalTokens": 3}}),
            ("end", {"request_id": "media", "status": "complete"}),
        ]
        body = "".join(f"event: {event}\nid: media:{i}\ndata: {json.dumps(value)}\n\n"
                       for i, (event, value) in enumerate(events, 1))
        return httpx.Response(200, headers={
            "content-type": "text/event-stream", "x-model-stream-version": "1", "x-request-id": "media",
        }, text=body)

    with HonoStreamClient("https://backend.test", transport=httpx.MockTransport(handle)) as client:
        response = client.chat.completions.create(model="company-vision", messages=history)

    assert requests[0]["messages"][0]["content"] == [
        {"type": "text", "text": "Describe this media"}, _file(media_type, data),
    ]
    assert ChatCompletionsTransport().normalize_response(response).content == "Description"
    assert history == original


def test_screenshot_tool_history_preserves_media_order_call_identity_and_detail():
    history = [
        {"role": "user", "content": "Read the screen"},
        {"role": "assistant", "content": [{"type": "text", "text": "Looking"}],
         "tool_calls": [{"id": "screen-1", "function": {"name": "computer_use", "arguments": '{"action":"screenshot"}'}}]},
        {"role": "tool", "tool_call_id": "screen-1", "content": [
            {"type": "text", "text": "Screen at 1440x900"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{PNG}", "detail": "high"}},
            {"type": "text", "text": "End of screen"},
        ]},
    ]
    original = copy.deepcopy(history)
    _, messages = _map_messages(history)
    assert messages[1]["content"] == [
        {"type": "text", "text": "Looking"},
        {"type": "tool-call", "toolCallId": "screen-1", "toolName": "computer_use", "input": {"action": "screenshot"}},
    ]
    assert messages[2]["content"] == [{
        "type": "tool-result", "toolCallId": "screen-1", "toolName": "computer_use",
        "output": {"type": "content", "value": [
            {"type": "text", "text": "Screen at 1440x900"},
            _file("image/png", PNG, providerOptions={"openai": {"imageDetail": "high"}}),
            {"type": "text", "text": "End of screen"},
        ]},
    }]
    assert history == original


@pytest.mark.parametrize("part,expected", [
    ({"type": "input_image", "image_url": "https://media.example/frame.png"},
     {"type": "file", "mediaType": "image/png", "data": {"type": "url", "url": "https://media.example/frame.png"}}),
    ({"type": "video_url", "video_url": {"url": "https://media.example/clip.mp4"}},
     {"type": "file", "mediaType": "video/mp4", "data": {"type": "url", "url": "https://media.example/clip.mp4"}}),
    ({"type": "file", "file": {"filename": "clip.webm", "file_data": f"data:video/webm;base64,{VIDEO}"}},
     _file("video/webm", VIDEO, filename="clip.webm")),
])
def test_media_urls_and_file_attachments_keep_explicit_wire_types(part, expected):
    _, messages = _map_messages([{"role": "user", "content": [part]}])
    assert messages == [{"role": "user", "content": [expected]}]


@pytest.mark.parametrize("part", [
    {"type": "image_url", "image_url": {"url": "file:///private/screen.png"}},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,not!base64"}},
    {"type": "video_url", "video_url": {"url": f"data:image/png;base64,{PNG}"}},
    {"type": "future-media", "data": "must not disappear"},
])
def test_invalid_media_fails_before_sending_a_partial_history(part):
    with pytest.raises(HonoRequestError):
        _map_messages([{"role": "user", "content": [{"type": "text", "text": "Keep all input"}, part]}])
