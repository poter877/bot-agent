"""公司模式下欢迎试用必须整体失效：claim 被首条 blocker 拒绝、永不铸造 Nous
来宾，资格（inference_available）只来自已配置的 provider —— 即公司后端本身。
这是《流式服务端重构》§6"不能把厂商密钥分发到本地"在免费层上的落实。
"""

from __future__ import annotations

import pytest

from hermes_cli import welcome_trial
from tests.tui_gateway.company_mode import company_mode_off


@pytest.fixture
def desktop(monkeypatch):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "test-spawn-token")
    monkeypatch.delenv("HERMES_BOT_BACKEND_URL", raising=False)
    monkeypatch.setattr(welcome_trial.anon_auth, "guest_allowed", lambda: True)
    monkeypatch.setattr(welcome_trial, "_has_nous_identity", lambda: False)
    monkeypatch.setattr(welcome_trial, "_machine_is_used", lambda assume_fresh: False)


def test_company_mode_blocks_the_claim(desktop, monkeypatch):
    import account_backend_session

    # HERMES_BOT_BACKEND_URL unset: company mode is on via the desktop marker alone.
    assert account_backend_session.company_backend_enabled() is True
    blocker = welcome_trial.claim_blocker()
    assert blocker == "company mode carries inference"
    assert welcome_trial.claim_desktop_free_tier() is None


def test_eligibility_follows_the_provider_not_the_trial(desktop, monkeypatch):
    # The Nous guest must not count: free_inference_active is ignored in company mode.
    monkeypatch.setattr(welcome_trial.anon_auth, "free_inference_active", lambda: True)
    assert welcome_trial.inference_available() is False

    monkeypatch.setattr(welcome_trial, "provider_configured", lambda: True)
    assert welcome_trial.inference_available() is True


def test_trial_still_available_when_company_mode_is_off(desktop, monkeypatch):
    # The machinery stays reachable while company mode is off (documented in
    # tests/tui_gateway/test_onboarding_welcome_claim.py): the company blocker
    # must not leak into the non-company path.
    company_mode_off(monkeypatch)
    assert welcome_trial.claim_blocker() is None
