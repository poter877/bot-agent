"""Helpers for tests running under the company-mode admission gate.

Company mode (``HERMES_DESKTOP=1`` or a configured company backend) gates every
business RPC behind an authenticated Better Auth session. Tests that exercise
the business logic BENEATH the gate stub the account verification to a stable
binding; the gate's own behavior is covered in ``test_company_mode_gate.py``.
``company_mode_off`` documents legacy machinery (e.g. the welcome trial) that
only executes when company mode is off.
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


def company_mode_off(monkeypatch) -> None:
    """Pretend no company backend is configured anywhere.

    Most call sites import :func:`account_backend_session.company_backend_enabled`
    lazily inside functions, so patching the session module covers them; the two
    module-level importers (company_backend_policy, auxiliary_client) are patched
    in their own namespaces. Legacy machinery tests (the desktop welcome trial)
    use this to document flows that only execute while company mode is off."""
    import account_backend_session
    import agent.auxiliary_client
    import agent.company_backend_policy as policy

    for module in (account_backend_session, agent.auxiliary_client, policy):
        monkeypatch.setattr(module, "company_backend_enabled", lambda *a, **k: False)
