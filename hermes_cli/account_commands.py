"""Company account subcommands: ``hermes account login|logout``.

Wraps the bot-backend device-code flow (doc《用户认证》§设备码登录) into one
command: request a code, hand the user the verify URL, poll until the browser
approval mints a ``bat_`` token, and persist it as the profile's Bearer
credential (``account-auth-token.txt``) — from then on every company-backend
call carries it instead of the session cookies.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

_DEVICE_CODE_PATH = "/api/auth/device/code"
_DEVICE_TOKEN_PATH = "/api/auth/device/token"
# The contract's polling cadence; the backend clamps per-IP rate limits well above it.
_POLL_INTERVAL_SECONDS = 3.0
_DEFAULT_TIMEOUT_SECONDS = 15.0


def _device_error_code(body: dict) -> str:
    error = body.get("error")
    return str((error or {}).get("code") or "") if isinstance(error, dict) else ""


def _device_error_message(body: dict, status: int) -> str:
    error = body.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str) and error["message"]:
        return error["message"]
    return f"account backend returned HTTP {status}."


def _post_device_endpoint(base: str, path: str, payload: dict, timeout: float) -> tuple[int, dict]:
    """Anonymous JSON POST to a device endpoint; 4xx answers as ``(status, body)``.

    These endpoints are reached BEFORE any credential exists, so nothing rides
    the account session machinery — no cookie jar, no Bearer header."""
    request = urllib.request.Request(
        base + path, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read(16_384))
        except (ValueError, OSError):
            body = {}
        return error.code, body if isinstance(body, dict) else {}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise SystemExit("Account service is unreachable. Check the backend URL and your network.") from error
    return response.status, body if isinstance(body, dict) else {}


def _request_device_code(base: str, timeout: float) -> tuple[str, str, int]:
    status, body = _post_device_endpoint(base, _DEVICE_CODE_PATH, {}, timeout)
    data = body.get("data")
    if status != 200 or not isinstance(data, dict):
        raise SystemExit(f"Device-code request failed: {_device_error_message(body, status)}")
    code = str(data.get("code") or "").strip()
    verify_url = str(data.get("verify_url") or "").strip()
    expires_in = data.get("expires_in")
    if not code or not verify_url or not isinstance(expires_in, (int, float)):
        raise SystemExit("Device-code response was missing code, verify_url, or expires_in.")
    return code, verify_url, int(expires_in)


def _poll_device_token(base: str, code: str, *, expires_in: int, timeout: float) -> tuple[str, str]:
    """Poll the token endpoint until approval; returns ``(token, name)``.

    ``authorization_pending`` sleeps the contract interval and retries; any
    other error (expired / unknown / consumed code) ends the login; the
    expires_in budget bounds the whole loop."""
    deadline = time.monotonic() + max(1, expires_in)
    while time.monotonic() < deadline:
        status, body = _post_device_endpoint(base, _DEVICE_TOKEN_PATH, {"code": code}, timeout)
        data = body.get("data")
        if status == 200 and isinstance(data, dict) and str(data.get("token") or "").strip():
            return str(data["token"]).strip(), str(data.get("name") or "").strip()
        error_code = _device_error_code(body)
        if error_code != "authorization_pending":
            reason = {
                "device_code_expired": "The device code expired before approval.",
                "conflict": "The device code was already used.",
                "not_found": "The device code is unknown to the backend.",
            }.get(error_code, _device_error_message(body, status))
            raise SystemExit(f"Device login failed: {reason} Run `hermes account login` again.")
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise SystemExit("The device code expired before approval. Run `hermes account login` again.")


def _unconfigured_backend_exit() -> SystemExit:
    return SystemExit(
        "No company backend is configured for this profile.\n"
        "Set HERMES_BOT_BACKEND_URL (or providers.hono.base_url in config.yaml), or select a\n"
        "company model with `hermes model`, then run `hermes account login` again.")


def account_login_command(args) -> None:
    from account_backend_session import AccountBackendError, bot_backend_base, save_account_bearer_token
    # Facade import (not the auth_device_flow sibling) keeps the hermes_cli.auth patch seam.
    from hermes_cli.auth import _can_open_graphical_browser, _is_remote_session, _print_device_code_instructions

    timeout = float(getattr(args, "timeout", None) or _DEFAULT_TIMEOUT_SECONDS)
    try:
        base = bot_backend_base()
    except AccountBackendError:
        raise _unconfigured_backend_exit() from None

    code, verify_url, expires_in = _request_device_code(base, timeout)
    _print_device_code_instructions(
        verify_url, code,
        open_browser=not getattr(args, "no_browser", False) and not _is_remote_session()
        and _can_open_graphical_browser(),
        swallow_open_errors=True,
    )
    print(f"Waiting for approval (polling every {int(_POLL_INTERVAL_SECONDS)}s, "
          f"code expires in {expires_in}s) — Ctrl-C to cancel.")
    try:
        token, name = _poll_device_token(base, code, expires_in=expires_in, timeout=timeout)
    except KeyboardInterrupt:
        print("\nDevice login cancelled; no token was saved.")
        raise SystemExit(130) from None
    save_account_bearer_token(token)
    from hermes_constants import display_hermes_home

    print()
    print(f"Signed in{' as ' + name if name else ''}. The device token is saved to")
    print(f"  {display_hermes_home()}/account-auth-token.txt (owner-only permissions)")
    print("Company model, media, and tool requests now use this token; "
          "`hermes account logout` removes it.")


def account_logout_command(args) -> None:
    from account_backend_session import (
        account_session_lock, advance_account_session_generation, clear_account_bearer_token,
        load_account_bearer_token,
    )

    with account_session_lock():
        had_token = load_account_bearer_token() is not None
        clear_account_bearer_token()
        # Retire this process's retained clients immediately (cookie-mode
        # fingerprint takes over); other processes see the file change on their
        # next session check, same as a cookie swap.
        advance_account_session_generation()
    if had_token:
        print("Signed out: the device token for this profile was removed.")
        print("Company requests fall back to the account session cookie, when one exists.")
    else:
        print("No device token on this profile; nothing to sign out.")


_ACCOUNT_ACTIONS = {"login": account_login_command, "logout": account_logout_command}


def account_command(args) -> None:
    handler = _ACCOUNT_ACTIONS.get(getattr(args, "account_action", "") or "")
    if handler is None:
        raise SystemExit("Usage: `hermes account login` (device-code sign-in) or `hermes account logout`.")
    handler(args)
