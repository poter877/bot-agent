"""Company-mode web_search / web_extract routing through the company tool gateway.

公司模式解析链（对齐 ``tools/image_generation_tool.py`` 的 ``_company_mode``
先例——公司配置的运行时从不回落到厂商匿名额度）：

1. 本地已配置密钥的 provider 优先（现状保留，见 :func:`locally_keyed_provider`）；
2. 公司工具网关 ``/api/tools/search`` 与 ``/api/tools/extract``（bot-backend 服务端
   持厂商密钥，经 ``account_backend_session`` 的会话凭证与 X-Correlation-Id 约定）；
3. 本地 keyless / DDG 兜底被硬切——那是非公司模式的本地行为。

search 结果映射进 web_tools 的 SearchResult 形状（``{"success": True, "data": {"web":
[{"title", "url", "description", "position"}]}}``），失败沿用 ``{"success": False,
"error": ...}`` envelope；extract 结果映射进 provider 行形状（``{"url", "title",
"content", "error"}``），失败是逐 URL 错误行（web_extract 的 per-URL 契约）。日志走
tools.web_tools origin。
"""

import asyncio
import logging
from typing import Optional

logger = logging.getLogger("tools.web_tools")

TOOLS_SEARCH_PATH = "/api/tools/search"
TOOLS_SEARCH_TIMEOUT_SECONDS = 20.0
# /api/tools/search 的 limit 契约是 1..10（默认 5）；网关对该区间之外直接 400。
TOOLS_SEARCH_LIMIT_MAX = 10

TOOLS_EXTRACT_PATH = "/api/tools/extract"
# 网关侧 extract 出站 20s + 处理余量 = /api/tools 树的 25s scoped 预算；客户端
# 超时对齐该树预算，慢页让网关的 502/超时先浮出而不是本地抢跑。
TOOLS_EXTRACT_TIMEOUT_SECONDS = 25.0
# 网关 maxChars 契约上限（默认 20000）；本地 char_limit 高于它时按它截断。
TOOLS_EXTRACT_MAX_CHARS_CAP = 100_000


def company_mode() -> bool:
    """公司模式判定：与 image/tts/video 工具同一入口（``company_backend_enabled``）。"""
    from account_backend_session import company_backend_enabled

    return company_backend_enabled()


def locally_keyed_provider(provider) -> bool:
    """True 当 *provider* 会以本地已配置的凭证服务本次 search/extract 调用（公司模式链的第 1 级）。

    keyless 路径永远不算：ddgs 天生无钥；环内厂商（exa/parallel/firecrawl/keenable）
    仅 keyed 模式算数——公司模式把所有厂商匿名额度兜底换成公司工具网关。
    """
    from tools.web_tools import _probe

    if provider is None:
        return False
    name = str(getattr(provider, "name", "") or "")
    if name == "ddgs":
        return False
    if name in ("exa", "parallel", "firecrawl", "keenable"):
        from tools.web_tools_rescue import _ring_vendor_keyless

        if _ring_vendor_keyless(name):
            return False
    return _probe(provider, "is_available", " during company-mode chain check") is True


def _normalize_gateway_results(result: object) -> Optional[list[dict]]:
    """``{ok, results: [{title, url, snippet}]}`` → title-first 行；None 当响应形状不对。"""
    if not isinstance(result, dict) or not isinstance(result.get("results"), list):
        return None
    rows = []
    for position, entry in enumerate(result["results"], start=1):
        if not isinstance(entry, dict):
            return None
        rows.append({
            "title": str(entry.get("title", "")),
            "url": str(entry.get("url", "")),
            "description": str(entry.get("snippet", "")),
            "position": position,
        })
    return rows


