"""Company cloud computer uses real authenticated HTTP and never falls back to the local screen."""

import base64
from http.cookiejar import Cookie, MozillaCookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from unittest.mock import Mock

import pytest


@pytest.fixture
def cloud_service(tmp_path, monkeypatch):
    state = {"requests": [], "running": True, "epoch": 1, "human": False, "status": 200, "generation": 1}
    image = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 8 + (64).to_bytes(4, "big") * 2).decode()

    def snapshot():
        return {"enabled": True, "computer": {"id": "cloud-A", "state": "running" if state["running"] else "stopped",
                "generation": state["generation"], "width": 64, "height": 64,
                "capabilities": {"actions": ["click", "move", "drag", "type", "key", "scroll"], "capture": True}, "error": None},
                "lease": {"holder": "human" if state["human"] else "agent", "epoch": state["epoch"], "expiresAt": None}}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            self.respond(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))

        def respond(self, payload):
            cookie = self.headers.get("Cookie", "")
            state["requests"].append((self.path, cookie, payload))
            status = state["status"] if cookie == "account=A" else 401
            result = snapshot()
            if self.path == "/api/auth/get-session":
                result = {"user": {"id": "A", "name": "A", "email": "a@example.com"}}
            elif self.path.endswith("/lease/acquire"):
                state["human"], state["epoch"] = True, state["epoch"] + 1
                result = {**snapshot(), "viewerToken": "private-human-token"}
            elif self.path.endswith("/lease/release"):
                state["human"], state["epoch"] = False, state["epoch"] + 1
                result = snapshot()
            elif self.path.endswith(("/capture", "/actions")):
                if payload["leaseEpoch"] != state["epoch"] or payload["computerGeneration"] != state["generation"]:
                    status = 409
                if payload["actor"] == "agent" and state["human"]:
                    status = 409
                if payload["actor"] == "human" and self.path.endswith("/actions") and payload.get("viewerToken") != "private-human-token":
                    status = 403
                result = {"computerGeneration": state["generation"], "leaseEpoch": state["epoch"]}
                result.update({"image": {"mediaType": "image/png", "data": image, "width": 64, "height": 64}}
                              if self.path.endswith("/capture") else {"ok": True})
                if self.path.endswith("/capture") and state.get("takeover_after_capture"):
                    state["epoch"] += 2  # a complete human takeover / hand-back cycle
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result if status == 200 else {"message": "cloud request refused"}).encode())

        def log_message(self, *_):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(f"providers:\n  hono:\n    base_url: http://127.0.0.1:{http.server_port}\ncomputer_use:\n  backend: company-cloud\n")
    jar = MozillaCookieJar(str(home / "account-auth-cookies.txt"))
    jar.set_cookie(Cookie(0, "account", "A", None, False, "127.0.0.1", False, False, "/", True, False, None, True, None, None, {}))
    jar.save(ignore_discard=True, ignore_expires=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("HERMES_BOT_BACKEND_URL", raising=False)
    from tools.computer_use import tool
    tool.reset_backend_for_tests()
    yield home, state
    tool.reset_backend_for_tests()
    http.shutdown()
    http.server_close()
    thread.join(timeout=5)


def _tool(args):
    from tools.computer_use_tool import registry
    return registry.dispatch("computer_use", args, session_id="cloud-session")


def test_registry_cloud_capture_and_input_use_hono_cookie_without_touching_local_desktop(cloud_service, monkeypatch, grant_computer_use_approvals):
    from tools.bot_desktop import runtime
    from tools.computer_use import tool
    local = Mock(side_effect=AssertionError("local desktop must not be used"))
    monkeypatch.setattr(runtime, "ensure_started_for_tool", local)
    monkeypatch.setattr(tool, "_should_route_through_aux_vision", lambda: False)
    frame = _tool({"action": "capture", "app": "screen"})
    assert frame["_multimodal"] is True
    result = json.loads(_tool({"action": "click", "coordinate": [10, 20]}))
    assert result["ok"] is True
    request = next(body for path, cookie, body in cloud_service[1]["requests"] if path.endswith("/actions"))
    assert request == {"actor": "agent", "computerGeneration": 1, "leaseEpoch": 1,
                       "action": "click", "params": {"x": 10, "y": 20, "button": "left", "clicks": 1}}
    assert all(cookie == "account=A" for _, cookie, _ in cloud_service[1]["requests"])
    assert json.loads(_tool({"action": "type", "text": "secret", "app": "unselected-app"}))["code"] == "input_target_mismatch"
    local.assert_not_called()


def test_human_lease_and_changed_account_refuse_agent_without_fallback(cloud_service, grant_computer_use_approvals):
    from account_backend_session import advance_account_session_generation
    from tools.computer_use import tool
    backend = tool._get_backend("cloud-session")
    cloud_service[1]["human"] = True
    assert json.loads(_tool({"action": "capture"}))["code"] == "human_has_control"
    assert not any(path.endswith("/capture") for path, _, _ in cloud_service[1]["requests"])
    cloud_service[1]["human"] = False
    advance_account_session_generation()
    with pytest.raises(Exception, match="account session changed"):
        backend.capture()


def test_cloud_target_pins_provider_for_session_before_its_first_action(cloud_service):
    from tools.approval import enable_session_yolo
    from tools.computer_use.session_provider import pin_computer_use_provider, provider_for_session
    home, _ = cloud_service
    pin_computer_use_provider("old")
    (home / "config.yaml").write_text("computer_use:\n  backend: cua\n")
    enable_session_yolo("old")  # replacing a driver's permission mode must not switch its computer
    assert provider_for_session("old").name == "company-cloud"
    assert provider_for_session("new").name == "cua"


def test_cloud_capture_crossing_a_human_takeover_never_reaches_image_history(cloud_service, monkeypatch):
    from tools.computer_use import tool
    cloud_service[1]["takeover_after_capture"] = True
    sink = Mock(side_effect=AssertionError("private frame reached image history"))
    monkeypatch.setattr(tool, "_persist_capture_image", sink)
    reply = json.loads(_tool({"action": "capture"}))
    assert reply["code"] == "human_has_control"
    sink.assert_not_called()


def test_agent_does_not_restart_a_cloud_computer_stopped_by_the_user(cloud_service, grant_computer_use_approvals):
    _, state = cloud_service
    assert json.loads(_tool({"action": "key", "keys": "Tab"}))["ok"] is True
    state["running"] = False
    state["requests"].clear()
    reply = json.loads(_tool({"action": "key", "keys": "Tab"}))
    assert not any(path.endswith(("/start", "/actions", "/capture")) for path, _, _ in state["requests"])
    assert "用户已停止云电脑，请在云电脑页面恢复后重试" in reply["error"]


@pytest.mark.parametrize("args,expected", [
    ({"action": "drag", "from_coordinate": [1, 2], "to_coordinate": [3, 4]},
     {"action": "drag", "params": {"fromX": 1, "fromY": 2, "toX": 3, "toY": 4, "durationMs": 300}}),
    ({"action": "type", "text": "hello 世界"}, {"action": "type", "params": {"text": "hello 世界"}}),
    ({"action": "key", "keys": "ctrl+l"}, {"action": "key", "params": {"keys": ["ctrl", "l"]}}),
    ({"action": "scroll", "direction": "down", "amount": 2}, {"action": "scroll", "params": {"direction": "down", "amount": 2}}),
])
def test_cloud_input_shapes_and_session_close_preserve_account_computer(cloud_service, grant_computer_use_approvals, args, expected):
    from tools.computer_use.tool import release_computer_use_session
    assert json.loads(_tool(args))["ok"] is True
    body = next(payload for path, _, payload in cloud_service[1]["requests"] if path.endswith("/actions"))
    assert {key: body[key] for key in ("action", "params")} == expected
    release_computer_use_session("cloud-session")
    assert not any(path.endswith("/stop") for path, _, _ in cloud_service[1]["requests"])
