"""X-Correlation-Id propagation through the api_server turn (frozen contract).

Chain under test: an authenticated caller (ai-drama film task) sends
``X-Correlation-Id``; the gateway's request middleware sanitizes and binds it;
``_run_agent`` must re-enter it on the executor thread (``run_in_executor``
drops the context — same crossing ``_api_request_profile`` pays for); and the
outbound model call (hono stream client) plus the account-backend HTTP layer
must copy it into their request headers so bot-backend can journal it.
"""

from unittest.mock import MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from account_backend_session import (
    request_correlation_scope,
    sanitize_correlation_id,
)
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter


def _make_adapter() -> APIServerAdapter:
    return APIServerAdapter(PlatformConfig(enabled=True, extra={}))


def _fake_agent(seen: dict) -> MagicMock:
    agent = MagicMock()
    agent.session_prompt_tokens = 1
    agent.session_completion_tokens = 2
    agent.session_total_tokens = 3

    def _run_conversation(**_kwargs):
        from account_backend_session import current_request_correlation_id

        seen["correlation_id"] = current_request_correlation_id()
        return {"final_response": "ok"}

    agent.run_conversation.side_effect = _run_conversation
    return agent


class TestSanitizer:
    def test_accepts_contract_shape(self):
        assert sanitize_correlation_id("film-run-42") == "film-run-42"
        assert sanitize_correlation_id("task.abc:def-1") == "task.abc:def-1"
        assert sanitize_correlation_id("  padded  ") == "padded"

    def test_rejects_invalid_values(self):
        assert sanitize_correlation_id("film run") is None
        assert sanitize_correlation_id("task;rm -rf") is None
        assert sanitize_correlation_id("") is None
        assert sanitize_correlation_id(None) is None
        assert sanitize_correlation_id("a" * 129) is None
        assert sanitize_correlation_id("a" * 128) == "a" * 128


class TestRunAgentExecutorCrossing:
    """The middleware binds the contextvar on the handler task; ``_run_agent``
    submits the turn to ``run_in_executor`` which starts a FRESH context. The
    capture/re-enter in ``_run_agent`` is what carries the id into the turn."""

    @pytest.mark.asyncio
    async def test_correlation_id_reaches_the_executor_thread(self):
        adapter = _make_adapter()
        seen: dict = {}
        with patch.object(adapter, "_create_agent", return_value=_fake_agent(seen)):
            with request_correlation_scope("film-run-7"):
                result, _usage = await adapter._run_agent(
                    user_message="hello",
                    conversation_history=[],
                    session_id="session-1",
                )
        assert result["final_response"] == "ok"
        assert seen["correlation_id"] == "film-run-7"

    @pytest.mark.asyncio
    async def test_no_correlation_id_outside_a_request_scope(self):
        adapter = _make_adapter()
        seen: dict = {}
        with patch.object(adapter, "_create_agent", return_value=_fake_agent(seen)):
            await adapter._run_agent(
                user_message="hello", conversation_history=[], session_id="session-2"
            )
        assert seen["correlation_id"] is None


class TestInboundHeaderToTurn:
    """End to end over HTTP: the request middleware reads the header, the turn
    sees it on the worker thread, and the surrounding context stays clean."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("header_value", "expected"),
        [
            ("film-run-9", "film-run-9"),
            ("not a valid id!", None),
        ],
    )
    async def test_chat_completions_turn_sees_the_header(self, header_value, expected):
        adapter = _make_adapter()
        seen: dict = {}
        agent = _fake_agent(seen)
        agent.session_id = "session-http"
        app = web.Application(middlewares=[adapter._make_profile_prefix_middleware()])
        app.router.add_post("/v1/chat/completions", adapter._handle_chat_completions)

        with patch.object(adapter, "_create_agent", return_value=agent):
            async with TestClient(TestServer(app)) as cli:
                response = await cli.post(
                    "/v1/chat/completions",
                    json={"messages": [{"role": "user", "content": "hi"}]},
                    headers={"X-Correlation-Id": header_value},
                )
        assert response.status == 200
        assert seen["correlation_id"] == expected

    def test_audit_context_carries_correlation_id(self):
        adapter = _make_adapter()
        request = MagicMock()
        request.transport = None
        request.remote = "127.0.0.1"
        request.method = "POST"
        request.path_qs = "/v1/chat/completions"
        request.headers = {"X-Correlation-Id": "film-run-11"}

        with_id = adapter._request_audit_context(request)
        assert with_id["correlation_id"] == "film-run-11"

        request.headers = {"X-Correlation-Id": "bad value"}
        invalid = adapter._request_audit_context(request)
        assert invalid["correlation_id"] == ""

        request.headers = {}
        absent = adapter._request_audit_context(request)
        assert absent["correlation_id"] == ""
        # The log suffix drops empty fields, so uncorrelated lines stay unchanged.
        assert "correlation_id" not in adapter._request_audit_log_suffix(request)
