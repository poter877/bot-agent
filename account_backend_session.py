"""Shared Better Auth session state for the company bot-backend (doc《用户认证》§2).

The agent subprocess is the ONLY backend client (doc《后端服务》§6): both the
tui_gateway accountAuth bridge and the Hono model stream client ride the same
profile-scoped cookie jar, persisted under the profile home so a restart
restores the session. ``HERMES_BOT_BACKEND_URL`` selects the backend.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from urllib.parse import urlsplit

ACCOUNT_AUTH_COOKIE_FILE = "account-auth-cookies.txt"
_ACCOUNT_LOCKS: dict[str, threading.RLock] = {}
_ACCOUNT_LOCKS_LOCK = threading.Lock()
_ACCOUNT_GENERATIONS: dict[str, tuple[int, threading.Event]] = {}

# X-Correlation-Id contract shared by ai-drama → gateway api_server → company
# backend: ≤128 chars of [A-Za-z0-9._:-], caller-chosen, recorded verbatim.
CORRELATION_ID_HEADER = "X-Correlation-Id"
_CORRELATION_ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}")


def sanitize_correlation_id(raw: object) -> str | None:
    """Return the header value when it fits the wire contract, else None."""
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    return value if _CORRELATION_ID_RE.fullmatch(value) else None


_REQUEST_CORRELATION_ID: ContextVar[str | None] = ContextVar(
    "request_correlation_id", default=None)


def current_request_correlation_id() -> str | None:
    """The inbound request's sanitized correlation id, when this context serves one."""
    return _REQUEST_CORRELATION_ID.get()


@contextmanager
def request_correlation_scope(correlation_id: str | None):
    """Bind the request correlation id for the duration of an inbound request.

    The gateway api_server sets this per handled request; outbound company-backend
    calls (model stream + account backend HTTP) copy it into the
    ``X-Correlation-Id`` header so bot-backend journals can be joined back to the
    originating turn. ContextVar semantics keep concurrent requests isolated."""
    token = _REQUEST_CORRELATION_ID.set(correlation_id)
    try:
        yield
    finally:
        _REQUEST_CORRELATION_ID.reset(token)


class AccountBackendError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class AccountSessionBinding:
    profile: str
    base_url: str
    fingerprint: str
    revoked: threading.Event


_ACCOUNT_REQUEST_AUTHORITY: ContextVar[AccountSessionBinding | None] = ContextVar(
    "account_request_authority", default=None,
)


def current_account_request_authority() -> AccountSessionBinding | None:
    return _ACCOUNT_REQUEST_AUTHORITY.get()


@contextmanager
def bind_account_request_authority(binding: AccountSessionBinding):
    """Retain admission identity across business handlers and context-copied workers."""
    token = _ACCOUNT_REQUEST_AUTHORITY.set(binding)
    try:
        yield
    finally:
        _ACCOUNT_REQUEST_AUTHORITY.reset(token)


def _account_config() -> dict:
    from hermes_cli.config import load_config_readonly

    return load_config_readonly()


def _configured_backend(config: dict | None = None) -> str:
    from agent.secret_scope import get_secret

    configured = (get_secret("HERMES_BOT_BACKEND_URL") or "").strip()
    if configured:
        return configured.rstrip("/")
    providers = (config if config is not None else _account_config()).get("providers") or {}
    return str((providers.get("hono") or {}).get("base_url") or "").strip().rstrip("/")


def company_backend_enabled(*, config: dict | None = None) -> bool:
    """Desktop and company-configured runtimes never fall back to vendor credentials."""
    from agent.secret_scope import get_secret
    if os.environ.get("HERMES_DESKTOP") == "1" or get_secret("HERMES_BOT_BACKEND_URL"):
        return True
    config = config if config is not None else _account_config()
    if _configured_backend(config):
        return True
    model = config.get("model") or {}
    return isinstance(model, dict) and model.get("provider") in {"hono", "bot-backend", "company-backend"}


def bot_backend_base() -> str:
    """Resolve the owning profile's endpoint; missing configuration fails closed."""
    base = _configured_backend()
    if not base:
        raise AccountBackendError("Account backend is not configured. Set providers.hono.base_url.")
    parsed = urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise AccountBackendError("Account backend must be an HTTP(S) URL without credentials.")
    return base


def account_auth_cookie_path() -> Path:
    # Profile-scoped call: get_hermes_home() resolves the live profile here.
    import hermes_constants

    return Path(hermes_constants.get_hermes_home()) / ACCOUNT_AUTH_COOKIE_FILE


def load_account_auth_jar() -> MozillaCookieJar:
    jar = MozillaCookieJar(str(account_auth_cookie_path()))
    if Path(jar.filename).exists():
        jar.load(ignore_discard=True, ignore_expires=True)
    return jar


