"""公司模式 web_search / web_extract 解析链：本地 keyed provider（现状保留）→ 公司工具网关。

Covers (tools/web_tools_company.py + the dispatch branches in tools/web_tools.py):
- 公司模式 + 零本地凭证 → /api/tools/search 与 /api/tools/extract（mock
  request_account_backend），search 映射进 ``{"success": True, "data": {"web": [...]}}``，
  extract 映射进 provider 行形状 ``{"url", "title", "content", "error"}``；
- 公司模式 + 本地 keyed provider → 本地路径照旧，网关不被调用；
- 公司模式硬切本地 DDG（ddgs 解析成功也走网关）、keyless firecrawl 与 keyless
  救场环；
- 非公司模式完全不受影响（无凭证 → 既有 error envelope）；
- 网关失败/坏响应 → search 的 ``{"success": False, "error": ...}`` envelope /
  extract 的逐 URL error 行。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from tools import web_tools
from tools.web_tools_company import (
    TOOLS_EXTRACT_MAX_CHARS_CAP,
    TOOLS_EXTRACT_PATH,
    TOOLS_EXTRACT_TIMEOUT_SECONDS,
    TOOLS_SEARCH_LIMIT_MAX,
    TOOLS_SEARCH_PATH,
    TOOLS_SEARCH_TIMEOUT_SECONDS,
    company_gateway_extract,
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


def _extract_gateway_body(url="https://example.com/page", content="# Page\n\nbody", truncated=False):
    return {"ok": True, "url": url, "format": "markdown", "content": content, "truncated": truncated}


async def _allow_all(url, **kwargs):
    return True


def _company(monkeypatch, enabled=True):
    monkeypatch.setattr(web_tools, "company_mode", lambda: enabled, raising=True)


def _no_website_policy(monkeypatch):
    """Neutralize the local website blocklist so dev-machine config can't leak in."""
    monkeypatch.setattr("tools.website_policy.check_website_access", lambda url, **kw: None, raising=True)


