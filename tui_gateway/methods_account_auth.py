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

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped

_REQUEST_TIMEOUT_SECONDS = 10.0


class _AuthRejected(Exception):
    """The backend answered and rejected the credentials/operation."""

    def __init__(self, message: str, status_code: int = 401):
        super().__init__(message)
        self.status_code = status_code


def _backend_request(path: str, *, payload: dict | None = None) -> dict | None:
    from account_backend_session import AccountBackendError, request_account_backend

    try:
        return request_account_backend(path, payload=payload, timeout=_REQUEST_TIMEOUT_SECONDS)
    except AccountBackendError as error:
        if error.status_code is not None and 400 <= error.status_code < 500:
            raise _AuthRejected(str(error), error.status_code) from error
        raise


def _user_payload(user: dict | None) -> dict | None:
    if not isinstance(user, dict) or not user.get("id"):
        return None
    return {
        "id": str(user.get("id") or ""),
        "email": str(user.get("email") or ""),
        "name": str(user.get("name") or ""),
    }


def _status() -> dict:
    from account_backend_session import account_session_lock
    from tui_gateway.account_auth_lifecycle import invalidate_account_session, remember_account_transport

    remember_account_transport()
    with account_session_lock():
        try:
            session = _backend_request("/api/auth/get-session")
        except _AuthRejected as error:
            rejected = error.status_code in {401, 403}
            invalidate_account_session("expired" if rejected else "unavailable", clear_cookie=rejected)
            raise
        except Exception:
            invalidate_account_session("unavailable", clear_cookie=False)
            raise
        user = session.get("user") if isinstance(session, dict) else None
        payload = _user_payload(user)
        if payload is None:
            invalidate_account_session("expired")
        return {"authenticated": payload is not None, "user": payload, "error": None}


def _authenticate_account(path: str, payload: dict) -> dict:
    from account_backend_session import account_session_lock
    from tui_gateway.account_auth_lifecycle import prepare_account_sign_in

    with account_session_lock():
        prepare_account_sign_in()
        _backend_request(path, payload=payload)
        return _status()


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
        return _ok(rid, _authenticate_account("/api/auth/sign-in/email",
                   {"email": params["email"], "password": params["password"]}))
    except _AuthRejected as e:
        return _ok(rid, {"authenticated": False, "user": None, "error": str(e)})
    except Exception as e:
        return _err(rid, 5061, str(e))


@method("accountAuth.signUp")
@_profile_scoped
def _(rid, params: dict) -> dict:
    try:
        return _ok(rid, _authenticate_account("/api/auth/sign-up/email",
                   {"name": params["name"], "email": params["email"], "password": params["password"]}))
    except _AuthRejected as e:
        return _ok(rid, {"authenticated": False, "user": None, "error": str(e)})
    except Exception as e:
        return _err(rid, 5061, str(e))


@method("accountAuth.signOut")
@_profile_scoped
def _(rid, params: dict) -> dict:
    from account_backend_session import account_auth_cookie_path, account_session_lock
    from tui_gateway.account_auth_lifecycle import invalidate_account_session

    with account_session_lock():
        # Stop local work before waiting on the remote revocation request. Keep the
        # cookie only for that request; the lock excludes concurrent login/status.
        invalidate_account_session("signed_out", clear_cookie=False)
        try:
            _backend_request("/api/auth/sign-out", payload={})
        except Exception:
            # Offline revocation cannot retain local access or the local session secret.
            logger.debug("Remote account sign-out unavailable; clearing local authority", exc_info=True)
        finally:
            account_auth_cookie_path().unlink(missing_ok=True)
    return _ok(rid, {"ok": True})


def register(server) -> None:
    from .method_ctx import bind_module

    bind_module(globals(), server, skip=("_",))
