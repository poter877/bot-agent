"""First login and restored vendor sessions start on the authenticated directory default."""

import pytest

from account_backend_models import CompanyModelCatalogError
from tests.test_account_backend_models import _profile

pytest_plugins = ["tests.test_account_backend_models"]


def test_startup_migrates_legacy_vendor_picks_but_preserves_company_validation(directory_server, tmp_path):
    from tui_gateway import server

    home = tmp_path / "profile"
    with _profile(home, "A"):
        (home / "config.yaml").write_text("model:\n  provider: openai\n  default: old-vendor-model\n")
        for override in (None, {"model": "old-vendor-model", "provider": "openai",
                                "base_url": "https://vendor.invalid", "api_key": "old-key"}):
            model, runtime = server._resolve_agent_model_runtime(override, None)
            assert model == "alpha"
            assert runtime["provider"] == "hono"
            assert runtime["contextLength"] == 98304
            assert runtime["base_url"] == f"http://127.0.0.1:{directory_server.server_port}"
            assert runtime["api_key"] != "old-key"
        with pytest.raises(CompanyModelCatalogError, match="not available"):
            server._resolve_agent_model_runtime({"model": "unknown-company-alias", "provider": "hono"}, None)


def test_secondary_startup_ignores_launch_model_seed(directory_server, tmp_path, monkeypatch):
    from agent.secret_scope import set_multiplex_active
    from tui_gateway import server

    home = tmp_path / "secondary"
    with _profile(home, "B"):
        (home / "config.yaml").write_text("model:\n  provider: hono\n  default: beta\n")
        (home / ".env").write_text(f"HERMES_BOT_BACKEND_URL=http://127.0.0.1:{directory_server.server_port}\n")
    monkeypatch.setenv("HERMES_TUI_PROVIDER", "hono")
    monkeypatch.setenv("HERMES_MODEL", "launch-only-alias")
    monkeypatch.setenv("HERMES_INFERENCE_MODEL", "another-launch-alias")
    set_multiplex_active(True)
    try:
        with server._session_profile_runtime_scope({"profile_home": str(home)}):
            model, runtime = server._resolve_agent_model_runtime(None, None)
            assert model == "beta"
            assert runtime["provider"] == "hono"
    finally:
        set_multiplex_active(False)
