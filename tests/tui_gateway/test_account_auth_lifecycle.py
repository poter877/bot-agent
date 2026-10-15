"""Account logout must revoke local authority even when the remote service is offline."""

from __future__ import annotations

import threading
from unittest.mock import Mock

from account_backend_session import account_auth_cookie_path
from hermes_constants import get_hermes_home, hermes_home_key
from tui_gateway import server
from tui_gateway.transport import bind_transport, reset_transport


def test_offline_signout_stops_profile_tasks_and_removes_cookie(monkeypatch, tmp_path):
    from agent import auxiliary_client

    owner = get_hermes_home()
    other = tmp_path / "other"
    other.mkdir()
    owner_cookie = account_auth_cookie_path()
    owner_cookie.write_text("old owner cookie")
    foreign_cookie = other / owner_cookie.name
    foreign_cookie.write_text("other account cookie")
    agent = Mock(spec=["interrupt", "close", "session_id"])
    agent.session_id = "owner-stored"
    session = {"profile_home": str(owner), "history_lock": threading.RLock(),
               "agent": agent, "running": True, "queued_prompt": {"text": "later"}}
    foreign = {"profile_home": str(other)}
    monkeypatch.setattr(server, "_sessions", {"owner": session, "foreign": foreign})
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _: False)
    monkeypatch.setattr(server, "_clear_inflight_turn", lambda _: None)
    teardown = threading.Event()
    monkeypatch.setattr(server, "_teardown_popped_session", lambda *a, **k: teardown.set())
    monkeypatch.setattr(server, "_backend_request", Mock(side_effect=OSError("offline")))
    client = Mock(spec=["close"])
    foreign_client = Mock(spec=["close"])
    monkeypatch.setattr(auxiliary_client, "_client_cache", {
        (hermes_home_key(), "hono"): (client, "model", None),
        (hermes_home_key(other), "hono"): (foreign_client, "model", None),
    })
    transport = Mock(spec=["write"])
    token = bind_transport(transport)
    try:
        result = server._methods["accountAuth.signOut"]("logout", {})
    finally:
        reset_transport(token)
    assert result["result"]["ok"] is True
    assert not owner_cookie.exists()
    assert foreign_cookie.read_text() == "other account cookie"
    assert server._sessions == {"foreign": foreign}
    assert session["queued_prompt"] is None
    agent.interrupt.assert_called_once()
    client.close.assert_called_once()
    foreign_client.close.assert_not_called()
    assert teardown.wait(5)
    assert any(call.args[0]["params"].get("type") == "accountAuth.invalidated"
               for call in transport.write.call_args_list)


def test_failed_status_revokes_business_access_without_deleting_recoverable_cookie(monkeypatch):
    cookie = account_auth_cookie_path()
    cookie.write_text("recoverable cookie")
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_backend_request", Mock(side_effect=OSError("offline")))
    transport = Mock(spec=["write"])
    token = bind_transport(transport)
    try:
        response = server._methods["accountAuth.status"]("check", {})
    finally:
        reset_transport(token)
    assert response["error"]["code"] == 5061
    assert cookie.read_text() == "recoverable cookie"
    assert transport.write.call_args.args[0]["params"]["payload"] == {"reason": "unavailable"}


def test_secondary_profile_invalidation_does_not_close_launch_profile(monkeypatch, tmp_path):
    from tui_gateway.account_auth_lifecycle import invalidate_account_session, remember_account_transport

    launch = tmp_path / "launch"
    secondary = tmp_path / "secondary"
    launch.mkdir()
    secondary.mkdir()
    monkeypatch.setattr(server, "_hermes_home", launch)
    launch_cookie = launch / account_auth_cookie_path().name
    launch_cookie.write_text("launch secret")
    secondary_cookie = secondary / launch_cookie.name
    secondary_cookie.write_text("secondary secret")
    launch_transport = Mock(spec=["write"])
    secondary_transport = Mock(spec=["write"])
    launch_session = {"profile_home": None, "transport": launch_transport}
    owned = {"profile_home": str(secondary), "transport": secondary_transport,
             "history_lock": threading.RLock(), "running": False, "agent": None}
    monkeypatch.setattr(server, "_sessions", {"launch": launch_session, "secondary": owned})
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _: False)
    teardown = threading.Event()
    monkeypatch.setattr(server, "_teardown_popped_session", lambda *a, **k: teardown.set())
    token = bind_transport(secondary_transport)
    try:
        with server._session_profile_runtime_scope(owned):
            remember_account_transport()
            invalidate_account_session("expired")
    finally:
        reset_transport(token)
    assert not secondary_cookie.exists()
    assert launch_cookie.read_text() == "launch secret"
    assert server._sessions == {"launch": launch_session}
    launch_transport.write.assert_not_called()
    assert secondary_transport.write.call_args.args[0]["params"]["payload"] == {"reason": "expired"}
    assert teardown.wait(5)


def test_login_handler_uses_shared_http_client_then_rechecks_identity(monkeypatch):
    import account_backend_session

    monkeypatch.setattr(server, "_sessions", {})
    user = {"id": "account-a", "email": "user@example.com", "name": "User"}
    request = Mock(side_effect=[{}, {"user": user}])
    monkeypatch.setattr(account_backend_session, "request_account_backend", request)
    response = server._methods["accountAuth.signIn"]("login", {
        "email": "user@example.com", "password": "secret-password",
    })
    assert response["result"] == {"authenticated": True, "user": user, "error": None}
    assert request.call_args_list[0].args == ("/api/auth/sign-in/email",)
    assert request.call_args_list[1].args == ("/api/auth/get-session",)
