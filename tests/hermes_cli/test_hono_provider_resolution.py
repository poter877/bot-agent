"""The hono provider plugin must engage through the REAL resolution chain
(doc《流式服务端重构》§6): ``model.provider: hono`` resolves via the registry
rung (the "credential" is the backend endpoint's presence), and
``create_client`` returns the HonoStreamClient with session cookies read from
the profile home. Real imports, a temp HERMES_HOME, no mocks of the modules
under test.
"""

from __future__ import annotations

from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

import pytest

from hermes_cli import config as config_mod

CONFIG = """
model:
  provider: hono
  name: company-default
"""


@pytest.fixture
def hono_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / "config.yaml").write_text(CONFIG)
    config_mod._LOAD_CONFIG_CACHE.clear()
    config_mod._RAW_CONFIG_CACHE.clear()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            authenticated = self.headers.get("Cookie") == "account=owner"
            self.send_response(200 if authenticated else 401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            body = {"models": [{"id": "company-default", "displayName": "Company default",
                    "capabilities": {"text": True, "tools": True, "vision": True,
                                     "video": False, "reasoning": False}}],
                    "defaultModel": "company-default"} if authenticated else {"message": "Sign in."}
            self.wfile.write(json.dumps(body).encode())

        def log_message(self, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", f"http://127.0.0.1:{server.server_port}")
    (home / "account-auth-cookies.txt").write_text(
        "# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t\taccount\towner\n")
    try:
        yield home
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _clear_config_caches() -> None:
    config_mod._LOAD_CONFIG_CACHE.clear()
    config_mod._RAW_CONFIG_CACHE.clear()


def test_registry_rung_resolves_and_plugin_client_engages(hono_home: Path, monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from agent.hono_stream_client import HonoStreamClient
    from account_backend_session import bot_backend_base

    runtime = resolve_runtime_provider(requested="hono")
    assert runtime["provider"] == "hono"
    assert runtime["base_url"] == bot_backend_base()
    assert runtime["model"] == "company-default"
    # The endpoint doubles as the placeholder credential; the stream client
    # ignores api_key (real auth rides the profile's session cookie).
    assert runtime["api_key"] == bot_backend_base()
    assert runtime["api_mode"] == "chat_completions"

    from providers import get_provider_profile

    profile = get_provider_profile("hono")
    client = profile.create_client(base_url=runtime["base_url"], api_key=runtime["api_key"])
    assert isinstance(client, HonoStreamClient)
    assert client._base == bot_backend_base()
    client.close()


def test_unconfigured_backend_fails_with_an_actionable_hint(hono_home: Path, monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from account_backend_session import AccountBackendError

    monkeypatch.delenv("HERMES_BOT_BACKEND_URL")
    _clear_config_caches()
    with pytest.raises(AccountBackendError, match="not configured"):
        resolve_runtime_provider(requested="hono")


def test_backend_configuration_without_login_cannot_resolve_models(hono_home: Path):
    from account_backend_models import CompanyModelCatalogError
    from hermes_cli.runtime_provider import resolve_runtime_provider

    (hono_home / "account-auth-cookies.txt").unlink()
    with pytest.raises(CompanyModelCatalogError) as caught:
        resolve_runtime_provider(requested="hono")
    assert caught.value.status_code == 401


def test_session_cookies_come_from_the_profile_home(hono_home: Path):
    from account_backend_session import account_auth_cookie_path, bot_backend_base, load_account_auth_jar

    (hono_home / "account-auth-cookies.txt").write_text("# HTTP Cookie File\n")
    _clear_config_caches()

    assert account_auth_cookie_path() == hono_home / "account-auth-cookies.txt"
    jar = load_account_auth_jar()
    assert Path(jar.filename) == hono_home / "account-auth-cookies.txt"

    from providers import get_provider_profile

    client = get_provider_profile("hono").create_client(base_url="https://untrusted.example/v1")
    # The client holds an httpx view of the profile-home jar (empty here).
    assert client._base == bot_backend_base()
    client.close()
