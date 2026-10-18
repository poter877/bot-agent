"""公司模式 web_search 解析链：本地 keyed provider（现状保留）→ 公司工具网关。

Covers (tools/web_tools_company.py + the dispatch branch in tools/web_tools.py):
- 公司模式 + 零本地凭证 → /api/tools/search（mock request_account_backend），
  结果映射进 ``{"success": True, "data": {"web": [title-first rows]}}``；
- 公司模式 + 本地 keyed provider → 本地路径照旧，网关不被调用；
- 公司模式硬切本地 DDG（ddgs 解析成功也走网关）与 keyless 救场环；
- 非公司模式完全不受影响（无凭证 → 既有 error envelope）；
- 网关失败/坏响应 → web_tools 的 ``{"success": False, "error": ...}`` envelope。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from tools import web_tools
from tools.web_tools_company import (
    TOOLS_SEARCH_LIMIT_MAX,
    TOOLS_SEARCH_PATH,
    TOOLS_SEARCH_TIMEOUT_SECONDS,
    company_gateway_search,
    locally_keyed_provider,
)


@pytest.fixture(autouse=True)
def _no_web_env(monkeypatch):
    """Blank every web credential and neutralize config lookups (dev-machine .env included)."""
    for var in (
        "EXA_API_KEY", "PARALLEL_API_KEY", "KEENABLE_API_KEY", "TAVILY_API_KEY",
        "PERPLEXITY_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL",
        "BRAVE_SEARCH_API_KEY", "SEARXNG_URL", "HERMES_DESKTOP", "HERMES_BOT_BACKEND_URL",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(
        "agent.web_search_provider.get_provider_env", lambda name: "", raising=True
    )
    monkeypatch.setattr(
        "hermes_cli.config.get_env_value", lambda name: None, raising=True
    )
    monkeypatch.setattr(web_tools, "_env_value", lambda name: "", raising=True)
    monkeypatch.setattr(web_tools, "_load_web_config", dict, raising=True)
    monkeypatch.setattr(web_tools, "_ddgs_package_importable", lambda: False, raising=True)
    from tools.web_result_cache import search_memo
    search_memo.clear()
    yield
    search_memo.clear()


@pytest.fixture()
def gateway(monkeypatch):
    """Mock the company-backend HTTP seam; records (path, payload, timeout) per call."""
    import account_backend_session

    calls: list[dict[str, Any]] = []
    responder: list[Any] = []

    def fake_request(path, *, payload=None, timeout=10.0):
        calls.append({"path": path, "payload": payload, "timeout": timeout})
        if responder:
            outcome = responder.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        return _gateway_body()

    monkeypatch.setattr(account_backend_session, "request_account_backend", fake_request)
    return {"calls": calls, "respond": responder}


def _gateway_body(rows=None):
    rows = rows if rows is not None else [
        {"title": "First hit", "url": "https://example.com/1", "snippet": "snippet one"},
        {"title": "Second hit", "url": "https://example.com/2", "snippet": "snippet two"},
    ]
    return {"ok": True, "provider": "tavily-main", "results": rows}


def _company(monkeypatch, enabled=True):
    monkeypatch.setattr(web_tools, "company_mode", lambda: enabled, raising=True)


class _FakeProvider:
    """Minimal provider double for the dispatch chain (name/search/is_available)."""

    def __init__(self, name: str, available: bool = True):
        self._name = name
        self._available = available
        self.searches: list[tuple[str, int]] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def display_name(self) -> str:
        return self._name

    def is_available(self) -> bool:
        return self._available

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def is_keyless_available(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        self.searches.append((query, limit))
        return {"success": True, "data": {"web": [
            {"title": "local hit", "url": "https://local.example", "description": "d", "position": 1}
        ]}}


def _as_registered(fake: _FakeProvider):
    """Adapt the double onto the registry's ABC (duck-typed delegation)."""
    from agent.web_search_provider import WebSearchProvider

    class _RegisteredFake(WebSearchProvider):
        @property
        def name(self) -> str:
            return fake.name

        @property
        def display_name(self) -> str:
            return fake.display_name

        def is_available(self) -> bool:
            return fake.is_available()

        def supports_search(self) -> bool:
            return True

        def supports_extract(self) -> bool:
            return False

        def is_keyless_available(self) -> bool:
            return False

        def search(self, query: str, limit: int = 5) -> dict[str, Any]:
            return fake.search(query, limit)

    return _RegisteredFake()


def _register(provider) -> None:
    from agent.web_search_registry import register_provider
    register_provider(provider)


@pytest.fixture()
def fresh_registry():
    from agent import web_search_registry as registry

    with registry._lock:
        saved = dict(registry._providers)
        registry._providers.clear()
    yield registry
    with registry._lock:
        registry._providers.clear()
        registry._providers.update(saved)


# ---------------------------------------------------------------------------
# 公司模式 → 网关
# ---------------------------------------------------------------------------


