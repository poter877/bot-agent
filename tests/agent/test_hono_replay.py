"""Signed provider state survives a local tool round and session-shaped history."""

from __future__ import annotations

import copy
import json

import httpx
import pytest

from agent.hono_stream_client import HonoStreamClient, _map_messages
from agent.transports.chat_completions import ChatCompletionsTransport


CASES = [
    (
        "anthropic",
        [
            {"type": "reasoning-start", "id": "r1"},
            {"type": "reasoning-delta", "id": "r1", "text": "Check the screen."},
            {"type": "reasoning-delta", "id": "r1", "text": "", "providerMetadata": {"anthropic": {"signature": "signed-thought"}}},
            {"type": "reasoning-end", "id": "r1"},
            {"type": "reasoning-start", "id": "r2", "providerMetadata": {"anthropic": {"redactedData": "opaque-thought"}}},
            {"type": "reasoning-end", "id": "r2"},
        ],
        [
            {"type": "reasoning", "text": "Check the screen.", "providerOptions": {"anthropic": {"signature": "signed-thought"}}},
            {"type": "reasoning", "text": "", "providerOptions": {"anthropic": {"redactedData": "opaque-thought"}}},
        ],
        {}, {},
    ),
    (
        "google",
        [
            {"type": "reasoning-start", "id": "r1", "providerMetadata": {"google": {"thoughtSignature": "reasoning-signature"}}},
            {"type": "reasoning-delta", "id": "r1", "text": "Check the screen."},
            {"type": "reasoning-end", "id": "r1"},
        ],
        [{"type": "reasoning", "text": "Check the screen.", "providerOptions": {"google": {"thoughtSignature": "reasoning-signature"}}}],
        {"google": {"thoughtSignature": "text-signature"}},
        {"google": {"thoughtSignature": "tool-signature"}},
    ),
    (
        "openai",
        [
            {"type": "reasoning-start", "id": "rs_1:0", "providerMetadata": {"openai": {"itemId": "rs_1", "reasoningEncryptedContent": None}}},
            {"type": "reasoning-delta", "id": "rs_1:0", "text": "Check the screen."},
            {"type": "reasoning-end", "id": "rs_1:0", "providerMetadata": {"openai": {"itemId": "rs_1", "reasoningEncryptedContent": "encrypted-thought"}}},
        ],
        [{"type": "reasoning", "text": "Check the screen.", "providerOptions": {"openai": {"itemId": "rs_1", "reasoningEncryptedContent": "encrypted-thought"}}}],
        {"openai": {"itemId": "msg_1", "phase": "commentary"}},
        {"openai": {"itemId": "fc_1"}},
    ),
]


def _response(parts):
    events = [("ai-sdk", part) for part in [
        {"type": "start"}, *parts,
        {"type": "finish", "finishReason": "tool-calls", "totalUsage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}},
    ]]
    events.append(("end", {"request_id": "replay", "status": "complete"}))
    body = "".join(f"id: replay:{index}\nevent: {event}\ndata: {json.dumps(part)}\n\n"
                   for index, (event, part) in enumerate(events, 1))
    return httpx.Response(200, headers={
        "content-type": "text/event-stream", "x-model-stream-version": "1", "x-request-id": "replay",
    }, text=body)


@pytest.mark.parametrize("stream", [False, True], ids=["collected", "streamed"])
@pytest.mark.parametrize("vendor,reasoning_events,reasoning_parts,text_metadata,tool_metadata", CASES, ids=["anthropic", "google", "openai"])
def test_two_round_replay_through_normalization_history_and_transport(
    monkeypatch, tmp_path, stream, vendor, reasoning_events, reasoning_parts, text_metadata, tool_metadata,
):
    from providers import get_provider_profile
    from run_agent import AIAgent

    profile = get_provider_profile("hono")
    agent = AIAgent(api_key="test", base_url="https://openrouter.ai/api/v1", model="test/model",
                    quiet_mode=True, skip_context_files=True, skip_memory=True)
    agent.api_mode = "chat_completions"
    agent._interrupt_requested = False
    requests = []
    parts = [*reasoning_events,
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "text": "Looking."},
        {"type": "text-delta", "id": "t1", "text": "", "providerMetadata": text_metadata},
        {"type": "text-end", "id": "t1"},
        {"type": "tool-input-start", "id": "call_1", "toolName": "computer"},
        {"type": "tool-call", "toolCallId": "call_1", "toolName": "computer", "input": {"action": "screenshot"}, "providerMetadata": tool_metadata},
    ]

    def handle(request):
        requests.append(json.loads(request.content))
        return _response(parts if len(requests) == 1 else [{"type": "text-delta", "id": "t2", "text": "Done."}])

    transport = ChatCompletionsTransport()
    with HonoStreamClient("https://backend.test", transport=httpx.MockTransport(handle)) as client:
        initial = {"model": "company-model", "messages": [{"role": "user", "content": "Read screen"}]}
        if stream:
            monkeypatch.setattr(agent, "_create_request_openai_client", lambda **_kwargs: client)
            monkeypatch.setattr(agent, "_close_request_openai_client", lambda *_args, **_kwargs: None)
            response = agent._interruptible_streaming_api_call(initial)
        else:
            response = client.chat.completions.create(**initial)
        normalized = transport.normalize_response(response)
        assert normalized.provider_data.get("reasoning_details"), vendor
        stored = agent._build_assistant_message(normalized, "tool_calls")
        from hermes_state import SessionDB

        database = SessionDB(tmp_path / "state.db")
        database.create_session("replay", source="cli")
        database.replace_messages("replay", [
            *initial["messages"], stored,
            {"role": "tool", "tool_call_id": "call_1", "content": "Screen captured"},
        ])
        # Session resume must not rely on live SDK objects or private attributes.
        history = database.get_messages_as_conversation("replay")
        database.close()
        original = copy.deepcopy(history)
        wire = transport.convert_messages(history, model="company-model", provider_profile=profile, base_url="https://backend.test")
        client.chat.completions.create(model="company-model", messages=wire)
    expected_text = {"type": "text", "text": "Looking.", **({"providerOptions": text_metadata} if text_metadata else {})}
    expected_tool = {"type": "tool-call", "toolCallId": "call_1", "toolName": "computer", "input": {"action": "screenshot"},
                     **({"providerOptions": tool_metadata} if tool_metadata else {})}
    assert requests[1]["messages"][1]["content"] == [*reasoning_parts, expected_text, expected_tool]
    assert requests[1]["messages"][2]["content"][0]["toolCallId"] == "call_1"
    assert history == original


def test_replay_does_not_resurrect_filtered_tool_calls():
    carrier = {"type": "hono.native_assistant", "content": [
        {"type": "reasoning", "text": "Thought", "providerOptions": {"anthropic": {"signature": "s"}}},
        {"type": "tool-call", "toolCallId": "removed", "toolName": "computer", "input": {}},
        {"type": "tool-call", "toolCallId": "kept", "toolName": "computer", "input": {}, "providerOptions": {"google": {"thoughtSignature": "signature"}}},
    ]}
    message = {"role": "assistant", "content": None, "reasoning_details": [carrier],
               "tool_calls": [{"id": "kept", "function": {"name": "computer", "arguments": '{"action":"screenshot"}'}}]}
    original = copy.deepcopy(message)
    _, mapped = _map_messages([message])
    assert mapped[0]["content"] == [carrier["content"][0], {
        "type": "tool-call", "toolCallId": "kept", "toolName": "computer", "input": {"action": "screenshot"},
        "providerOptions": {"google": {"thoughtSignature": "signature"}},
    }]
    assert message == original
