"""Cloud desktop RPCs authenticate the owning profile and only expose human viewer operations."""

import pytest

pytest_plugins = ["tests.tools.test_cloud_computer"]


@pytest.fixture
def rpc_cloud(cloud_service, monkeypatch):
    from agent import secret_scope
    from tui_gateway import launch_profile_policy, server
    home, state = cloud_service
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_served_profile_homes", set())
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", False)
    monkeypatch.setattr(launch_profile_policy, "_snapshot", None)
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    return home, state


def _call(name, params=None):
    from tui_gateway import server
    return server.handle_request({"id": "cloud", "method": "cloudComputer." + name, "params": params or {}})


def test_cloud_viewer_rpc_forces_human_and_keeps_lease_token_out_of_status(rpc_cloud):
    _, state = rpc_cloud
    status = _call("status")["result"]
    assert status["agentEnabled"] is True
    assert "viewerToken" not in status
    capture = {"computerGeneration": 1, "leaseEpoch": 1}
    assert _call("capture", capture)["result"]["image"]["mediaType"] == "image/png"
    acquired = _call("lease.acquire")["result"]
    action = {"computerGeneration": 1, "leaseEpoch": acquired["lease"]["epoch"],
              "viewerToken": acquired["viewerToken"], "action": "type", "params": {"text": "hello"}}
    assert _call("action", action)["result"]["ok"] is True
    payload = next(body for path, _, body in state["requests"] if path.endswith("/actions"))
    assert payload["actor"] == "human" and payload["viewerToken"] == acquired["viewerToken"]
    assert _call("action", {**action, "actor": "agent"})["error"]["code"] == 4000
    assert _call("lease.release", {"viewerToken": acquired["viewerToken"]})["result"]["lease"]["holder"] == "agent"


def test_cloud_rpc_exposes_conflict_without_retry_and_rejects_invalid_action(rpc_cloud):
    _, state = rpc_cloud
    state["epoch"] = 4
    reply = _call("capture", {"computerGeneration": 1, "leaseEpoch": 1})
    assert reply["error"]["data"]["httpStatus"] == 409
    assert sum(path.endswith("/capture") for path, _, _ in state["requests"]) == 1
    reply = _call("action", {"computerGeneration": 1, "leaseEpoch": 4, "viewerToken": "token",
                             "action": "type", "params": {"x": 1, "y": 2}})
    assert reply["error"]["code"] == 4000
    assert not any(path.endswith("/actions") for path, _, _ in state["requests"])


def test_configuration_only_changes_new_session_provider_and_profile_has_own_login(rpc_cloud):
    from tools.computer_use.session_provider import pin_computer_use_provider, provider_for_session
    home, state = rpc_cloud
    pin_computer_use_provider("existing")
    assert _call("configure", {"enabled": False})["result"] == {"enabled": False, "appliesTo": "new-sessions"}
    assert _call("status")["result"]["agentEnabled"] is False
    assert provider_for_session("existing").name == "company-cloud"
    assert provider_for_session("new").name == "cua"
    secondary = home / "profiles" / "secondary"
    secondary.mkdir(parents=True)
    (secondary / "config.yaml").write_text((home / "config.yaml").read_text())
    count = sum(path.endswith("/status") for path, _, _ in state["requests"])
    assert _call("status", {"profile": "secondary"})["error"]["code"] == 5060
    assert sum(path.endswith("/status") for path, _, _ in state["requests"]) == count
