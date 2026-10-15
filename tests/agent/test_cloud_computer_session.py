"""Agent construction freezes the computer target even before its first computer-use call."""

from types import SimpleNamespace

pytest_plugins = ["tests.tools.test_cloud_computer"]


def test_agent_session_initialization_pins_cloud_provider_before_first_tool(cloud_service):
    from agent.agent_init import _init_session_state
    from tools.computer_use.session_provider import provider_for_session

    home, _ = cloud_service
    agent = SimpleNamespace(valid_tool_names={"computer_use"}, max_iterations=10)
    _init_session_state(agent, "constructed", None, None, None, None, False, 1, 1, 1)
    (home / "config.yaml").write_text("computer_use:\n  backend: cua\n")
    assert provider_for_session(agent.session_id).name == "company-cloud"
    assert provider_for_session("later").name == "cua"
