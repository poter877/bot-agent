"""``accountAuth.*``: Better Auth bridged over the local gateway (doc《后端服务》§6/§7).

The agent subprocess is the ONLY backend client — the desktop never talks to bot-backend
directly. Better Auth session cookies live in this process's jar, persisted under the
profile home so a restart restores the session (doc《用户认证》§2 重新打开应用); only the
verified profile crosses the wire back to the desktop. ``HERMES_BOT_BACKEND_URL`` selects
the backend; unconfigured or unreachable means the desktop gate stays on its
"authentication service unavailable" state — never a simulated login. Bodies are rebound
onto server.py's globals (method_ctx.bind_module) and reference them bare.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from http.cookiejar import MozillaCookieJar

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped

_REQUEST_TIMEOUT_SECONDS = 10.0
_COOKIE_FILE_NAME = "account-auth-cookies.txt"


class _AuthRejected(Exception):
    """The backend answered and rejected the credentials/operation."""


def _backend_base() -> str:
    base = os.environ.get("HERMES_BOT_BACKEND_URL", "").strip().rstrip("/")
    if not base:
        raise RuntimeError("account backend is not configured (HERMES_BOT_BACKEND_URL)")
    return base


def _load_jar() -> MozillaCookieJar:
    # Profile-scoped call: get_hermes_home() resolves the live profile here.
    import hermes_constants
    from pathlib import Path

    jar = MozillaCookieJar(str(Path(hermes_constants.get_hermes_home()) / _COOKIE_FILE_NAME))
    if Path(jar.filename).exists():
        jar.load(ignore_discard=True, ignore_expires=True)
    return jar


def _backend_request(path: str, *, payload: dict | None = None) -> dict | None:
    """One Better Auth exchange with the profile cookie jar; cookies persist on success.

    ``Origin`` is the backend's own URL: the library's CSRF check rejects cookie-authed
    mutations from a client that sends no origin (this is a first-party server-side client).
    """
    base = _backend_base()
    jar = _load_jar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        base + path,
        data=body,
        method="POST" if payload is not None else "GET",
        headers={"Content-Type": "application/json", "Accept": "application/json", "Origin": base},
    )
    try:
        with opener.open(req, timeout=_REQUEST_TIMEOUT_SECONDS) as resp:
            result = json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            body = json.loads(e.read() or b"{}")
            detail = str((body or {}).get("message") or "")
        except Exception:
            detail = ""
        raise _AuthRejected(detail or f"HTTP {e.code}") from None
    jar.save(ignore_discard=True, ignore_expires=True)
    return result


def _user_payload(user: dict | None) -> dict | None:
    if not isinstance(user, dict) or not user.get("id"):
        return None
    return {
        "id": str(user.get("id") or ""),
        "email": str(user.get("email") or ""),
        "name": str(user.get("name") or ""),
    }


def _status() -> dict:
    session = _backend_request("/api/auth/get-session")
    user = session.get("user") if isinstance(session, dict) else None
    payload = _user_payload(user)
    return {"authenticated": payload is not None, "user": payload, "error": None}


@method("accountAuth.status")
@_profile_scoped
def _(rid, params: dict) -> dict:
    try:
        return _ok(rid, _status())
    except _AuthRejected as e:
        return _ok(rid, {"authenticated": False, "user": None, "error": str(e)})
    except Exception as e:
        return _err(rid, 5061, str(e))


@method("accountAuth.signIn")
@_profile_scoped
def _(rid, params: dict) -> dict:
    try:
        _backend_request("/api/auth/sign-in/email",
                         payload={"email": params["email"], "password": params["password"]})
        # Doc《用户认证》§2: re-confirm the established session authoritatively
        # before reporting success.
        return _ok(rid, _status())
    except _AuthRejected as e:
        return _ok(rid, {"authenticated": False, "user": None, "error": str(e)})
    except Exception as e:
        return _err(rid, 5061, str(e))


@method("accountAuth.signUp")
@_profile_scoped
def _(rid, params: dict) -> dict:
    try:
        _backend_request("/api/auth/sign-up/email",
                         payload={"name": params["name"], "email": params["email"],
                                  "password": params["password"]})
        return _ok(rid, _status())
    except _AuthRejected as e:
        return _ok(rid, {"authenticated": False, "user": None, "error": str(e)})
    except Exception as e:
        return _err(rid, 5061, str(e))


@method("accountAuth.signOut")
@_profile_scoped
def _(rid, params: dict) -> dict:
    try:
        _backend_request("/api/auth/sign-out", payload={})
        return _ok(rid, {"ok": True})
    except Exception as e:
        return _err(rid, 5061, str(e))


def register(server) -> None:
    from .method_ctx import bind_module

    bind_module(globals(), server, skip=("_",))
