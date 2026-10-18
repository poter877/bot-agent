"""Company routing at runtime construction and at the actual model-call boundary."""

from __future__ import annotations

from typing import Any

from account_backend_session import (
    AccountBackendError, AccountSessionBinding, account_session_lock, bot_backend_base, capture_account_session,
    company_backend_enabled, current_account_request_authority, load_account_bearer_token,
    require_account_session_binding,
)


def _configured_model(task: str | None = None) -> str | None:
    from hermes_cli.config import load_config_readonly

    config = load_config_readonly()
    section = (config.get("auxiliary") or {}).get(task) if task else None
    section = section or config.get("model") or {}
    if not isinstance(section, dict) or section.get("provider") not in {"hono", "bot-backend", "company-backend"}:
        return None
    return section.get("model") or section.get("default") or section.get("name") or None


def company_runtime(model: str | None = None, *, task: str | None = None) -> dict[str, Any]:
    from account_backend_models import resolve_company_model

    base = bot_backend_base()
    selected = resolve_company_model(model or _configured_model(task), task=task)
    return {"provider": "hono", "requested_provider": "hono", "model": selected["id"],
            "base_url": base, "api_key": base, "api_mode": "chat_completions",
            "source": "company-backend", "capabilities": dict(selected.get("capabilities") or {}),
            "contextLength": selected.get("contextLength"), "maxOutputTokens": selected.get("maxOutputTokens")}


def normalize_agent_route(provider, model, base_url, api_key, api_mode, capabilities,
                          credential_pool, fallback_model):
    if company_backend_enabled():
        route = company_runtime(model or None)
        return ("hono", route["model"], route["base_url"], route["api_key"], "chat_completions",
                route["capabilities"], None, None)
    from hermes_cli.providers import is_actual_route

    if is_actual_route(provider, base_url):
        from hermes_cli.auth import normalize_actual_base_url

        base_url = normalize_actual_base_url(base_url)
    return provider, model, base_url, api_key, api_mode, capabilities, credential_pool, fallback_model


def company_auxiliary_route(task=None, model=None):
    route = company_runtime(model, task=task)
    return "hono", route["model"], route["base_url"], None, "chat_completions"


def create_company_client(*, async_mode: bool = False, expected_binding: AccountSessionBinding | None = None):
    from agent.hono_stream_client import HonoStreamClient

    with account_session_lock():
        for authority in (expected_binding, current_account_request_authority()):
            if authority is not None:
                require_account_session_binding(authority)
        jar, binding = capture_account_session()
        # Same lock as the fingerprint snapshot, so client credentials and
        # binding identity can never disagree. The device-flow Bearer token
        # outranks the jar: when present it is the only credential sent.
        token = load_account_bearer_token()
        client = HonoStreamClient(binding.base_url, cookie_jar=None if token is not None else jar,
                                  bearer_token=token)
        client._account_binding = binding
    if async_mode:
        from agent.hono_auxiliary_client import AsyncHonoStreamClient

        return AsyncHonoStreamClient(client)
    return client


def company_auxiliary_client(model=None, *, task=None, async_mode=False):
    route = company_runtime(model, task=task)
    return create_company_client(async_mode=async_mode), route["model"]


def ensure_company_client(client: Any) -> None:
    from agent.hono_stream_client import HonoStreamClient
    from agent.hono_auxiliary_client import AsyncHonoStreamClient

    if (authority := current_account_request_authority()) is not None:
        require_account_session_binding(authority)
    actual = client._real_client if isinstance(client, AsyncHonoStreamClient) else client
    binding = getattr(actual, "_account_binding", None) if isinstance(actual, HonoStreamClient) else None
    if binding is not None:
        require_account_session_binding(binding)
        return
    if not company_backend_enabled():
        return
    if not isinstance(actual, HonoStreamClient) or actual.base_url != bot_backend_base():
        raise AccountBackendError("Model requests must use the company backend. Select a company model.")
    raise AccountBackendError("The model client has no account session. Start a new request.", 401)


def ensure_company_agent(agent: Any) -> None:
    if not company_backend_enabled():
        return
    if agent.provider != "hono" or agent.api_mode != "chat_completions":
        raise AccountBackendError("This model route is not available. Select a company model.")
    ensure_company_client(agent.client)
