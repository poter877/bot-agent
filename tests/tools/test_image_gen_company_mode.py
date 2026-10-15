"""公司模式下图像/视频生成 provider 必须整体不可用：插件持有厂商密钥并直连
厂商端点，走 Hono 之外（doc《流式服务端重构》§6）。注册表返回 None，工具走
既有的"未配置"路径——fail closed，不绕道，直到后端提供图像/视频生成。
"""

from __future__ import annotations

import pytest

from agent.image_gen_registry import get_active_provider


class _FakeProvider:
    name = "fake"

    def is_available(self) -> bool:
        return True


@pytest.fixture
def registered_provider(monkeypatch):
    from agent.image_gen_registry import _registry

    provider = _FakeProvider()
    monkeypatch.setattr(_registry, "_providers", {**_registry.merged(), "fake": provider})
    monkeypatch.setattr("agent.image_gen_registry.configured_provider_name", lambda section, logger: "fake")
    return provider


def test_company_mode_disables_image_gen(registered_provider, monkeypatch):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    assert get_active_provider() is None


def test_without_company_mode_the_provider_serves(registered_provider, monkeypatch):
    from tests.tui_gateway.company_mode import company_mode_off

    company_mode_off(monkeypatch)
    assert get_active_provider() is registered_provider
