"""Real Agent construction consumes company capabilities and token limits."""

import pytest

from tests.test_account_backend_models import _profile

pytest_plugins = ["tests.test_account_backend_models"]


@pytest.mark.parametrize(("account", "model", "vision"), [("A", "alpha", True), ("B", "beta", False)])
def test_agent_uses_authoritative_directory_metadata(directory_server, tmp_path, account, model, vision):
    from run_agent import AIAgent

    home = tmp_path / "profile"
    with _profile(home, account):
        (home / "config.yaml").write_text(
            "model:\n  provider: openai\n  default: old-vendor-model\n  context_length: 8192\n")
        agent = AIAgent(
            model=model, provider="hono", enabled_toolsets=["todo"], quiet_mode=True,
            skip_context_files=True, skip_memory=True, save_trajectories=False,
            checkpoints_enabled=False, max_tokens=1000,
        )
        try:
            assert agent.context_compressor.context_length == 98304
            assert agent.max_tokens == 128
            assert agent._model_supports_vision() is vision
            assert agent.tools == []
            assert agent.valid_tool_names == set()
        finally:
            agent.close()
