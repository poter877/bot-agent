"""Account/profile directory isolation using real HTTP and profile cookie files."""

from contextlib import contextmanager
from http.cookiejar import Cookie, MozillaCookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading

import pytest

from account_backend_models import CompanyModelCatalogError, fetch_company_models, resolve_company_model
from hermes_constants import reset_hermes_home_override, set_hermes_home_override


def _catalog(alias):
    return {"models": [{"id": alias, "displayName": f"Model {alias}",
                        "contextLength": 98304, "maxOutputTokens": 128,
                        "capabilities": {"text": True, "tools": False, "vision": alias == "alpha",
                                         "video": False, "reasoning": False}}], "defaultModel": alias}


@pytest.fixture
def directory_server(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            cookie = self.headers.get("Cookie", "")
            alias = {"account=A": "alpha", "account=B": "beta"}.get(cookie)
            self.send_response(200 if alias else 401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(_catalog(alias) if alias else {"error": "unauthorized"}).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", f"http://127.0.0.1:{server.server_port}")
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


@contextmanager
def _profile(home, cookie):
    home.mkdir(exist_ok=True)
    jar = MozillaCookieJar(str(home / "account-auth-cookies.txt"))
    jar.set_cookie(Cookie(0, "account", cookie, None, False, "127.0.0.1", False, False,
                          "/", True, False, None, True, None, None, {}))
    jar.save(ignore_discard=True, ignore_expires=True)
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def test_catalog_follows_profile_and_current_account(directory_server, tmp_path):
    with _profile(tmp_path / "a", "A"):
        assert fetch_company_models()["defaultModel"] == "alpha"
    with _profile(tmp_path / "b", "B"):
        assert fetch_company_models()["defaultModel"] == "beta"
        with pytest.raises(CompanyModelCatalogError, match="not available"):
            resolve_company_model("alpha")
    with _profile(tmp_path / "a", "B"):
        assert resolve_company_model(None)["id"] == "beta"
        with pytest.raises(CompanyModelCatalogError, match="video"):
            resolve_company_model("beta", task="video")
    with _profile(tmp_path / "a", "revoked"):
        with pytest.raises(CompanyModelCatalogError) as caught:
            fetch_company_models()
        assert caught.value.status_code == 401


def test_generate_media_speech_kind_uses_speech_endpoint_and_timeout(monkeypatch):
    """speech 走 /api/media/speech 且用短超时（单次合成，非 image/video 的长任务）；
    未知 kind 维持 ValueError 白名单行为。"""
    import account_backend_models
    import account_backend_session

    seen = {}

    def fake_request(path, *, payload=None, timeout=10.0):
        seen["args"] = (path, payload, timeout)
        return {"ok": True, "audio": {"media_type": "audio/mpeg", "base64": ""}}

    monkeypatch.setattr(account_backend_session, "request_account_backend", fake_request)
    result = account_backend_models.generate_media("speech", {"model": "gpt-4o-mini-tts", "input": "hi"})
    assert result["ok"] is True
    path, payload, timeout = seen["args"]
    assert path == "/api/media/speech"
    assert payload == {"model": "gpt-4o-mini-tts", "input": "hi"}
    assert timeout == account_backend_models._SPEECH_TIMEOUT_SECONDS == 120.0
    with pytest.raises(ValueError, match="unknown media kind"):
        account_backend_models.generate_media("audio", {})


def test_managed_inventory_and_selection_share_directory(directory_server, tmp_path):
    from hermes_cli.inventory import ConfigContext, build_model_options_payload
    from hermes_cli.model_switch import persist_model_selection, switch_model
    from hermes_cli.config import read_user_config_raw
    from providers import get_provider_profile

    with _profile(tmp_path / "owner", "A"):
        ctx = ConfigContext("openai", "old-direct-model", "https://api.openai.com/v1", {}, [])
        payload = build_model_options_payload(ctx, include_unconfigured=True)
        assert payload["managed"] is True
        assert [row["slug"] for row in payload["providers"]] == ["hono"]
        assert payload["model"] == "alpha"
        assert payload["providers"][0]["display_names"] == {"alpha": "Model alpha"}
        selected = switch_model("ALPHA", current_provider="openai", current_model="old-direct-model",
                                explicit_provider="hono", is_global=True)
        assert selected.success and selected.target_provider == "hono" and selected.new_model == "alpha"
        path = tmp_path / "owner" / "config.yaml"
        path.write_text("model:\n  provider: openai\n  api_key: private-old-key\n")
        persist_model_selection(selected, path)
        saved = read_user_config_raw(path)["model"]
        assert saved["provider"] == "hono" and saved["default"] == "alpha"
        assert "api_key" not in saved
        assert not switch_model("alpha", "hono", "alpha", explicit_provider="openai").success
        assert not switch_model("invented", "hono", "alpha").success
        profile = get_provider_profile("hono")
        assert profile.fetch_models() == ["alpha"]
        client = profile.create_client(base_url="https://untrusted.example/v1", api_key="ignored")
        try:
            assert client._base == f"http://127.0.0.1:{directory_server.server_port}"
        finally:
            client.close()


def test_request_correlation_id_rides_outbound_account_backend_calls(tmp_path):
    """The gateway binds X-Correlation-Id per inbound request; company-backend
    HTTP calls made inside that scope (media/speech/model directory) carry the
    header so bot-backend journals join back to the originating turn."""
    from account_backend_session import request_account_backend, request_correlation_scope

    seen: dict[str, str | None] = {}

    class CorrelatingHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen["correlation_id"] = self.headers.get("X-Correlation-Id")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"null")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), CorrelatingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        os.environ["HERMES_BOT_BACKEND_URL"] = f"http://127.0.0.1:{server.server_port}"
        with _profile(tmp_path / "correlated", "A"):
            request_account_backend("/api/auth/get-session")  # no scope: header absent
            assert seen["correlation_id"] is None
            with request_correlation_scope("film-run-3"):
                request_account_backend("/api/auth/get-session")
            assert seen["correlation_id"] == "film-run-3"
    finally:
        os.environ.pop("HERMES_BOT_BACKEND_URL", None)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
