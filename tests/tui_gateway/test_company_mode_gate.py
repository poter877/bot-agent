"""The company-mode admission gate (``account_auth_guard``): a desktop backend
(HERMES_DESKTOP=1) gates every business RPC behind an authenticated Better Auth
session — unauthenticated is 5060/account_required, an unconfigured backend is
5061/account_unavailable, an authenticated session reaches the handler, and
``client.capabilities`` stays open so the desktop can boot its login screen.
The old local answers for desktop onboarding are gone by design (公司模式：
桌面永不回落本地/厂商凭据) — only a signed-in session reaches the handlers.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tui_gateway import server
from tests.tui_gateway.company_mode import signed_in_company_session


@pytest.fixture
def desktop_home(tmp_path, monkeypatch) -> Path:
    root = tmp_path / ".hermes"
    root.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    return root


def _call(method: str, params: dict | None = None) -> dict:
    return server.handle_request({"jsonrpc": "2.0", "id": 5, "method": method, "params": params or {}})


def test_unauthenticated_desktop_is_account_required(desktop_home, monkeypatch):
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", "http://company.test")
    from tui_gateway import account_auth_guard

    monkeypatch.setattr(account_auth_guard, "_verify_account",
                        lambda method: (_ for _ in ()).throw(__import__("account_backend_session").AccountBackendError("Sign in to continue.", 401)))
    response = _call("onboarding.state")
    assert response["error"]["code"] == 5060
    assert response["error"]["data"] == {"reason": "account_required"}


def test_unconfigured_backend_is_account_unavailable(desktop_home):
    # No HERMES_BOT_BACKEND_URL, no providers.hono entry: desktop mode still
    # refuses to serve business RPCs locally — the error names the fix.
    response = _call("onboarding.state")
    assert response["error"]["code"] == 5061
    assert response["error"]["data"] == {"reason": "account_unavailable"}
    assert "providers.hono.base_url" in response["error"]["message"]


def test_client_capabilities_stays_open_so_the_login_screen_can_boot(desktop_home):
    response = _call("client.capabilities")
    assert "result" in response
    assert "error" not in response


def test_signed_in_session_reaches_the_handler(desktop_home, monkeypatch):
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", "http://company.test")
    signed_in_company_session(monkeypatch)
    response = _call("onboarding.state")
    # A fresh home is due (no install history); the point is that the handler
    # answered — the gate let an authenticated session through.
    assert set(response["result"]) == {"run", "eligible", "session_id", "run_id"}


def test_guard_survives_exotic_params_and_lets_the_handler_fail_closed(desktop_home, monkeypatch):
    """``_scope_params`` is best-effort: an exploding params object must flow to
    the handler (which fails closed) instead of crashing the policy lookup."""
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", "http://company.test")
    signed_in_company_session(monkeypatch)

    class _ExplodingDict:
        def __getitem__(self, key):
            raise RuntimeError("dictionary changed size during iteration")

        def __iter__(self):
            return iter(())

    response = server.handle_request({"jsonrpc": "2.0", "id": 5, "method": "onboarding.set_run", "params": _ExplodingDict()})
    # Not the guard's 5061: the request reached the handler's own validation.
    assert response.get("error", {}).get("code") != 5061
