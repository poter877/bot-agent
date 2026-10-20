"""CompanyAuthProvider — delegate dashboard auth to the company account backend (bot-backend).

Single sign-on across the trio: the account store is bot-backend's Better Auth
(PostgreSQL; managed from the ops console at /console). ai-drama already authenticates
against it directly; this provider gives the hermes dashboard the same identity source.

Login is a credential form (``supports_password``): ``complete_password_login`` posts to
``HERMES_BOT_BACKEND_URL/api/auth/sign-in/email``, captures the Better Auth session
cookie pair, and re-signs it as the dashboard's HMAC session (framework-standard —
same shape as BasicAuthProvider). ``verify_session`` validates the stored Better Auth
cookie against ``/api/auth/get-session`` with a 60s cache; a revoked/disabled account
fails closed everywhere at once.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from typing import Optional

import httpx

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider, InvalidCredentialsError, ProviderError, RefreshExpiredError, Session,
)
from plugins.dashboard_auth._shared import (
    NonInteractiveMixin, SkipRegistration, load_config_section, register_provider, resolve_env_or_cfg,
)

logger = logging.getLogger(__name__)
_TAG = "dashboard-auth-company"

# Better Auth cookie names (httpOnly pair set by /api/auth/sign-in/email).
_COOKIE_PAIR = ("better-auth.session_token", "better-auth.session_data")
# verify_session cache: an authenticated page fires many requests; the account
# backend is authoritative but should not be on the hot path.
_VERIFY_CACHE_TTL = 60.0
_HTTP_TIMEOUT = 10.0

_DEFAULT_TTL_SECONDS = 12 * 60 * 60
_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60


class _Verified:
    """Cache entry for a verified Better Auth cookie (until TS)."""

    __slots__ = ("user_id", "email", "name", "until")

    def __init__(self, user_id: str, email: str, name: str) -> None:
        self.user_id = user_id
        self.email = email
        self.name = name
        self.until = time.monotonic() + _VERIFY_CACHE_TTL


class CompanyAuthProvider(NonInteractiveMixin, DashboardAuthProvider):
    name = "company"
    display_name = "公司账号"
    supports_password = True
    supports_token = False
    supports_session = True

    def __init__(self, *, base_url: str, internal_token: str = "", secret: str,
                 session_ttl: int = _DEFAULT_TTL_SECONDS) -> None:
        if not base_url.rstrip("/"):
            raise ValueError("company provider needs HERMES_BOT_BACKEND_URL")
        self._base = base_url.rstrip("/")
        # Optional service token for bot-backend routes that gate non-browser callers.
        self._internal_token = internal_token
        self._secret = secret.encode()
        self._ttl = session_ttl
        # cookie-string -> _Verified; bounded by the account count, cleared wholesale at 2k.
        self._verified: dict[str, _Verified] = {}

    # ---- framework password login ----

    def complete_password_login(self, *, username: str, password: str) -> Session:
        headers = {"Content-Type": "application/json"}
        if self._internal_token:
            headers["Authorization"] = f"Bearer {self._internal_token}"
        try:
            resp = httpx.post(
                f"{self._base}/api/auth/sign-in/email",
                json={"email": username, "password": password},
                headers=headers,
                timeout=_HTTP_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"company backend unreachable: {exc}") from exc
        if resp.status_code in (401, 400):
            raise InvalidCredentialsError("invalid company credentials")
        if resp.status_code >= 500:
            raise ProviderError(f"company backend error {resp.status_code}")
        # Better Auth error envelope is JSON; anything else here is unexpected.
        try:
            body = resp.json()
        except ValueError as exc:
            raise ProviderError("company backend returned a non-JSON body") from exc
        user = (body or {}).get("user") or {}
        if not user.get("id") or not user.get("email"):
            raise ProviderError("company backend response missing user")
        cookie = _serialize_cookie_pair(resp.headers.get_list("set-cookie"))
        if not cookie:
            raise ProviderError("company backend did not set a session cookie")
        self._verified[cookie] = _Verified(str(user["id"]), str(user["email"]), str(user.get("name") or ""))
        return _mint_session(
            secret=self._secret, ttl=self._ttl, refresh_ttl=_REFRESH_TTL_SECONDS,
            user_id=str(user["id"]), email=str(user["email"]),
            display_name=str(user.get("name") or str(user["email"])), cookie=cookie,
        )

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        payload = _open_session(access_token, self._secret)
        if payload is None:
            return None
        cached = self._verified.get(payload["c"])
        if cached and time.monotonic() < cached.until:
            user_id, email, name = cached.user_id, cached.email, cached.name
        else:
            headers = {"Cookie": payload["c"]}
            if self._internal_token:
                headers["Authorization"] = f"Bearer {self._internal_token}"
            try:
                resp = httpx.get(f"{self._base}/api/auth/get-session", headers=headers, timeout=_HTTP_TIMEOUT)
            except httpx.HTTPError as exc:
                raise ProviderError(f"company backend unreachable: {exc}") from exc
            if resp.status_code in (401, 403):
                # Revoked / signed out / disabled account: fail closed, drop cache.
                self._verified.pop(payload["c"], None)
                return None
            if resp.status_code >= 500:
                raise ProviderError(f"company backend error {resp.status_code}")
            user = (resp.json() or {}).get("user") or {}
            if not user.get("id"):
                self._verified.pop(payload["c"], None)
                return None
            user_id, email = str(user["id"]), str(user.get("email") or payload["e"])
            name = str(user.get("name") or email)
            self._verified[payload["c"]] = _Verified(user_id, email, name)
            if len(self._verified) > 2000:
                self._verified.clear()
        return Session(
            user_id=user_id, email=email, display_name=name, org_id="",
            provider=self.name, expires_at=payload["x"],
            access_token=access_token, refresh_token=payload.get("r", ""),
        )

    def refresh_session(self, *, refresh_token: str) -> Session:
        payload = _open_session(refresh_token, self._secret)
        if payload is None:
            raise RefreshExpiredError()
        # The backing Better Auth cookie's lifetime is the account backend's call;
        # the dashboard refresh just re-validates it and re-mints.
        session = self.verify_session(access_token=payload["a"])
        if session is None:
            raise RefreshExpiredError()
        return _mint_session(
            secret=self._secret, ttl=self._tl, refresh_ttl=_REFRESH_TTL_SECONDS,
            user_id=session.user_id, email=session.email,
            display_name=session.display_name, cookie=payload["c"],
        )

    def revoke_session(self, *, refresh_token: str) -> None:
        payload = _open_session(refresh_token, self._secret)
        if payload is None:
            return
        self._verified.pop(payload["c"], None)
        # Best-effort sign-out at the account backend; never raises.
        try:
            httpx.post(f"{self._base}/api/auth/sign-out",
                       headers={"Cookie": payload["c"]}, timeout=_HTTP_TIMEOUT)
        except httpx.HTTPError:
            pass


# ---- stateless token helpers (same construction as BasicAuthProvider) ----

_ACCESS_TAG = b"hermes-dash-company-access"
_REFRESH_TAG = b"hermes-dash-company-refresh"








def _b64(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    import base64
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _encode(tag: bytes, secret: bytes, payload: dict) -> str:
    body = _b64(__import__("json").dumps(payload, separators=(",", ":")).encode())
    mac = _b64(hmac.new(secret, tag + body.encode(), hashlib.sha256).digest())
    return f"{body}.{mac}"


def _decode(tag: bytes, secret: bytes, token: str) -> Optional[dict]:
    body, _, mac = token.partition(".")
    if not body or not mac:
        return None
    expect = _b64(hmac.new(secret, tag + body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(mac.encode(), expect.encode()):
        return None
    try:
        payload = __import__("json").loads(_unb64(body))
    except ValueError:
        return None
    if not isinstance(payload, dict) or int(payload.get("x", 0)) < time.time():
        return None
    return payload


def _serialize_cookie_pair(set_cookies: list) -> str:
    parts = []
    for header in set_cookies:
        name, _, rest = header.partition("=")
        if name in _COOKIE_PAIR:
            parts.append(f"{name}={rest.split(';', 1)[0]}")
    return "; ".join(parts)


def _mint_session(*, secret: bytes, ttl: int, refresh_ttl: int, user_id: str, email: str,
                  display_name: str, cookie: str) -> Session:
    now = int(time.time())
    access = _encode(_ACCESS_TAG, secret, {"u": user_id, "e": email, "x": now + ttl, "c": cookie})
    refresh = _encode(_REFRESH_TAG, secret, {"x": now + refresh_ttl, "a": access, "c": cookie})
    return Session(
        user_id=user_id, email=email, display_name=display_name, org_id="",
        provider="company", expires_at=now + ttl,
        access_token=access, refresh_token=refresh,
    )


def _open_session(token: str, secret: bytes) -> Optional[dict]:
    payload = _decode(_ACCESS_TAG, secret, token)
    if payload is not None:
        return payload
    # refresh tokens carry the access token under "a"
    outer = _decode(_REFRESH_TAG, secret, token)
    if outer is not None and isinstance(outer.get("a"), str):
        inner = _decode(_ACCESS_TAG, secret, outer["a"])
        if inner is not None:
            return inner
        return outer
    return None


# ---- registration ----

def register(ctx) -> None:
    global LAST_SKIP_REASON
    LAST_SKIP_REASON = ""
    section = load_config_section(logger, _TAG, "dashboard", "company_auth")
    base_url = resolve_env_or_cfg("HERMES_BOT_BACKEND_URL", section.get("base_url"))
    if not base_url:
        LAST_SKIP_REASON = "HERMES_BOT_BACKEND_URL not configured"
        return
    internal_token = resolve_env_or_cfg("HERMES_BOT_BACKEND_SERVICE_TOKEN", section.get("internal_token"))
    secret = resolve_env_or_cfg("HERMES_DASHBOARD_COMPANY_SECRET", section.get("secret"))
    if not secret:
        # Derive from the gateway api key when no dedicated secret: same trust domain.
        secret = resolve_env_or_cfg("API_SERVER_KEY", "")
    if not secret:
        LAST_SKIP_REASON = "no secret (set HERMES_DASHBOARD_COMPANY_SECRET)"
        return
    ttl = int(section.get("session_ttl_seconds") or _DEFAULT_TTL_SECONDS)
    # register_provider 接受 settings 工厂（返回 kwargs dict），不是直接的关键字参数
    kwargs, LAST_SKIP_REASON = register_provider(
        ctx, logger, _TAG, CompanyAuthProvider,
        lambda: {"base_url": base_url, "internal_token": internal_token, "secret": secret, "session_ttl": ttl},
    )
    if kwargs is not None:
        logger.info("%s: registered company provider (base=%s)", _TAG, base_url)


LAST_SKIP_REASON = ""