class TestCompanyModeRoutesThroughGateway:
    def test_maps_gateway_results_into_search_shape(self, monkeypatch, gateway):
        _company(monkeypatch)
        result = json.loads(web_tools.web_search_tool("hello world", limit=2))

        assert gateway["calls"], "the company gateway must serve the search"
        path, payload, timeout = (
            gateway["calls"][0]["path"], gateway["calls"][0]["payload"], gateway["calls"][0]["timeout"]
        )
        assert path == TOOLS_SEARCH_PATH == "/api/tools/search"
        assert payload == {"query": "hello world", "limit": 2}
        assert timeout == TOOLS_SEARCH_TIMEOUT_SECONDS == 20.0

        assert result["success"] is True
        assert result["data"]["web"] == [
            {"title": "First hit", "url": "https://example.com/1", "description": "snippet one", "position": 1},
            {"title": "Second hit", "url": "https://example.com/2", "description": "snippet two", "position": 2},
        ]

    def test_clamps_limit_to_the_gateway_contract(self, monkeypatch, gateway):
        _company(monkeypatch)
        web_tools.web_search_tool("wide query", limit=50)
        assert gateway["calls"][0]["payload"]["limit"] == TOOLS_SEARCH_LIMIT_MAX == 10

    def test_cuts_local_ddg_even_when_it_resolves(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "_ddgs_package_importable", lambda: True)

        from plugins.web.ddgs.provider import DDGSWebSearchProvider

        def _booby_trapped(self, query, limit=5):
            raise AssertionError("company mode must never dispatch to local ddgs")

        monkeypatch.setattr(DDGSWebSearchProvider, "search", _booby_trapped)
        result = json.loads(web_tools.web_search_tool("hello", limit=1))
        assert result["success"] is True
        assert len(gateway["calls"]) == 1

    def test_locally_keyed_provider_keeps_priority(self, monkeypatch, gateway, fresh_registry):
        _company(monkeypatch)
        # 显式选中的本地后端 + 本地密钥（现状保留）：网关是第二级，不抢班。
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"search_backend": "local-fake"})
        provider = _FakeProvider("local-fake", available=True)
        _register(_as_registered(provider))
        result = json.loads(web_tools.web_search_tool("local first", limit=1))

        assert provider.searches and provider.searches[0][0] == "local first"
        assert gateway["calls"] == [], "the gateway is rank 2, not a replacement"
        assert result["data"]["web"][0]["title"] == "local hit"


# ---------------------------------------------------------------------------
# 非公司模式不受影响
# ---------------------------------------------------------------------------


class TestNonCompanyModeUnchanged:
    def test_zero_credentials_keeps_the_local_error_envelope(self, monkeypatch, gateway):
        """非公司模式零凭证：落到默认 firecrawl 后端的真实错误（keyless 环已禁用），
        网关不参与——与非公司模式的既有行为完全一致。"""
        from agent import web_search_registry
        monkeypatch.setattr(web_search_registry, "_keyless_tier_enabled", lambda: False)

        result = json.loads(web_tools.web_search_tool("hello world", limit=3))
        assert gateway["calls"] == [], "no company mode, no gateway"
        assert "error" in result, result
        assert "Error searching web:" in result["error"]


# ---------------------------------------------------------------------------
# 网关失败面
# ---------------------------------------------------------------------------


class TestGatewayFailureEnvelope:
    def test_backend_error_maps_to_error_envelope(self, monkeypatch, gateway):
        from account_backend_session import AccountBackendError

        _company(monkeypatch)
        gateway["respond"].append(AccountBackendError("Account service is unavailable. Please retry.", 503))
        result = json.loads(web_tools.web_search_tool("hello", limit=1))

        assert result["success"] is False
        assert result["error"].startswith("Company search backend error:")

    def test_malformed_gateway_response_maps_to_error_envelope(self, monkeypatch, gateway):
        _company(monkeypatch)
        gateway["respond"].append({"ok": True})  # no results[] key
        result = company_gateway_search("hello", 1)
        assert result == {"success": False, "error": "Company search backend returned an invalid response."}


# ---------------------------------------------------------------------------
# 链的判定单元
# ---------------------------------------------------------------------------


class TestChainPredicates:
    def test_locally_keyed_provider_ranks(self, monkeypatch):
        assert locally_keyed_provider(None) is False
        assert locally_keyed_provider(_FakeProvider("ddgs")) is False  # keyless by design
        assert locally_keyed_provider(_FakeProvider("tavily", available=False)) is False
        assert locally_keyed_provider(_FakeProvider("tavily")) is True

    def test_ring_vendor_counts_only_in_keyed_mode(self, monkeypatch):
        keyed = _FakeProvider("exa")
        monkeypatch.setattr("tools.web_tools_rescue._ring_vendor_keyless", lambda name: False)
        assert locally_keyed_provider(keyed) is True
        monkeypatch.setattr("tools.web_tools_rescue._ring_vendor_keyless", lambda name: True)
        assert locally_keyed_provider(keyed) is False

    def test_keyless_rescue_is_cut_in_company_mode(self, monkeypatch):
        from tools.web_tools_rescue import _rescue_eligible

        provider = _FakeProvider("tavily")
        _company(monkeypatch, enabled=False)
        assert _rescue_eligible(provider) is True
        _company(monkeypatch, enabled=True)
        assert _rescue_eligible(provider) is False

    def test_web_search_check_fn_lights_up_in_company_mode(self, monkeypatch):
        monkeypatch.setattr(web_tools, "check_web_api_key", lambda: False)
        _company(monkeypatch, enabled=False)
        assert web_tools._web_search_check() is False
        _company(monkeypatch, enabled=True)
        assert web_tools._web_search_check() is True
