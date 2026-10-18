"""``hermes account login|logout``: the bot-backend device-code flow as one command.

The HTTP layer is scripted at the command's transport boundary
(``_post_device_endpoint``) so the tests pin the flow contract — code request,
verify URL/code output, 3s pending polling bounded by ``expires_in``, Ctrl-C
clean exit, owner-only token persistence, logout's generation revocation —
without a live backend.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import account_backend_session as account
from hermes_cli import account_commands

_CODE_BODY = {"data": {
    "code": "ABCD-EFGH", "verify_url": "https://backend.test/account/device?code=ABCD-EFGH",
    "expires_in": 600}}
_LOGIN_ARGS = SimpleNamespace(account_action="login", no_browser=True, timeout=None)


@pytest.fixture
def backend_scope(monkeypatch, tmp_path):
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    # HERMES_BOT_BACKEND_URL is a global-env name: get_secret reads os.environ
    # directly, so the env var (not just the secret scope) must carry it.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", "https://backend.test")
    home = set_hermes_home_override(tmp_path)
    secrets = set_secret_scope({"HERMES_BOT_BACKEND_URL": "https://backend.test"})
    try:
        yield tmp_path
    finally:
        reset_secret_scope(secrets)
        reset_hermes_home_override(home)


def _scripted_backend(monkeypatch, responses):
    calls, sleeps = [], []

    def fake_post(base, path, payload, timeout):
        calls.append((base, path, dict(payload)))
        status, body = responses[len(calls) - 1]
        return status, body

    monkeypatch.setattr(account_commands, "_post_device_endpoint", fake_post)
    monkeypatch.setattr(account_commands.time, "sleep", lambda seconds: sleeps.append(seconds))
    return calls, sleeps


def test_login_polls_until_approval_and_persists_the_token(backend_scope, monkeypatch, capsys):
    calls, sleeps = _scripted_backend(monkeypatch, [
        (200, _CODE_BODY),
        (400, {"error": {"code": "authorization_pending", "message": "Device code is awaiting approval."}}),
        (200, {"data": {"token": "bat_secret-token", "name": "device-2026-10-15"}}),
    ])
    account_commands.account_command(_LOGIN_ARGS)
    assert [path for _base, path, _payload in calls] == [
        "/api/auth/device/code", "/api/auth/device/token", "/api/auth/device/token"]
    assert calls[1][2] == {"code": "ABCD-EFGH"}
    assert calls[0][0] == "https://backend.test"
    assert sleeps == [account_commands._POLL_INTERVAL_SECONDS]
    assert account.load_account_bearer_token() == "bat_secret-token"
    out = capsys.readouterr().out
    assert "ABCD-EFGH" in out
    assert "https://backend.test/account/device?code=ABCD-EFGH" in out
    assert "device-2026-10-15" in out
    # The secret itself never reaches the terminal.
    assert "bat_secret-token" not in out


def test_login_opens_the_browser_when_one_is_available(backend_scope, monkeypatch):
    import webbrowser

    import hermes_cli.auth as auth_mod
    monkeypatch.setattr(auth_mod, "_can_open_graphical_browser", lambda: True)
    monkeypatch.setattr(auth_mod, "_is_remote_session", lambda: False)
    opened = []
    monkeypatch.setattr(webbrowser, "open", lambda url: opened.append(url) or True)
    _scripted_backend(monkeypatch, [(200, _CODE_BODY), (200, {"data": {"token": "bat_t", "name": ""}})])
    account_commands.account_command(SimpleNamespace(account_action="login", no_browser=False, timeout=None))
    assert opened == ["https://backend.test/account/device?code=ABCD-EFGH"]


def test_expired_device_code_fails_without_persisting_a_token(backend_scope, monkeypatch, capsys):
    _scripted_backend(monkeypatch, [
        (200, _CODE_BODY),
        (400, {"error": {"code": "device_code_expired", "message": "Device code has expired."}}),
    ])
    with pytest.raises(SystemExit, match="expired"):
        account_commands.account_command(_LOGIN_ARGS)
    assert account.load_account_bearer_token() is None


def test_ctrl_c_during_polling_exits_cleanly_without_a_token(backend_scope, monkeypatch, capsys):
    calls = []

    def interrupting_post(base, path, payload, timeout):
        calls.append(path)
        if path == "/api/auth/device/code":
            return 200, _CODE_BODY
        raise KeyboardInterrupt

    monkeypatch.setattr(account_commands, "_post_device_endpoint", interrupting_post)
    with pytest.raises(SystemExit) as exit_info:
        account_commands.account_command(_LOGIN_ARGS)
    assert exit_info.value.code == 130
    assert account.load_account_bearer_token() is None
    assert "cancelled" in capsys.readouterr().out


def test_login_without_backend_configuration_gives_clear_guidance(monkeypatch, tmp_path):
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.delenv("HERMES_BOT_BACKEND_URL", raising=False)
    home = set_hermes_home_override(tmp_path)
    secrets = set_secret_scope({})
    try:
        with pytest.raises(SystemExit) as exit_info:
            account_commands.account_command(_LOGIN_ARGS)
    finally:
        reset_secret_scope(secrets)
        reset_hermes_home_override(home)
    assert "HERMES_BOT_BACKEND_URL" in str(exit_info.value)


def test_logout_removes_the_token_and_revokes_the_session_generation(backend_scope, capsys):
    account.save_account_bearer_token("bat_token-a")
    _, binding = account.capture_account_session()
    assert account.account_session_matches(binding)
    account_commands.account_command(SimpleNamespace(account_action="logout"))
    assert account.load_account_bearer_token() is None
    assert not account.account_auth_token_path().exists()
    # Generation revocation retires retained clients even before any re-read.
    assert not account.account_session_matches(binding)
    assert "Signed out" in capsys.readouterr().out


def test_logout_without_a_token_reports_nothing_to_do(backend_scope, capsys):
    account_commands.account_command(SimpleNamespace(account_action="logout"))
    assert "nothing to sign out" in capsys.readouterr().out


def test_bare_account_command_prints_usage():
    with pytest.raises(SystemExit, match="Usage"):
        account_commands.account_command(SimpleNamespace(account_action=None))


def test_account_group_is_registered_on_the_hermes_parser():
    from hermes_cli import main

    parser, subparsers = main._build_cli_parser()
    assert "account" in subparsers.choices
    # The group carries a help row, so `hermes --help` lists it.
    assert "account" in parser.format_help()
    login_args = parser.parse_args(["account", "login"])
    assert login_args.account_action == "login"
    assert login_args.func is main.cmd_account
    assert parser.parse_args(["account", "logout"]).account_action == "logout"
