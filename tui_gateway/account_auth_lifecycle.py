"""Retire one profile's live account authority without deleting its working data."""

from __future__ import annotations

import logging
import sys
import threading

from account_backend_session import account_auth_cookie_path, account_session_lock
from hermes_constants import hermes_home_key

logger = logging.getLogger(__name__)
_transports: dict[str, set] = {}
_transports_lock = threading.Lock()


def remember_account_transport() -> None:
    """The early login socket owns no chat session, so remember its profile explicitly."""
    from tui_gateway import server
    from tui_gateway.transport import current_transport

    transport = current_transport()
    if transport is not None:
        with server._live_transports_lock:
            live = server._live_transports | {transport}
        with _transports_lock:
            for peers in _transports.values():
                peers.intersection_update(live)
            _transports.setdefault(hermes_home_key(), set()).add(transport)


def _retire_profile_sessions() -> list:
    from tui_gateway import server
    from agent.memory_provider import spawn_context_thread

    home = hermes_home_key()
    targets = []
    retired = []
    with server._session_resume_lock, server._sessions_lock:
        for sid, session in list(server._sessions.items()):
            if hermes_home_key(session.get("profile_home") or server._hermes_home) != home:
                continue
            if (transport := session.get("transport")) is not None:
                targets.append(transport)
            retired.append((sid, server._pop_session_by_id(sid)))
    for sid, session in retired:
        try:
            server._interrupt_session_turn(sid, session, request_id=f"account-invalidated-{sid}")
        except Exception:
            logger.exception("Failed to interrupt session during account invalidation")
        # Authentication can fail inside the turn's own model request. Never join that
        # worker while holding the account lock or from the worker itself.
        spawn_context_thread(
            server._teardown_popped_session, name="account-session-close",
            args=(session,), kwargs={"end_reason": "account_invalidated"},
        ).start()
    return targets


def _retire_profile_clients() -> None:
    auxiliary = sys.modules.get("agent.auxiliary_client")
    if auxiliary is None:
        return
    home = hermes_home_key()
    with auxiliary._client_cache_lock:
        retired = [auxiliary._client_cache.pop(key)[0]
                   for key in list(auxiliary._client_cache) if key[0] == home]
    for client in retired:
        auxiliary._close_cached_client(client)


def _retire_account_runtime(*, clear_cookie: bool) -> list:
    from account_backend_session import advance_account_session_generation
    from tui_gateway.account_auth_guard import clear_account_auth_cache

    advance_account_session_generation()
    clear_account_auth_cache()
    if clear_cookie:
        account_auth_cookie_path().unlink(missing_ok=True)
    targets = _retire_profile_sessions()
    _retire_profile_clients()
    return targets


def prepare_account_sign_in() -> None:
    """A newly authenticated identity must never inherit a previous cookie-bearing client."""
    remember_account_transport()
    with account_session_lock():
        _retire_account_runtime(clear_cookie=True)


def invalidate_account_session(reason: str, *, clear_cookie: bool = True) -> None:
    """Revoke current-profile runtime access and notify only that profile's clients."""
    from tui_gateway import server
    from tui_gateway.transport import current_transport

    with account_session_lock():
        targets = _retire_account_runtime(clear_cookie=clear_cookie)
        with _transports_lock:
            targets.extend(_transports.get(hermes_home_key(), ()))
        if (transport := current_transport()) is not None:
            targets.append(transport)
        frame = server._event_frame("accountAuth.invalidated", "", {"reason": reason})
        for transport in set(targets):
            try:
                transport.write(frame)
            except Exception:
                logger.debug("Account invalidation peer disconnected", exc_info=True)
