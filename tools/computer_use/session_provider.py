"""Freeze the chosen driver with each session's tool snapshot, without starting a desktop."""

from contextlib import contextmanager
from contextvars import ContextVar
import threading

from hermes_constants import hermes_home_key

_names: dict[tuple[str, str], str] = {}
_lock = threading.Lock()
_current = ContextVar("computer_use_provider", default=None)


def pin_computer_use_provider(session_id):
    from plugins.computer_use import configured_backend_name

    key = (hermes_home_key(), str(session_id or ""))
    with _lock:
        return _names.setdefault(key, configured_backend_name())


def provider_for_session(session_id):
    from plugins.computer_use import get_active_provider

    return get_active_provider(pin_computer_use_provider(session_id))


def current_provider():
    from plugins.computer_use import get_active_provider

    return _current.get() or get_active_provider()


@contextmanager
def bind_session_provider(session_id):
    token = _current.set(provider_for_session(session_id))
    try:
        yield
    finally:
        _current.reset(token)


def release_session_provider(session_id):
    with _lock:
        _names.pop((hermes_home_key(), str(session_id or "")), None)


def reset_session_providers():
    with _lock:
        _names.clear()
