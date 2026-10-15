"""Company account admission for every local business RPC, under its owning profile."""

from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger(__name__)

from account_backend_session import (
    AccountBackendError, AccountSessionBinding, account_session_fingerprint, account_session_lock,
    bind_account_request_authority, bot_backend_base, capture_account_session, company_backend_enabled,
)
from hermes_constants import hermes_home_key

_AUTH_METHODS = frozenset({
    "accountAuth.status", "accountAuth.signIn", "accountAuth.signUp", "accountAuth.signOut",
})
_UNAUTHENTICATED_METHODS = _AUTH_METHODS | {"client.capabilities"}
_READINESS_METHODS = frozenset({"setup.status", "setup.runtime_check"})
# Only known read-only polling surfaces may reuse a recent authoritative check.
# Mutations, task starts, and future methods always ask the server afresh.
_CACHED_READ_METHODS = frozenset({
    "ping", "gateway.capabilities", "config.get", "model.options", "setup.status", "setup.runtime_check",
    "session.list", "session.active_list", "session.status", "session.history", "session.usage",
    "session.context_breakdown", "session.control.read", "session.events.since", "session.events.stats",
    "profiles.list", "profiles.describe", "subagent.list", "subagent.tail", "mcp.servers.status",
    "display.status", "display.thumbnail", "process.list", "projects.tree",
    "cloudComputer.status", "cloudComputer.capture",
})
_VALIDATED_SECONDS = 2.0
_validated: dict[tuple[str, str, str], float] = {}
_cache_lock = threading.Lock()


def clear_account_auth_cache() -> None:
    """Credential loss and identity changes immediately retire this profile's admission."""
    home = hermes_home_key()
    with _cache_lock:
        for key in list(_validated):
            if key[0] == home:
                del _validated[key]


def _scope_params(method: str, params: dict) -> dict:
    """Best-effort session/profile refinement for the policy lookup: it must
    never raise anything but ProfileUnavailableError — test doubles, exotic
    params objects and profile-home races fall through to the plain params and
    the normal scoped worker path."""
    from tui_gateway import server

    if not isinstance(params, dict):
        return params
    try:
        owner = params.get("owner")
        scoped = params
        if method in server._CONNECTOR_RPC_METHODS and isinstance(owner, dict) and owner.get("type") == "session":
            scoped = {**params, "session_id": owner.get("session_id")}
        session = server._sessions.get(str(scoped.get("session_id") or ""))
        if isinstance(session, dict) and str(scoped.get("profile") or "").strip():
            requested = server._profile_home(scoped["profile"]) or server._launch_home()
            actual = session.get("profile_home") or server._launch_home()
            if hermes_home_key(requested) != hermes_home_key(actual):
                raise server.ProfileUnavailableError("The session belongs to a different profile.")
        return scoped
    except server.ProfileUnavailableError:
        raise
    except Exception:
        # Deliberate catch-all: the refinement is advisory, and a scrape that
        # raced a concurrent _sessions mutation must not fail the RPC.
        logger.debug("account guard scope refinement fell back to plain params", exc_info=True)
        return params


def requires_account_worker(method: str, params: dict) -> bool:
    """Policy lookup performs no HTTP; account network exchanges belong to the RPC pool."""
    from tui_gateway import server

    if method in _AUTH_METHODS:
        return True
    if method == "client.capabilities":
        return False
    try:
        scoped = _scope_params(method, params)
        return server._profile_scoped(lambda _rid, _params: company_backend_enabled())(None, scoped)
    except server.ProfileUnavailableError:
        # The normal worker path produces the typed 4064 response.
        return True


def _verify_account(method: str) -> AccountSessionBinding:
    from tui_gateway import server
    from tui_gateway.account_auth_lifecycle import invalidate_account_session

    with account_session_lock():
        try:
            _verify_account_locked(method)
            return capture_account_session()[1]
        except server._AuthRejected as error:
            failure = AccountBackendError(str(error), error.status_code)
        except AccountBackendError as error:
            failure = error
        except (OSError, ValueError) as error:
            failure = AccountBackendError("Account service is unavailable. Please retry.")
            failure.__cause__ = error
        rejected = failure.status_code in {401, 403}
        # Invalidate before releasing the credential lock: a concurrent new login must
        # never be cleared by the previous account's delayed failure callback.
        invalidate_account_session("expired" if rejected else "unavailable", clear_cookie=rejected)
        raise failure


def _verify_account_locked(method: str) -> None:
    from tui_gateway import server

    key = (hermes_home_key(), bot_backend_base(), account_session_fingerprint())
    with _cache_lock:
        deadline = _validated.get(key, 0)
    if method in _CACHED_READ_METHODS and time.monotonic() < deadline:
        return
    status = server._status()
    if not status.get("authenticated") or not status.get("user"):
        raise AccountBackendError("Sign in to continue.", 401)
    # Better Auth may rotate its cookie while checking; cache only the returned credential.
    key = (hermes_home_key(), bot_backend_base(), account_session_fingerprint())
    clear_account_auth_cache()
    with _cache_lock:
        _validated[key] = time.monotonic() + _VALIDATED_SECONDS


def invoke_account_guarded(method: str, handler, rid, params: dict):
    from tui_gateway import server

    if method in _UNAUTHENTICATED_METHODS:
        return handler(rid, params)

    def invoke(_rid, _params):
        if company_backend_enabled():
            try:
                binding = _verify_account(method)
            except AccountBackendError as error:
                rejected = error.status_code in {401, 403}
                return server._err(rid, 5060 if rejected else 5061, str(error),
                                   data={"reason": "account_required" if rejected else "account_unavailable"})
            with bind_account_request_authority(binding):
                return handler(rid, params)
        # Never hold the credential lock while a business handler waits on a tool or stream.
        return handler(rid, params)

    try:
        return server._profile_scoped(invoke)(rid, _scope_params(method, params))
    except server.ProfileUnavailableError:
        if method not in _READINESS_METHODS:
            raise
        # Readiness has an established failure result for a deleted profile. Return it
        # without running its probe or silently validating the launch profile instead.
        profile = params.get("profile")
        return server._ok(rid, {"ok": False, "profile": profile,
                                "error": f"Profile '{profile}' does not exist on this backend."})
