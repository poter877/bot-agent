"""Shared Better Auth session state for the company bot-backend (doc《用户认证》§2).

The agent subprocess is the ONLY backend client (doc《后端服务》§6): both the
tui_gateway accountAuth bridge and the Hono model stream client ride the same
profile-scoped cookie jar, persisted under the profile home so a restart
restores the session. ``HERMES_BOT_BACKEND_URL`` selects the backend.
"""

from __future__ import annotations

import os
from http.cookiejar import MozillaCookieJar
from pathlib import Path

ACCOUNT_AUTH_COOKIE_FILE = "account-auth-cookies.txt"


def bot_backend_base() -> str:
    """The configured backend base URL; raises when unconfigured — callers
    surface that as "service unavailable", never a simulated fallback."""
    base = os.environ.get("HERMES_BOT_BACKEND_URL", "").strip().rstrip("/")
    if not base:
        raise RuntimeError("account backend is not configured (HERMES_BOT_BACKEND_URL)")
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
