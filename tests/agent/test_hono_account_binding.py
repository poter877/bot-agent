"""A retained model client cannot outlive its account or profile authority."""

from __future__ import annotations

import contextvars
import threading
from http.cookiejar import Cookie, MozillaCookieJar
from types import SimpleNamespace

import httpx
import pytest

import account_backend_session as account
from agent import company_backend_policy as policy
from agent.hono_stream_client import HonoHttpError


def _set_account(value):
    jar = MozillaCookieJar()
    jar.set_cookie(Cookie(0, "better-auth.session_token", value, None, False,
                         "backend.test", False, False, "/", True, False, None,
                         True, None, None, {}))
    account.save_account_auth_jar(jar)


@pytest.fixture
def account_scope(monkeypatch, tmp_path):
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_BOT_BACKEND_URL", "https://backend.test")
    home = set_hermes_home_override(tmp_path)
    secrets = set_secret_scope({"HERMES_BOT_BACKEND_URL": "https://backend.test"})
    _set_account("account-a")
    try:
        yield tmp_path
    finally:
        reset_secret_scope(secrets)
        reset_hermes_home_override(home)


def _client(handler):
    client = policy.create_company_client()
    # Carry the factory-built credentials across the transport swap: cookies in
    # session mode, the default Authorization header in device-token mode.
    cookies, default_headers = client._http.cookies, dict(client._http.headers)
    client._http.close()
    client._http = httpx.Client(cookies=cookies, headers=default_headers, transport=httpx.MockTransport(handler))
    return client


@pytest.fixture
def gateway_notifications():
    from tui_gateway import server

    return server


def _sse(text="ok"):
    return httpx.Response(200, headers={
        "content-type": "text/event-stream", "x-model-stream-version": "1",
    }, text=f'event: ai-sdk\ndata: {{"type":"text-delta","id":"t","text":"{text}"}}\n\n'
            'event: ai-sdk\ndata: {"type":"finish","finishReason":"stop","totalUsage":{}}\n\n')


def test_factory_binds_fingerprint_to_the_cookie_snapshot(account_scope, monkeypatch):
    original_load = account.load_account_auth_jar

    def change_before_read():
        _set_account("account-b")
        return original_load()

    # A login lands between the former factory's first cookie read and its
    # independent fingerprint read. No sleeps or scheduler timing involved.
    monkeypatch.setattr(account, "load_account_auth_jar", change_before_read)
    with policy.create_company_client() as client:
        try:
            policy.ensure_company_client(client)
        except account.AccountBackendError:
            return
        assert client._http.cookies.get("better-auth.session_token") == "account-b"


def test_delayed_stream_checks_session_at_send(account_scope):
    requests = []
    with _client(lambda request: requests.append(request) or _sse()) as client:
        policy.ensure_company_client(client)
        stream = client.chat.completions.create(model="company", messages=[{"role": "user", "content": "hi"}], stream=True)
        _set_account("account-b")
        with pytest.raises(account.AccountBackendError):
            next(stream)
    assert requests == []


@pytest.mark.parametrize("keep_cookie", [False, True])
def test_late_unauthorized_body_does_not_invalidate_new_login(account_scope, gateway_notifications, monkeypatch, keep_cookie):
    from tui_gateway import account_auth_lifecycle

    invalidations = []
    monkeypatch.setattr(account_auth_lifecycle, "invalidate_account_session", lambda *a, **k: invalidations.append((a, k)))

    class LateUnauthorized(httpx.SyncByteStream):
        def __iter__(self):
            if keep_cookie:
                account.advance_account_session_generation()
            else:
                _set_account("account-b")
            yield b'{"error":{"message":"expired account-a"}}'

    with _client(lambda _: httpx.Response(401, stream=LateUnauthorized())) as client:
        with pytest.raises((HonoHttpError, account.AccountBackendError)):
            client.chat.completions.create(model="company", messages=[{"role": "user", "content": "hi"}])
    assert invalidations == []
    assert next(iter(account.load_account_auth_jar())).value == ("account-a" if keep_cookie else "account-b")


def test_old_stream_cannot_deliver_a_tool_after_account_change(account_scope):
    class ChangedAccountStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b'event: ai-sdk\ndata: {"type":"text-delta","id":"t","text":"started"}\n\n'
            _set_account("account-b")
            yield b'event: ai-sdk\ndata: {"type":"tool-call","toolCallId":"c","toolName":"terminal","input":{}}\n\n'

    def handler(_request):
        return httpx.Response(200, headers={"content-type": "text/event-stream", "x-model-stream-version": "1"}, stream=ChangedAccountStream())

    with _client(handler) as client:
        stream = client.chat.completions.create(model="company", messages=[{"role": "user", "content": "hi"}], stream=True)
        assert next(stream).choices[0].delta.content == "started"
        with pytest.raises(account.AccountBackendError):
            next(stream)


def test_identical_cookie_in_another_profile_does_not_authorize_retained_client(account_scope, tmp_path):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    with policy.create_company_client() as client:
        other = tmp_path / "other-profile"
        token = set_hermes_home_override(other)
        try:
            _set_account("account-a")
            with pytest.raises(account.AccountBackendError):
                policy.ensure_company_client(client)
        finally:
            reset_hermes_home_override(token)


def test_revocation_without_cookie_deletion_retires_existing_clients(account_scope):
    with policy.create_company_client() as client:
        before = account.account_session_fingerprint()
        account.advance_account_session_generation()
        assert account.account_session_fingerprint() != before
        assert next(iter(account.load_account_auth_jar())).value == "account-a"
        with pytest.raises(account.AccountBackendError):
            policy.ensure_company_client(client)


