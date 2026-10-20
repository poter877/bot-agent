"""video-studio 产品集成插件 — 挂载在 ``/api/plugins/video-studio/``。

桌面内嵌视频工厂页面的业务通道（《重构》方案 §7）：固定映射到 bot-backend
的业务与账号 API，凭据由本进程（serve）的账号桥按当前 profile 持有，前端
不接触任何服务密钥。

边界（刻意）：
- 只转发 ``/api/v1/...``（视频工厂业务）与 ``/api/auth/...``（会话探测），
  逐前缀白名单，不做前端可指定任意 URL 的通用代理；
- 目标只取配置的 bot-backend（account_backend_session.bot_backend_base）；
- 凭据走 request_account_backend 的既有代际校验——账号切换后晚到响应不会
  落入新账号视图；
- 首期为 JSON GET/POST。上传、图片预览、音视频 Range 播放与下载的流式通道
  在共享账号传输层补齐后接入（方案 §7），不做大文件的 Base64 化。
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request

from account_backend_session import AccountBackendError, request_account_backend

log = logging.getLogger(__name__)

router = APIRouter()

# 业务白名单前缀（相对 /api/）。新增能力时在此扩展，不做通配放行。
_ALLOWED_PREFIXES = ("v1/", "auth/")


@router.api_route("/api/{path:path}", methods=["GET", "POST"])
async def studio_api(path: str, request: Request) -> object:
    if not path.startswith(_ALLOWED_PREFIXES):
        raise HTTPException(status_code=404, detail="video-studio forwards business API paths only")

    payload = None
    if request.method == "POST":
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="JSON body required") from exc

    # 账号桥是同步 urllib 实现；在线程池里跑，不占事件循环。
    try:
        return await asyncio.to_thread(request_account_backend, f"/api/{path}", payload=payload)
    except AccountBackendError as exc:
        status = exc.status_code if isinstance(exc.status_code, int) and 400 <= exc.status_code < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