def account_session_lock():
    key = str(account_auth_cookie_path().resolve())
    with _ACCOUNT_LOCKS_LOCK:
        return _ACCOUNT_LOCKS.setdefault(key, threading.RLock())


def save_account_auth_jar(jar: MozillaCookieJar) -> None:
    """Replace credentials atomically with owner-only permissions."""
    with account_session_lock():
        _save_account_auth_jar(jar)


def _save_account_auth_jar(jar: MozillaCookieJar) -> None:
    path = account_auth_cookie_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".account-auth-", dir=path.parent)
    os.close(descriptor)
    try:
        jar.save(temporary, ignore_discard=True, ignore_expires=True)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _session_fingerprint(jar: MozillaCookieJar) -> str:
    profile = str(account_auth_cookie_path().resolve())
    generation, _ = _ACCOUNT_GENERATIONS.setdefault(profile, (0, threading.Event()))
    cookies = sorted((cookie.domain, cookie.path, cookie.name, cookie.value)
                     for cookie in jar)
    return hashlib.sha256(json.dumps((profile, generation, cookies)).encode()).hexdigest()


def account_session_fingerprint() -> str:
    with account_session_lock():
        return _session_fingerprint(load_account_auth_jar())


def capture_account_session() -> tuple[MozillaCookieJar, AccountSessionBinding]:
    """One atomic cookie/identity snapshot; never fingerprint a second jar read."""
    with account_session_lock():
        jar = load_account_auth_jar()
        profile = str(account_auth_cookie_path().resolve())
        fingerprint = _session_fingerprint(jar)
        return jar, AccountSessionBinding(profile, bot_backend_base(), fingerprint, _ACCOUNT_GENERATIONS[profile][1])


def advance_account_session_generation() -> None:
    """Revoke retained clients even when an offline status check keeps the cookie."""
    with account_session_lock():
        profile = str(account_auth_cookie_path().resolve())
        generation, revoked = _ACCOUNT_GENERATIONS.setdefault(profile, (0, threading.Event()))
        revoked.set()
        _ACCOUNT_GENERATIONS[profile] = (generation + 1, threading.Event())


def account_session_matches(binding: AccountSessionBinding) -> bool:
    with account_session_lock():
        if binding.revoked.is_set() or binding.profile != str(account_auth_cookie_path().resolve()):
            return False
        return binding.base_url == _configured_backend() and binding.fingerprint == _session_fingerprint(load_account_auth_jar())


def require_account_session_binding(binding: AccountSessionBinding) -> None:
    if not account_session_matches(binding):
        raise AccountBackendError("The account session changed. Start a new request.", 401)


class _NoBackendRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Login bodies and session cookies belong only to the configured backend.
        return None


def request_account_backend(path: str, *, payload: dict | None = None, timeout: float = 10.0):
    # Logout and late status responses must not race a cookie back onto disk.
    with account_session_lock():
        if (authority := current_account_request_authority()) is not None:
            require_account_session_binding(authority)
        return _request_account_backend(path, payload=payload, timeout=timeout)


def _request_account_backend(path: str, *, payload: dict | None, timeout: float):
    base = bot_backend_base()
    jar = load_account_auth_jar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), _NoBackendRedirects())
    parsed = urlsplit(base)
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "Origin": f"{parsed.scheme}://{parsed.netloc}"}
    if (correlation_id := current_request_correlation_id()) is not None:
        headers[CORRELATION_ID_HEADER] = correlation_id
    request = urllib.request.Request(
        base + path, data=json.dumps(payload).encode() if payload is not None else None,
        method="POST" if payload is not None else "GET",
        headers=headers,
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            result = json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        save_account_auth_jar(jar)
        notify_account_auth_failure(error.code)
        try:
            detail = json.loads(error.read(16_384)).get("message")
        except (ValueError, AttributeError):
            detail = None
        message = detail[:2_000] if isinstance(detail, str) else f"Account backend returned HTTP {error.code}."
        raise AccountBackendError(message, error.code) from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise AccountBackendError("Account service is unavailable. Please retry.") from error
    save_account_auth_jar(jar)
    return result


def require_account_session() -> dict:
    session = request_account_backend("/api/auth/get-session")
    user = session.get("user") if isinstance(session, dict) else None
    if not isinstance(user, dict) or not user.get("id"):
        notify_account_auth_failure(401)
        raise AccountBackendError("Sign in to continue.", 401)
    return user


def notify_account_auth_failure(status_code: int, *, expected_binding: AccountSessionBinding | None = None) -> None:
    if status_code != 401:
        return
    import sys

    with account_session_lock():
        if expected_binding is not None and not account_session_matches(expected_binding):
            return
        if "tui_gateway.server" in sys.modules:
            from tui_gateway.account_auth_lifecycle import invalidate_account_session

            invalidate_account_session("expired")
