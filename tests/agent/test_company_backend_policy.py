"""Company runtime overrides cannot reach a direct provider or another account."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@pytest.fixture
def company_backend(monkeypatch, tmp_path):
    from hermes_cli import config
    from agent.secret_scope import reset_secret_scope, set_secret_scope

    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            calls.append((self.path, self.headers.get("Cookie")))
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert self.path == "/api/llm/stream"
            assert payload["model"] == "company-default"
            assert self.headers.get("Cookie") == "better-auth.session_token=account-one"
            assert self.headers.get("Authorization") is None
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("X-Model-Stream-Version", "1")
            self.send_header("X-Request-Id", "policy")
            self.end_headers()
            for index, event in enumerate([
                {"type": "text-delta", "id": "t", "text": "Company answer."},
                {"type": "finish", "finishReason": "stop", "totalUsage": {"inputTokens": 4, "outputTokens": 2}},
            ], start=1):
                self.wfile.write(f"id: policy:{index}\nevent: ai-sdk\ndata: {json.dumps(event)}\n\n".encode())

        def do_GET(self):
            calls.append((self.path, self.headers.get("Cookie")))
            if self.headers.get("Cookie") != "better-auth.session_token=account-one":
                self.send_response(401)
                self.end_headers()
                return
            if self.path == "/api/llm/models":
                data = {"models": [{"id": "company-default", "displayName": "Company model",
                        "capabilities": {"text": True, "tools": True, "vision": True, "video": True, "reasoning": True}}],
                        "defaultModel": "company-default"}
            else:
                data = {"user": {"id": "one", "email": "one@example.com", "name": "One"}, "session": {"id": "session-one"}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())

        def log_message(self, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", url)
    token = set_secret_scope({"HERMES_BOT_BACKEND_URL": url})
    (tmp_path / "config.yaml").write_text("model:\n  provider: hono\n  default: company-default\n")
    (tmp_path / "account-auth-cookies.txt").write_text(
        "# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t\tbetter-auth.session_token\taccount-one\n")
    config._LOAD_CONFIG_CACHE.clear()
    config._RAW_CONFIG_CACHE.clear()
    try:
        yield url, calls, tmp_path
    finally:
        from agent.auxiliary_client import shutdown_cached_clients

        shutdown_cached_clients()
        reset_secret_scope(token)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        config._LOAD_CONFIG_CACHE.clear()
        config._RAW_CONFIG_CACHE.clear()


def test_runtime_never_uses_explicit_vendor_credentials_in_company_mode(company_backend):
    from hermes_cli.runtime_provider import resolve_runtime_provider

    url, calls, _ = company_backend
    runtime = resolve_runtime_provider(requested="openai", target_model="company-default",
                                       explicit_api_key="vendor-key", explicit_base_url="https://vendor.invalid/v1")
    assert runtime["provider"] == "hono"
    assert runtime["base_url"] == url
    assert runtime["model"] == "company-default"
    assert runtime["api_key"] != "vendor-key"
    assert calls and all(cookie == "better-auth.session_token=account-one" for _, cookie in calls)


def test_auxiliary_explicit_and_cached_routes_stay_on_company_backend(company_backend):
    from agent.auxiliary_client import _get_cached_client, resolve_provider_client
    from agent.hono_stream_client import HonoStreamClient

    for resolve in (resolve_provider_client, _get_cached_client):
        client, model = resolve("openai", model="company-default")
        assert isinstance(client, HonoStreamClient)
        assert model == "company-default"
        assert client.base_url == company_backend[0]
        client.close()


def test_restored_runtime_cannot_restore_vendor_url_or_wire(company_backend):
    from tui_gateway import server

    model, runtime = server._resolve_agent_model_runtime({
        "model": "company-default", "provider": "openai", "base_url": "https://vendor.invalid/v1",
        "api_key": "vendor-secret", "api_mode": "codex_responses",
    }, None)
    assert model == "company-default"
    assert runtime["provider"] == "hono"
    assert runtime["base_url"] == company_backend[0]
    assert runtime["api_mode"] == "chat_completions"
    assert runtime["api_key"] != "vendor-secret"


def test_real_agent_and_auxiliary_calls_use_authenticated_company_stream(company_backend):
    from run_agent import AIAgent
    from agent.auxiliary_client import call_llm

    agent = AIAgent(
        model="company-default", provider="openai", api_key="vendor-secret",
        base_url="https://vendor.invalid/v1", api_mode="codex_responses",
        fallback_model=[{"provider": "anthropic", "model": "direct-vendor-model"}],
        enabled_toolsets=[], quiet_mode=True, skip_context_files=True, skip_memory=True,
        save_trajectories=False, checkpoints_enabled=False, max_iterations=1,
    )
    try:
        result = agent.run_conversation("Say hello.")
        assert result["final_response"] == "Company answer."
        assert agent.provider == "hono"
        assert not agent._fallback_chain
        response = call_llm(
            task="title", model="company-default", provider="openai",
            messages=[{"role": "user", "content": "Summarize this title."}],
        )
        assert response.choices[0].message.content == "Company answer."
    finally:
        agent.close()
    assert sum(path == "/api/llm/stream" for path, _ in company_backend[1]) >= 2


def test_unknown_company_model_fails_without_vendor_fallback(company_backend):
    from agent.auxiliary_client import resolve_provider_client
    from account_backend_models import CompanyModelCatalogError

    with pytest.raises(CompanyModelCatalogError, match="not available"):
        resolve_provider_client("openai", model="gpt-private")
    assert all(path == "/api/llm/models" for path, _ in company_backend[1])