class _FakeProvider:
    """Minimal provider double for the dispatch chain (name/search/extract/is_available)."""

    def __init__(self, name: str, available: bool = True, extract: bool = False):
        self._name = name
        self._available = available
        self._extract = extract
        self.searches: list[tuple[str, int]] = []
        self.extracts: list[list[str]] = []

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
        return self._extract

    def is_keyless_available(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        self.searches.append((query, limit))
        return {"success": True, "data": {"web": [
            {"title": "local hit", "url": "https://local.example", "description": "d", "position": 1}
        ]}}

    async def extract(self, urls: list[str], format: str | None = None, **kwargs: Any) -> list[dict[str, Any]]:
        self.extracts.append(list(urls))
        return [
            {"url": u, "title": "Local page", "content": "local extract body", "error": None,
             "metadata": {"sourceURL": u}}
            for u in urls
        ]


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
            return fake.supports_extract()

        def is_keyless_available(self) -> bool:
            return False

        def search(self, query: str, limit: int = 5) -> dict[str, Any]:
            return fake.search(query, limit)

        async def extract(self, urls: list[str], format: str | None = None, **kwargs: Any) -> list[dict[str, Any]]:
            return await fake.extract(urls, format=format, **kwargs)

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
# 公司模式 → 网关（web_extract）
# ---------------------------------------------------------------------------


class TestCompanyModeExtractThroughGateway:
    @pytest.mark.asyncio
    async def test_maps_gateway_extract_into_result_rows(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        gateway["respond"].append(_extract_gateway_body())
        result = json.loads(await web_tools.web_extract_tool(["https://example.com/page"]))

        assert gateway["calls"], "the company gateway must serve the extract"
        path, payload, timeout = (
            gateway["calls"][0]["path"], gateway["calls"][0]["payload"], gateway["calls"][0]["timeout"]
        )
        assert path == TOOLS_EXTRACT_PATH == "/api/tools/extract"
        # maxChars rides the local char budget (default 15000) so the local
        # truncate-and-store pipeline and the server-side cap share one number.
        assert payload == {"url": "https://example.com/page", "format": "markdown", "maxChars": 15000}
        assert timeout == TOOLS_EXTRACT_TIMEOUT_SECONDS == 25.0

        rows = result["results"]
        assert len(rows) == 1
        assert rows[0]["url"] == "https://example.com/page"
        assert rows[0]["content"] == "# Page\n\nbody"
        assert rows[0]["error"] is None

    @pytest.mark.asyncio
    async def test_multiple_urls_map_in_input_order(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        gateway["respond"].append(_extract_gateway_body(url="https://example.com/a", content="A body"))
        gateway["respond"].append(_extract_gateway_body(url="https://example.com/b", content="B body"))
        result = json.loads(await web_tools.web_extract_tool(["https://example.com/a", "https://example.com/b"]))

        assert [r["url"] for r in result["results"]] == ["https://example.com/a", "https://example.com/b"]
        assert [r["content"] for r in result["results"]] == ["A body", "B body"]

    @pytest.mark.asyncio
    async def test_char_limit_rides_as_maxchars_capped_to_gateway_contract(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        gateway["respond"].append(_extract_gateway_body())
        await web_tools.web_extract_tool(["https://example.com/page"], char_limit=200_000)
        assert gateway["calls"][0]["payload"]["maxChars"] == TOOLS_EXTRACT_MAX_CHARS_CAP == 100_000

    @pytest.mark.asyncio
    async def test_gateway_truncation_marker_survives_without_double_truncation(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        marked = "x" * 90 + "\n\n[... page truncated server-side at 100 chars; raise maxChars ...]"
        gateway["respond"].append(_extract_gateway_body(content=marked, truncated=True))
        result = json.loads(await web_tools.web_extract_tool(["https://example.com/page"], char_limit=2000))

        row = result["results"][0]
        assert row["content"] == marked, "under-budget gateway content must pass through untouched"
        assert "[TRUNCATED]" not in row["content"], "no second, local truncation footer"

    @pytest.mark.asyncio
    async def test_cuts_local_keyless_firecrawl_even_when_it_resolves(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        from plugins.web.firecrawl.provider import FirecrawlWebSearchProvider

        async def _booby_trapped(self, urls, **kwargs):
            raise AssertionError("company mode must never dispatch to local keyless firecrawl")

        monkeypatch.setattr(FirecrawlWebSearchProvider, "extract", _booby_trapped)
        gateway["respond"].append(_extract_gateway_body())
        result = json.loads(await web_tools.web_extract_tool(["https://example.com/page"]))

        assert len(gateway["calls"]) == 1, "keyless extract routes to the company gateway"
        assert result["results"][0]["error"] is None

    @pytest.mark.asyncio
    async def test_website_policy_blocks_before_the_gateway(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        blocked = {
            "url": "https://example.com/page", "host": "example.com", "rule": "example.com",
            "source": "config",
            "message": "Blocked by website policy: 'example.com' matched rule 'example.com' from config",
        }
        monkeypatch.setattr("tools.website_policy.check_website_access", lambda url, **kw: blocked)
        result = json.loads(await web_tools.web_extract_tool(["https://example.com/page"]))

        assert gateway["calls"] == [], "a policy-blocked host never reaches the gateway"
        row = result["results"][0]
        assert row["error"].startswith("Blocked by website policy")
        assert row["blocked_by_policy"]["host"] == "example.com"

    @pytest.mark.asyncio
    async def test_locally_keyed_extract_provider_keeps_priority(self, monkeypatch, gateway, fresh_registry):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        # 显式选中的本地后端 + 本地密钥（现状保留）：网关是第二级，不抢班。
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"extract_backend": "local-fake"})
        provider = _FakeProvider("local-fake", available=True, extract=True)
        _register(_as_registered(provider))
        result = json.loads(await web_tools.web_extract_tool(["https://example.com/local"]))

        assert provider.extracts == [["https://example.com/local"]]
        assert gateway["calls"] == [], "the gateway is rank 2, not a replacement"
        assert result["results"][0]["content"] == "local extract body"


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

    @pytest.mark.asyncio
    async def test_zero_credentials_extract_keeps_the_local_error_envelope(self, monkeypatch, gateway):
        """非公司模式零凭证的 web_extract：默认 firecrawl 后端无钥的真实错误行，
        网关不参与——既有行为不变。"""
        from agent import web_search_registry
        monkeypatch.setattr(web_search_registry, "_keyless_tier_enabled", lambda: False)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)

        result = json.loads(await web_tools.web_extract_tool(["https://example.com/page"]))
        assert gateway["calls"] == [], "no company mode, no gateway"
        row = result["results"][0]
        assert row["error"], row
        assert "FIRECRAWL_API_KEY" in row["error"]


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


class TestGatewayExtractFailureEnvelope:
    @pytest.mark.asyncio
    async def test_backend_error_maps_to_per_url_error_rows(self, monkeypatch, gateway):
        """网关失败不整批炸：web_extract 的契约是逐 URL error 行（模型可对单页换
        browser 工具），错误文案沿用 search envelope 的前缀。"""
        from account_backend_session import AccountBackendError

        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        gateway["respond"].append(AccountBackendError("Account service is unavailable. Please retry.", 503))
        result = json.loads(await web_tools.web_extract_tool(["https://example.com/page"]))

        row = result["results"][0]
        assert row["url"] == "https://example.com/page"
        assert row["content"] == ""
        assert row["error"].startswith("Company extract backend error:")

    @pytest.mark.asyncio
    async def test_malformed_gateway_response_maps_to_error_row(self, monkeypatch, gateway):
        _company(monkeypatch)
        monkeypatch.setattr(web_tools, "async_is_safe_url", _allow_all)
        _no_website_policy(monkeypatch)
        gateway["respond"].append({"ok": True})  # no content key
        rows = await company_gateway_extract(["https://example.com/page"], "markdown", 15000)
        assert rows[0]["error"] == "Company extract backend returned an invalid response."


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

    def test_web_extract_check_fn_lights_up_in_company_mode(self, monkeypatch):
        monkeypatch.setattr(web_tools, "check_web_api_key", lambda: False)
        _company(monkeypatch, enabled=False)
        assert web_tools._web_extract_check() is False
        _company(monkeypatch, enabled=True)
        assert web_tools._web_extract_check() is True
