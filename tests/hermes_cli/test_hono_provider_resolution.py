"""The hono provider plugin must engage through the REAL resolution chain
(doc《流式服务端重构》§6): ``model.provider: hono`` resolves via the registry
rung (the "credential" is the backend endpoint's presence), and
``create_client`` returns the HonoStreamClient with session cookies read from
the profile home. Real imports, a temp HERMES_HOME, no mocks of the modules
under test.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import config as config_mod

BACKEND = "http://backend.test:3100"

CONFIG = """
model:
  provider: hono
  name: company-default
"""


@pytest.fixture
def hono_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / "config.yaml").write_text(CONFIG)
    config_mod._LOAD_CONFIG_CACHE.clear()
    config_mod._RAW_CONFIG_CACHE.clear()
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", BACKEND)
    return home


def _clear_config_caches() -> None:
    config_mod._LOAD_CONFIG_CACHE.clear()
    config_mod._RAW_CONFIG_CACHE.clear()


def test_registry_rung_resolves_and_plugin_client_engages(hono_home: Path, monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from agent.hono_stream_client import HonoStreamClient

    runtime = resolve_runtime_provider(requested="hono")
    assert runtime["provider"] == "hono"
    assert runtime["base_url"] == BACKEND
    # The endpoint doubles as the placeholder credential; the stream client
    # ignores api_key (real auth rides the profile's session cookie).
    assert runtime["api_key"] == BACKEND
    assert runtime["api_mode"] == "chat_completions"

    from providers import get_provider_profile

    profile = get_provider_profile("hono")
    client = profile.create_client(base_url=runtime["base_url"], api_key=runtime["api_key"])
    assert isinstance(client, HonoStreamClient)
    assert client._base == BACKEND
    client.close()


def test_unconfigured_backend_fails_with_an_actionable_hint(hono_home: Path, monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from hermes_cli.auth import AuthError

    monkeypatch.delenv("HERMES_BOT_BACKEND_URL")
    _clear_config_caches()
    with pytest.raises(AuthError, match="HERMES_BOT_BACKEND_URL"):
        resolve_runtime_provider(requested="hono")


def test_session_cookies_come_from_the_profile_home(hono_home: Path):
    from account_backend_session import account_auth_cookie_path, load_account_auth_jar

    (hono_home / "account-auth-cookies.txt").write_text("# HTTP Cookie File\n")
    _clear_config_caches()

    assert account_auth_cookie_path() == hono_home / "account-auth-cookies.txt"
    jar = load_account_auth_jar()
    assert Path(jar.filename) == hono_home / "account-auth-cookies.txt"

    from providers import get_provider_profile

    client = get_provider_profile("hono").create_client(base_url=BACKEND)
    # The client holds an httpx view of the profile-home jar (empty here).
    assert client._base == BACKEND
    client.close()
