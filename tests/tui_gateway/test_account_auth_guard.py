"""Local business RPC admission uses real HTTP account validation and profile cookies."""

from __future__ import annotations

from http.cookiejar import Cookie, MozillaCookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from types import SimpleNamespace
import threading
from unittest.mock import Mock

import pytest

from agent import secret_scope
from hermes_constants import get_hermes_home
from tui_gateway import launch_profile_policy, server
from tui_gateway.transport import bind_transport, reset_transport


@pytest.fixture
def account_service(tmp_path, monkeypatch):
    from tui_gateway import account_auth_guard

    state = {"valid": {"A", "B"}, "requests": [], "http_status": 200, "clock": 100.0}
    monkeypatch.setattr(account_auth_guard, "time", SimpleNamespace(monotonic=lambda: state["clock"]))
    arrived, release = threading.Event(), threading.Event()
    release.set()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            account = payload["email"].split("@")[0]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Set-Cookie", f"account={account}; Path=/; HttpOnly")
            self.end_headers()
            self.wfile.write(b"{}")

        def do_GET(self):
            cookie = self.headers.get("Cookie", "")
            state["requests"].append((self.path, cookie))
            arrived.set()
            release.wait(5)
            account = cookie.removeprefix("account=")
            self.send_response(state["http_status"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            user = {"id": account, "email": f"{account}@example.com", "name": account}
            self.wfile.write(json.dumps({"user": user} if account in state["valid"] else None).encode())

        def log_message(self, *_):
            return

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    home = tmp_path / "hermes"
    home.mkdir()
    url = f"http://127.0.0.1:{http.server_port}"
    (home / "config.yaml").write_text(f"providers:\n  hono:\n    base_url: {url}\n")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.delenv("HERMES_BOT_BACKEND_URL", raising=False)
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_teardown_popped_session", lambda *a, **k: True)
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _: False)
    monkeypatch.setattr(server, "_served_profile_homes", set())
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", False)
    monkeypatch.setattr(launch_profile_policy, "_snapshot", None)
    yield home, url, state, arrived, release
    release.set()
    http.shutdown()
    http.server_close()
    worker.join(timeout=5)


def _cookie(home, account):
    home.mkdir(parents=True, exist_ok=True)
    jar = MozillaCookieJar(str(home / "account-auth-cookies.txt"))
    jar.set_cookie(Cookie(0, "account", account, None, False, "127.0.0.1", False, False,
                          "/", True, False, None, True, None, None, {}))
    jar.save(ignore_discard=True, ignore_expires=True)


def _call(method, params=None):
    return server.handle_request({"jsonrpc": "2.0", "id": "request", "method": method, "params": params or {}})


def test_business_is_blocked_until_login_and_task_start_rechecks_revocation(account_service, monkeypatch):
    home, _, state, _, _ = account_service
    prompt = Mock(return_value=server._ok("request", {"status": "streaming"}))
    monkeypatch.setitem(server._methods, "prompt.submit", prompt)
    assert _call("prompt.submit", {"session_id": "session", "text": "work"})["error"]["code"] == 5060
    prompt.assert_not_called()
    _cookie(home, "A")
    assert _call("ping")["result"]["pong"] is True
    first_count = len(state["requests"])
    assert _call("ping")["result"]["pong"] is True
    assert len(state["requests"]) == first_count
    state["valid"].remove("A")
    assert _call("prompt.submit", {"session_id": "session", "text": "work"})["error"]["code"] == 5060
    prompt.assert_not_called()
    assert not (home / "account-auth-cookies.txt").exists()


@pytest.mark.parametrize("status", [429, 503])
def test_service_failure_fails_closed_and_emits_invalidation(account_service, monkeypatch, status):
    home, _, state, _, _ = account_service
    _cookie(home, "A")
    assert _call("ping")["result"]["pong"] is True
    state["http_status"] = status
    handler = Mock(return_value=server._ok("request", {"status": "streaming"}))
    monkeypatch.setitem(server._methods, "prompt.submit", handler)
    peer = Mock(spec=["write"])
    token = bind_transport(peer)
    try:
        reply = _call("prompt.submit", {"session_id": "session", "text": "work"})
    finally:
        reset_transport(token)
    assert reply["error"]["code"] == 5061
    assert (home / "account-auth-cookies.txt").exists()
    handler.assert_not_called()
    assert any(call.args[0].get("params", {}).get("payload") == {"reason": "unavailable"}
               for call in peer.write.call_args_list)


def test_profile_cookies_and_handler_secrets_follow_live_session_owner(account_service, monkeypatch):
    home, url, state, _, _ = account_service
    _cookie(home, "A")
    secondary = home / "profiles" / "secondary"
    secondary.mkdir(parents=True)
    (secondary / "config.yaml").write_text(f"providers:\n  hono:\n    base_url: {url}\n")
    (secondary / ".env").write_text("ACCOUNT_TEST_SECRET=secondary-secret\n")
    owned = {"profile_home": str(secondary), "history_lock": threading.RLock(), "agent": None, "running": False}
    monkeypatch.setattr(server, "_sessions", {"secondary-session": owned})
    seen = []

    def probe(rid, _params):
        seen.append((get_hermes_home(), secret_scope.get_secret("ACCOUNT_TEST_SECRET")))
        return server._ok(rid, {"ok": True})

    monkeypatch.setitem(server._methods, "business.probe", probe)
    assert _call("ping")["result"]["pong"] is True
    assert _call("business.probe", {"session_id": "secondary-session"})["error"]["code"] == 5060
    assert seen == []
    _cookie(secondary, "B")
    server._sessions["secondary-session"] = owned
    assert _call("business.probe", {"session_id": "secondary-session"})["result"]["ok"] is True
    assert seen == [(secondary, "secondary-secret")]
    assert state["requests"][-1][1] == "account=B"
    assert _call("business.probe", {"profile": "default", "session_id": "secondary-session"})["error"]["code"] == 4064


def test_only_auth_and_capability_bootstrap_are_admitted_before_login(account_service):
    _, _, state, _, _ = account_service
    assert _call("accountAuth.status")["result"]["authenticated"] is False
    count = len(state["requests"])
    assert "result" in _call("client.capabilities", {"server_requests": True})
    assert len(state["requests"]) == count
    assert _call("gateway.capabilities")["error"]["code"] == 5060


def test_dispatch_does_not_wait_for_account_http_on_the_reader(account_service):
    home, _, _, arrived, release = account_service
    _cookie(home, "A")
    release.clear()
    answered = threading.Event()
    frames = []

    class Peer:
        def write(self, frame):
            frames.append(frame)
            if frame.get("id") == "ping":
                answered.set()
            return True

    assert server.dispatch({"id": "ping", "method": "ping", "params": {}}, Peer()) is None
    assert arrived.wait(5)
    assert not answered.is_set()
    release.set()
    assert answered.wait(5)
    assert frames[-1]["result"]["pong"] is True


def test_read_poll_validation_expires_within_two_seconds(account_service):
    home, _, state, _, _ = account_service
    _cookie(home, "A")
    assert _call("ping")["result"]["pong"] is True
    state["valid"].remove("A")
    state["clock"] += 3
    assert _call("ping")["error"]["code"] == 5060
    assert len(state["requests"]) == 2


def test_admitted_old_request_cannot_construct_a_client_for_a_new_login(account_service, monkeypatch):
    from account_backend_session import AccountBackendError, load_account_auth_jar
    from agent.company_backend_policy import create_company_client
    from agent.memory_provider import spawn_context_thread

    home, _, state, _, _ = account_service
    _cookie(home, "A")
    admitted, switched = threading.Event(), threading.Event()
    responses = []

    def handler(rid, _params):
        admitted.set()
        assert switched.wait(5)
        try:
            client = create_company_client()
        except AccountBackendError as error:
            return server._err(rid, 5060, str(error))
        client.close()
        return server._ok(rid, {"ok": True})

    monkeypatch.setitem(server._methods, "business.probe", handler)
    worker = spawn_context_thread(lambda: responses.append(_call("business.probe")), name="admitted-account-rpc")
    worker.start()
    try:
        assert admitted.wait(5)
        login = _call("accountAuth.signIn", {"email": "B@example.com", "password": "password"})
        assert login["result"]["user"]["id"] == "B"
    finally:
        switched.set()
        worker.join(timeout=5)
    assert responses[0]["error"]["code"] == 5060
    assert {cookie.value for cookie in load_account_auth_jar()} == {"B"}
    assert _call("business.probe")["result"]["ok"] is True
    assert {cookie for _, cookie in state["requests"]} == {"account=A", "account=B"}


def test_unknown_readiness_profile_preserves_failure_result_without_running_a_probe(account_service, monkeypatch):
    probe = Mock()
    for method in ("setup.status", "setup.runtime_check"):
        monkeypatch.setitem(server._methods, method, probe)
        reply = _call(method, {"profile": "missing-profile"})
        assert reply["result"]["ok"] is False
        assert reply["result"]["profile"] == "missing-profile"
    probe.assert_not_called()
