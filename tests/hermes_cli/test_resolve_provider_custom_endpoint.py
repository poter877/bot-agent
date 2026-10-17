"""A configured custom (OpenAI-compatible) endpoint is explicit provider intent.

Regression for #108383: ``resolve_provider("auto")`` recognised only registry providers from
``model.provider``, so a llama.cpp / vLLM / ollama install read as "nothing configured" and
``setup.status`` reported ``provider_configured: False`` — the dashboard's Ink chat parked
every new session on "Setup Required" while ``hermes chat`` (which resolves the runtime
directly) worked against the same config.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    (home / ".env").write_text("", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    for var in ("OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL",
                "OPENROUTER_BASE_URL", "HERMES_INFERENCE_PROVIDER"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("agent.bedrock_adapter.has_aws_credentials", lambda *_a, **_kw: False)
    return home


@pytest.mark.parametrize(
    ("model_block", "expected"),
    [
        pytest.param(
            "model:\n  default: nvidia/Nemotron\n  provider: custom\n"
            "  base_url: http://127.0.0.1:8000/v1\n  api_key: dummy\n",
            "custom",
            id="provider-custom",
        ),
        pytest.param(
            "model:\n  default: qwen3\n  provider: vllm\n  base_url: http://127.0.0.1:8000/v1\n",
            "custom",
            id="local-server-alias",
        ),
        pytest.param(
            "model:\n  default: qwen3\n  base_url: http://localhost:8080/v1\n",
            "custom",
            id="loopback-base-url-only",
        ),
        # #109397: ``model.provider: openrouter`` is explicit intent like a registry pin, not
        # "nothing configured" (both ``custom`` and ``openrouter`` are absent from PROVIDER_REGISTRY).
        pytest.param(
            "model:\n  default: openrouter/auto\n  provider: openrouter\n",
            "openrouter",
            id="provider-openrouter",
        ),
        # A non-openrouter ``base_url`` under the openrouter pin is a deliberate mirror (#10622).
        pytest.param(
            "model:\n  default: openrouter/auto\n  provider: openrouter\n"
            "  base_url: https://openrouter-mirror.example.com/api/v1\n",
            "openrouter",
            id="provider-openrouter-mirror",
        ),
        # A bare ``model.provider`` naming a ``providers:`` entry is explicit intent too:
        # has_named_custom_provider() already routes it at runtime (``hermes chat`` works), so the
        # boot inventory must not discard the bare name.
        pytest.param(
            "model:\n  default: test-model\n  provider: CPA\n\n"
            "providers:\n  CPA:\n    api: http://127.0.0.1:8317/v1\n    default_model: test-model\n",
            "custom",
            id="named-providers-pin",
        ),
    ],
)
def test_configured_custom_endpoint_resolves_as_a_provider(isolated_home, model_block, expected):
    (isolated_home / "config.yaml").write_text(model_block, encoding="utf-8")
    from hermes_cli.auth import resolve_provider

    assert resolve_provider("auto") == expected


def test_stale_remote_base_url_without_a_custom_pin_is_not_a_provider(isolated_home):
    """The URL rung follows the runtime's own trust rule: a non-loopback ``base_url`` left behind
    under a bare (unpinned) provider is not custom intent (#14676), so a blank machine still reads
    as unconfigured. (A ``provider: openrouter`` pin is excluded from this guard — a non-openrouter
    ``base_url`` under it is a deliberate mirror/proxy, #10622/#109397.)"""
    (isolated_home / "config.yaml").write_text(
        "model:\n  default: some/model\n  base_url: https://api.z.ai/v1\n",
        encoding="utf-8",
    )
    from hermes_cli.auth import AuthError, resolve_provider

    with pytest.raises(AuthError):
        resolve_provider("auto")


def test_auto_provider_with_loopback_base_url_resolves_without_recursing(isolated_home, monkeypatch):
    """A fresh setup keeps ``provider: auto`` until the picker stores its choice (#110926)."""
    (isolated_home / "config.yaml").write_text(
        "model:\n  provider: auto\n  base_url: http://127.0.0.1:8000/v1\n",
        encoding="utf-8",
    )
    from hermes_cli import runtime_provider
    from hermes_cli.auth import resolve_provider

    def unexpected_provider_resolution(_name):
        raise AssertionError("the bare custom trust check must not resolve model.provider=auto")

    monkeypatch.setattr(runtime_provider, "_resolves_to_custom", unexpected_provider_resolution)

    assert resolve_provider("auto") == "custom"
