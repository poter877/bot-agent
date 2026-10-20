"""CompanyAuthProvider 单元测试 — Better Auth 对接契约。

不发真实网络：httpx 打桩。锁定四个行为：
1. 密码登录成功 → 铸 HMAC session（含 Better Auth cookie 载荷）
2. 错误凭据 → InvalidCredentialsError（不泄露细节）
3. verify_session：get-session 200/user → Session；401 → None（fail-closed）
4. 注册门槛：无 HERMES_BOT_BACKEND_URL 跳过、无 secret 跳过
"""
from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from plugins.dashboard_auth.company import CompanyAuthProvider, register


class _StubTransport(httpx.BaseTransport):
    def __init__(self, *, sign_in: int = 200, session: int = 200, user: dict | None = None) -> None:
        self.sign_in_status = sign_in
        self.session_status = session
        self.user = user or {"id": "u1", "email": "ops@test.local", "name": "Ops"}
        self.calls: list[str] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.path)
        if request.url.path == "/api/auth/sign-in/email":
            if self.sign_in_status >= 500:
                return httpx.Response(self.sign_in_status, json={"error": "boom"})
            if self.sign_in_status in (400, 401):
                return httpx.Response(self.sign_in_status, json={"code": self.sign_in_status, "message": "Invalid"})
            return httpx.Response(200, json={"user": self.user}, headers={
                "set-cookie": "better-auth.session_token=tok; Path=/; HttpOnly",
            })
        if request.url.path == "/api/auth/get-session":
            if self.session_status == 401:
                return httpx.Response(401, json={"user": None})
            return httpx.Response(200, json={"user": self.user})
        raise AssertionError(f"unexpected path {request.url.path}")


def _provider(transport: _StubTransport) -> tuple[CompanyAuthProvider, Any]:
    prov = CompanyAuthProvider(base_url="http://stub", secret="test-secret-at-least")
    import plugins.dashboard_auth.company as mod
    orig = httpx.post, httpx.get
    def post(url, **kw):
        req = httpx.Request("POST", url, json=kw.get("json"), headers=kw.get("headers") or {})
        resp = transport.handle_request(req)
        return resp
    def get(url, **kw):
        req = httpx.Request("GET", url, headers=kw.get("headers") or {})
        return transport.handle_request(req)
    httpx.post, httpx.get = post, get
    return prov, orig


def test_password_login_mints_session():
    transport = _StubTransport()
    prov, orig = _provider(transport)
    try:
        session = prov.complete_password_login(username="ops@test.local", password="pw")
        assert session.user_id == "u1"
        assert session.email == "ops@test.local"
        assert session.provider == "company"
        assert session.expires_at > time.time()
    finally:
        import plugins.dashboard_auth.company as mod
        import httpx as _h
        _h.post, _h.get = orig


def test_invalid_credentials():
    transport = _StubTransport(sign_in=401)
    prov, orig = _provider(transport)
    try:
        with pytest.raises(Exception):
            prov.complete_password_login(username="x@t.local", password="bad")
    finally:
        import httpx as _h
        _h.post, _h.get = orig


def test_verify_session_ok_then_revoked():
    transport = _StubTransport()
    prov, orig = _provider(transport)
    try:
        session = prov.complete_password_login(username="ops@test.local", password="pw")
        verified = prov.verify_session(access_token=session.access_token)
        assert verified is not None and verified.email == "ops@test.local"
        transport.session_status = 401
        prov._verified.clear()  # 绕过 60s 正缓存，直查后端
        assert prov.verify_session(access_token=session.access_token) is None
    finally:
        import httpx as _h
        _h.post, _h.get = orig


def test_register_skips_without_url(monkeypatch):
    monkeypatch.delenv("HERMES_BOT_BACKEND_URL", raising=False)
    register(_Ctx())
    # no exception; skipped silently


class _Ctx:
    def register_dashboard_auth_provider(self, *a, **k):  # pragma: no cover
        raise AssertionError("should not register")
