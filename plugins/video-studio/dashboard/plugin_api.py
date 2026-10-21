"""video-studio 产品集成插件 — 挂载在 ``/api/plugins/video-studio/``。

桌面内嵌视频工厂页面的业务通道（《重构》方案 §7）：固定映射到 bot-backend
的业务与账号 API，凭据由本进程（serve）的账号桥按当前 profile 持有，前端
不接触任何服务密钥。

三条通道：
- ``/api/{path}``     JSON 业务/账号 API（白名单前缀 v1/、auth/）
- ``/media/{path}``   媒体流（/static/...）：Range/HEAD 透传，用于视频拖动播放、
                      图片与下载；凭据同账号桥，前端用 query token 访问
                      （媒体标签带不了 header——白名单见 web_server._QUERY_TOKEN_API_PREFIXES）
- ``/upload/v1/{path}`` 上传：multipart 原样转发（Content-Type/boundary 保持），
                      上限 100 MiB——大文件全程 HTTP，不做 Base64 化
- ``/mcp``            MCP 账号桥：转发 MCP JSON-RPC 到 bot-backend /mcp，凭据
                      按当前 profile（hermes 侧 MCP 客户端的动态装配见方案 P2）

通用代理是刻意禁止的：目标只取配置的 bot-backend，路径只走固定映射。
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from account_backend_session import AccountBackendError, open_account_backend_stream, request_account_backend

log = logging.getLogger(__name__)

router = APIRouter()

# 业务白名单前缀（相对 /api/）。新增能力时在此扩展，不做通配放行。
_ALLOWED_PREFIXES = ("v1/", "auth/")
_UPLOAD_MAX_BYTES = 100 * 1024 * 1024
_MEDIA_READ_CHUNK = 64 * 1024


def _error_response(exc: AccountBackendError) -> HTTPException:
    status = exc.status_code if isinstance(exc.status_code, int) and 400 <= exc.status_code < 600 else 502
    return HTTPException(status_code=status, detail=str(exc))


# ── 会话前装配（《重构》方案 §7）─────────────────────────────────────────────
# hermes 的 MCP 客户端按 config.yaml 的 mcp_servers 装配（新会话生效，配置
# 每次现读）。插件的 MCP 桥地址含 serve 的动态端口，因此在首个请求时把
# 「当前端口 + 本进程会话令牌」写进 profile 配置与技能目录——幂等，端口
# 变化（serve 重启）时覆写。凭据不出本机：令牌是 serve 自己的会话令牌。

_ASSEMBLY_DONE_URL: str | None = None
MCP_SERVER_NAME = "ai_drama"


def _ensure_studio_assembly(base_url: str) -> None:
    global _ASSEMBLY_DONE_URL
    bridge_url = f"{base_url}/api/plugins/video-studio/mcp"
    if _ASSEMBLY_DONE_URL == bridge_url:
        return

    from hermes_cli import web_server

    entry = {
        "url": bridge_url,
        "headers": {"Authorization": f"Bearer {web_server._SESSION_TOKEN}"},
    }
    try:
        from hermes_cli.config import load_config
        from hermes_cli.mcp_config import _save_mcp_server

        current = (load_config().get("mcp_servers") or {}).get(MCP_SERVER_NAME)
        if current != entry:
            _save_mcp_server(MCP_SERVER_NAME, entry)
            log.info("video-studio: assembled mcp_servers.%s -> %s", MCP_SERVER_NAME, bridge_url)
    except Exception:
        log.warning("video-studio: MCP assembly failed", exc_info=True)
        return  # 下个请求重试

    _install_product_skill()
    _ASSEMBLY_DONE_URL = bridge_url


def _install_product_skill() -> None:
    """把随插件分发的产品技能放进当前 profile 的 skills/（存在即跳过——
    用户可自行修改，升级由部署另行管理）。"""
    try:
        from hermes_constants import get_hermes_home

        src = Path(__file__).resolve().parent.parent / "skills" / "video-studio"
        dst = Path(get_hermes_home()) / "skills" / "video-studio"
        if not src.is_dir() or (dst / "SKILL.md").exists():
            return
        shutil.copytree(src, dst)
        log.info("video-studio: installed product skill at %s", dst)
    except Exception:
        log.warning("video-studio: skill install failed", exc_info=True)


def _request_base(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.api_route("/api/{path:path}", methods=["GET", "POST", "PUT"])
async def studio_api(path: str, request: Request) -> object:
    _ensure_studio_assembly(_request_base(request))
    if not path.startswith(_ALLOWED_PREFIXES):
        raise HTTPException(status_code=404, detail="video-studio forwards business API paths only")

    payload = None
    if request.method in ("POST", "PUT"):
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="JSON body required") from exc

    # query 随转发（FastAPI 的 {path:path} 不含 query string，须显式拼回；
    # 工具目录的模式收敛等过滤参数曾在此丢失）
    forwarded = f"/api/{path}" + (f"?{request.url.query}" if request.url.query else "")

    # 账号桥是同步 urllib 实现；在线程池里跑，不占事件循环。
    try:
        return await asyncio.to_thread(
            request_account_backend, forwarded, payload=payload, method=request.method
        )
    except AccountBackendError as exc:
        raise _error_response(exc) from exc


# 媒体响应头透传白名单（其余头属于 bot-backend 的传输细节，不外泄）
_MEDIA_PASSTHROUGH_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control")


@router.api_route("/media/{path:path}", methods=["GET", "HEAD"])
async def studio_media(path: str, request: Request) -> StreamingResponse:
    forward_headers: dict[str, str] = {}
    if rng := request.headers.get("range"):
        forward_headers["Range"] = rng
    if request.method == "HEAD":
        forward_headers["Accept-Encoding"] = "identity"

    def _open():
        return open_account_backend_stream(f"/static/{path}", method=request.method, headers=forward_headers or None, timeout=120.0)

    try:
        upstream = await asyncio.to_thread(_open)
    except AccountBackendError as exc:
        raise _error_response(exc) from exc

    status = getattr(upstream, "status", 200) or 200
    headers = {k: v for k, v in upstream.headers.items() if k.lower() in _MEDIA_PASSTHROUGH_HEADERS}

    if request.method == "HEAD":
        await asyncio.to_thread(upstream.close)
        return StreamingResponse(iter(()), status_code=status, headers=headers)

    def _chunks():
        try:
            while True:
                chunk = upstream.read(_MEDIA_READ_CHUNK)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    # 同步生成器由 starlette 放进线程池执行；Range 状态（206）原样透传。
    return StreamingResponse(_chunks(), status_code=status, headers=headers)


@router.post("/upload/v1/{path:path}")
async def studio_upload(path: str, request: Request) -> object:
    body = await request.body()
    if len(body) > _UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="upload exceeds the 100 MiB budget")
    content_type = request.headers.get("content-type")
    if not content_type or "multipart/form-data" not in content_type:
        raise HTTPException(status_code=415, detail="multipart/form-data body required")

    def _forward() -> object:
        # boundary 在 Content-Type 里，原样透传即保持 multipart 结构
        resp = open_account_backend_stream(
            f"/api/v1/{path}", method="POST", headers={"Content-Type": content_type}, body=body, timeout=180.0)
        with resp:
            return json.loads(resp.read() or b"null")

    try:
        return await asyncio.to_thread(_forward)
    except AccountBackendError as exc:
        raise _error_response(exc) from exc


@router.post("/mcp")
async def studio_mcp_bridge(request: Request) -> object:
    """MCP 账号桥：同一 serve 内的 hermes MCP 客户端经此访问 bot-backend 的
    领域工具，凭据按当前 profile（用户身份），而非静态共享令牌。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="JSON-RPC body required") from exc

    def _forward() -> bytes:
        resp = open_account_backend_stream(
            "/mcp", method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
            body=json.dumps(payload).encode(), timeout=60.0)
        with resp:
            return resp.read()

    try:
        raw = await asyncio.to_thread(_forward)
    except AccountBackendError as exc:
        raise _error_response(exc) from exc

    # streamable HTTP 的应答可能是 JSON 或 SSE 文本；插件不解释协议，按原始字节转发
    try:
        return json.loads(raw or b"null")
    except ValueError:
        return StreamingResponse(iter([raw]), media_type="text/event-stream")