def company_gateway_search(query: str, limit: int) -> dict:
    """经公司工具网关搜索（服务端持厂商密钥，客户端零密钥）。

    Returns web_tools 的 SearchResult 形状；网关/凭证失败返回
    ``{"success": False, "error": ...}``（web_tools 的 error envelope），不抛。
    """
    from account_backend_session import AccountBackendError, request_account_backend

    try:
        bounded_limit = min(max(int(limit), 1), TOOLS_SEARCH_LIMIT_MAX)
    except (TypeError, ValueError):
        bounded_limit = 5
    try:
        result = request_account_backend(
            TOOLS_SEARCH_PATH,
            payload={"query": query, "limit": bounded_limit},
            timeout=TOOLS_SEARCH_TIMEOUT_SECONDS,
        )
    except AccountBackendError as exc:
        logger.warning("company tool gateway search failed: %s", exc)
        return {"success": False, "error": f"Company search backend error: {exc}"}
    rows = _normalize_gateway_results(result)
    if rows is None:
        logger.warning("company tool gateway returned an invalid response")
        return {"success": False, "error": "Company search backend returned an invalid response."}
    logger.info("Company gateway search '%s': %d results (limit %d)", query, len(rows), bounded_limit)
    return {"success": True, "data": {"web": rows}}


def _extract_error_entry(url: str, error: str, **extra) -> dict:
    return {"url": url, "title": "", "content": "", "error": error, **extra}


def _normalize_gateway_extract(url: str, result: object) -> Optional[dict]:
    """网关 ``{ok, url, format, content, truncated}`` → provider 行形状；None 当响应形状不对。"""
    if not isinstance(result, dict) or not isinstance(result.get("content"), str):
        return None
    return {
        "url": str(result.get("url") or url),
        "title": "",
        "content": result["content"],
        "error": None,
        "metadata": {"sourceURL": url, **({"truncated": True} if result.get("truncated") else {})},
    }


async def company_gateway_extract(
    urls: list[str], format: Optional[str] = None, max_chars: Optional[int] = None,
) -> list[dict]:
    """经公司工具网关抽取（服务端持厂商密钥，客户端零密钥；每 URL 一次调用）。

    本地 ``security.website_blocklist`` 照常生效（网关看不到本地策略，本地
    URL 工具都不该绕过它）。返回与 ``urls`` 等长同序的 provider 行；失败是
    逐 URL 的 ``error`` 行（web_extract 的 per-URL 契约），不整批失败。网关
    结果不进本地磁盘缓存：记账在公司侧。
    """
    from account_backend_session import AccountBackendError, request_account_backend
    from tools.website_policy import check_website_access

    payload_format = format if format in ("markdown", "html") else "markdown"

    def _fetch_one(url: str) -> dict:
        if blocked := check_website_access(url):
            logger.info("Blocked company-gateway extract %s — website policy", url)
            return _extract_error_entry(
                url, blocked["message"],
                blocked_by_policy={k: blocked[k] for k in ("host", "rule", "source")},
            )
        payload = {"url": url, "format": payload_format}
        if max_chars:
            payload["maxChars"] = min(int(max_chars), TOOLS_EXTRACT_MAX_CHARS_CAP)
        result = request_account_backend(TOOLS_EXTRACT_PATH, payload=payload, timeout=TOOLS_EXTRACT_TIMEOUT_SECONDS)
        entry = _normalize_gateway_extract(url, result)
        if entry is None:
            logger.warning("company tool gateway returned an invalid extract response for %s", url)
            return _extract_error_entry(url, "Company extract backend returned an invalid response.")
        return entry

    async def _guarded(url: str) -> dict:
        try:
            return await asyncio.to_thread(_fetch_one, url)
        except AccountBackendError as exc:
            logger.warning("company tool gateway extract failed for %s: %s", url, exc)
            return _extract_error_entry(url, f"Company extract backend error: {exc}")

    # 逐 URL 顺序抽取（与本地 firecrawl provider 的 per-URL 循环同款），保证
    # 结果顺序即入参顺序，也不并发打满网关的每用户限流。
    entries = [await _guarded(url) for url in urls]
    logger.info("Company gateway extract: %d URL(s) (format %s)", len(urls), payload_format)
    return entries
