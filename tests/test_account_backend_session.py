"""Bearer-token (device-flow) credential priority for company-backend sessions.

``hermes account login`` persists a ``bat_`` token next to the cookie jar; these
tests pin the wire-level contract: when the token file exists and is non-empty
every company-backend call carries ``Authorization: Bearer`` and no cookie, the
token's content hash defines the session binding (a token change retires
retained clients exactly like a cookie change), and the file itself is
owner-only.
"""

from __future__ import annotations

import stat
import urllib.request
from http.cookiejar import Cookie, MozillaCookieJar

import pytest

import account_backend_session as account


def _set_cookie(value: str) -> None:
    jar = MozillaCookieJar()
    jar.set_cookie(Cookie(0, "better-auth.session_token", value, None, False,
                          "backend.test", False, False, "/", True, False, None,
                          True, None, None, {}))
    account.save_account_auth_jar(jar)


@pytest.fixture
def account_scope(monkeypatch, tmp_path):
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    # HERMES_BOT_BACKEND_URL is a global-env name: get_secret reads os.environ
    # directly, so the env var (not just the secret scope) must carry it.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", "https://backend.test")
    home = set_hermes_home_override(tmp_path)
    secrets = set_secret_scope({"HERMES_BOT_BACKEND_URL": "https://backend.test"})
    try:
        yield tmp_path
    finally:
        reset_secret_scope(secrets)
        reset_hermes_home_override(home)


def _capture_outbound(monkeypatch, body: bytes = b'{"data": {"ok": true}}') -> list:
    """Record ``(request, installed_a_cookie_processor)`` for each backend call."""
    seen: list[tuple[urllib.request.Request, bool]] = []

    class _Response:
        def read(self, *_args):
            return body

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    class _Opener:
        def __init__(self, handlers):
            self._handlers = handlers

        def open(self, request, timeout=None):
            seen.append((request, any(isinstance(handler, urllib.request.HTTPCookieProcessor)
                                      for handler in self._handlers)))
            return _Response()

    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: _Opener(handlers))
    return seen


def test_token_file_makes_outbound_bearer_only(account_scope, monkeypatch):
    _set_cookie("cookie-session")
    account.save_account_bearer_token("bat_token-a")
    seen = _capture_outbound(monkeypatch)
    assert account.request_account_backend("/api/tools/models") == {"data": {"ok": True}}
    (request, cookie_processor), = seen
    assert request.get_header("Authorization") == "Bearer bat_token-a"
    assert not cookie_processor
    assert not request.has_header("Cookie")


def test_absent_token_falls_back_to_the_cookie_jar(account_scope, monkeypatch):
    _set_cookie("cookie-session")
    seen = _capture_outbound(monkeypatch)
    account.request_account_backend("/api/tools/models")
    (request, cookie_processor), = seen
    assert request.get_header("Authorization") is None
    assert cookie_processor


def test_blank_token_file_falls_back_to_the_cookie_jar(account_scope, monkeypatch):
    _set_cookie("cookie-session")
    account.account_auth_token_path().write_text("   \n", encoding="utf-8")
    seen = _capture_outbound(monkeypatch)
    account.request_account_backend("/api/tools/models")
    (request, cookie_processor), = seen
    assert request.get_header("Authorization") is None
    assert cookie_processor


def test_token_change_retires_the_retained_binding(account_scope):
    _set_cookie("cookie-session")
    account.save_account_bearer_token("bat_token-a")
    _, binding = account.capture_account_session()
    assert account.account_session_matches(binding)
    account.save_account_bearer_token("bat_token-b")
    assert not account.account_session_matches(binding)


def test_token_mode_binding_ignores_cookie_churn(account_scope):
    account.save_account_bearer_token("bat_token-a")
    _, binding = account.capture_account_session()
    _set_cookie("unrelated-cookie-session")
    assert account.account_session_matches(binding)


def test_cleared_token_returns_the_binding_to_cookie_identity(account_scope):
    _set_cookie("cookie-session")
    account.save_account_bearer_token("bat_token-a")
    _, token_binding = account.capture_account_session()
    account.clear_account_bearer_token()
    _, cookie_binding = account.capture_account_session()
    assert not account.account_session_matches(token_binding)
    assert account.account_session_matches(cookie_binding)


@pytest.mark.platforms("posix")
def test_saved_token_file_is_owner_only_and_round_trips(account_scope):
    account.save_account_bearer_token("bat_token-a")
    path = account.account_auth_token_path()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert account.load_account_bearer_token() == "bat_token-a"
    assert path.read_text(encoding="utf-8").strip() == "bat_token-a"