def test_device_token_is_the_model_clients_only_credential(account_scope):
    _set_account("account-a")
    account.save_account_bearer_token("bat_token-a")
    requests = []
    with _client(lambda request: requests.append(request) or _sse()) as client:
        policy.ensure_company_client(client)
        assert client._http.headers.get("Authorization") == "Bearer bat_token-a"
        assert not dict(client._http.cookies)
        stream = client.chat.completions.create(
            model="company", messages=[{"role": "user", "content": "hi"}], stream=True)
        assert next(stream).choices[0].delta.content == "ok"
    request, = requests
    assert request.headers.get("Authorization") == "Bearer bat_token-a"
    assert "cookie" not in request.headers


def test_device_token_change_retires_the_retained_model_client(account_scope):
    _set_account("account-a")
    account.save_account_bearer_token("bat_token-a")
    requests = []
    with _client(lambda request: requests.append(request) or _sse()) as client:
        policy.ensure_company_client(client)
        account.save_account_bearer_token("bat_token-b")
        with pytest.raises(account.AccountBackendError):
            next(client.chat.completions.create(
                model="company", messages=[{"role": "user", "content": "hi"}], stream=True))
    assert requests == []


def test_logout_does_not_wait_for_pending_model_headers(account_scope):
    entered, release, revoked = threading.Event(), threading.Event(), threading.Event()
    failures = []

    def handler(_request):
        entered.set()
        assert release.wait(5)
        return _sse()

    with _client(handler) as client:
        def request():
            try:
                client.chat.completions.create(model="company", messages=[{"role": "user", "content": "hi"}])
            except Exception as error:
                failures.append(error)

        def revoke():
            account.advance_account_session_generation()
            revoked.set()

        request_thread = threading.Thread(target=contextvars.copy_context().run, args=(request,))
        revoke_thread = threading.Thread(target=contextvars.copy_context().run, args=(revoke,))
        request_thread.start()
        try:
            assert entered.wait(5)
            revoke_thread.start()
            assert revoked.wait(5)
        finally:
            release.set()
            request_thread.join(5)
            if revoke_thread.ident is not None:
                revoke_thread.join(5)
        assert len(failures) == 1 and isinstance(failures[0], account.AccountBackendError)


def test_current_session_unauthorized_response_still_invalidates(account_scope, gateway_notifications, monkeypatch):
    from tui_gateway import account_auth_lifecycle

    invalidations = []
    monkeypatch.setattr(account_auth_lifecycle, "invalidate_account_session", lambda *a, **k: invalidations.append((a, k)))
    with _client(lambda _: httpx.Response(401, json={"error": {"message": "expired"}})) as client:
        with pytest.raises(HonoHttpError):
            client.chat.completions.create(model="company", messages=[{"role": "user", "content": "hi"}])
    assert len(invalidations) == 1


def test_agent_request_rebuild_cannot_adopt_a_new_account(account_scope):
    from agent.agent_runtime_helpers import create_openai_client

    agent = SimpleNamespace()
    with create_openai_client(agent, {}, reason="primary", shared=True) as primary:
        agent.client = primary
        policy.ensure_company_client(primary)
        _set_account("account-b")
        with pytest.raises(account.AccountBackendError):
            with create_openai_client(agent, {}, reason="request_rebuild", shared=False):
                pass


def test_admitted_worker_cannot_create_client_for_a_later_account(account_scope):
    from agent.memory_provider import spawn_context_thread

    _, admitted = account.capture_account_session()
    failures = []

    def work():
        try:
            with policy.create_company_client():
                pass
        except Exception as error:
            failures.append(error)

    with account.bind_account_request_authority(admitted):
        worker = spawn_context_thread(work, name="test-account-admission")
    assert account.current_account_request_authority() is None
    _set_account("account-b")
    worker.start()
    worker.join(5)
    assert not worker.is_alive()
    assert len(failures) == 1 and isinstance(failures[0], account.AccountBackendError)
    with policy.create_company_client() as fresh:
        assert fresh._http.cookies.get("better-auth.session_token") == "account-b"


def test_explicit_new_binding_cannot_override_an_old_admission(account_scope):
    _, admitted = account.capture_account_session()
    _set_account("account-b")
    _, current = account.capture_account_session()
    with account.bind_account_request_authority(admitted):
        with pytest.raises(account.AccountBackendError):
            policy.create_company_client(expected_binding=current)


def test_old_admission_cannot_fetch_catalog_with_new_accounts_cookie(account_scope, monkeypatch):
    _, admitted = account.capture_account_session()
    requests = []
    monkeypatch.setattr(account, "_request_account_backend", lambda *a, **k: requests.append((a, k)) or {})
    with account.bind_account_request_authority(admitted):
        _set_account("account-b")
        with pytest.raises(account.AccountBackendError):
            account.request_account_backend("/api/llm/models")
    assert requests == []


def test_old_admission_cannot_borrow_a_new_accounts_cached_client(account_scope):
    _, admitted = account.capture_account_session()
    _set_account("account-b")
    requests = []
    with _client(lambda request: requests.append(request) or _sse()) as cached_for_b:
        with account.bind_account_request_authority(admitted):
            with pytest.raises(account.AccountBackendError):
                cached_for_b.chat.completions.create(model="company", messages=[{"role": "user", "content": "old task"}])
    assert requests == []
