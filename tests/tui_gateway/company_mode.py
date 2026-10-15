"""Helpers for tests running under the company-mode admission gate.

Company mode (``HERMES_DESKTOP=1`` or a configured company backend) gates every
business RPC behind an authenticated Better Auth session. Tests that exercise
the business logic BENEATH the gate stub the account verification to a stable
binding; the gate's own behavior is covered in ``test_company_mode_gate.py``.
"""

from __future__ import annotations

import threading


def signed_in_company_session(monkeypatch) -> None:
    """Admit every guarded RPC as an authenticated company session."""
    from account_backend_session import AccountSessionBinding
    from tui_gateway import account_auth_guard

    binding = AccountSessionBinding(
        profile="default", base_url="http://company.test", fingerprint="test", revoked=threading.Event(),
    )
    monkeypatch.setattr(account_auth_guard, "_verify_account", lambda method: binding)
