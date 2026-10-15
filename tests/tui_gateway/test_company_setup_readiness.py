"""A live account with an unavailable model directory keeps company policy on the wire."""

from tests.tui_gateway.test_account_auth_guard import _call, _cookie

pytest_plugins = ["tests.tui_gateway.test_account_auth_guard"]


def test_directory_failure_keeps_managed_readiness(account_service):
    home, _, state, _, _ = account_service
    _cookie(home, "A")
    # The account fixture serves a valid session but no model catalog. The real
    # catalog parser must fail without converting this into vendor onboarding.
    status = _call("setup.status")["result"]
    assert status["managed"] is True
    assert status["inference_provider"] == "hono"
    runtime = _call("setup.runtime_check")["result"]
    assert runtime["managed"] is True
    assert runtime["ok"] is False
    assert runtime["provider"] == "hono"
    assert runtime["error"]
    assert ("/api/llm/models", "account=A") in state["requests"]
