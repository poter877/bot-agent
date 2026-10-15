"""Migrate saved direct-provider selections to the authenticated company default."""

def resolve_company_agent_runtime(model_override=None, provider_override=None):
    from account_backend_session import company_backend_enabled
    from agent.company_backend_policy import company_runtime
    from hermes_cli.config import load_config_readonly

    config = load_config_readonly()
    if not company_backend_enabled(config=config):
        return None
    configured = config.get("model") or {}
    configured = configured if isinstance(configured, dict) else {}
    provider = provider_override or configured.get("provider") or ""
    model = configured.get("default") or configured.get("name")
    if isinstance(model_override, dict):
        provider = model_override.get("provider") or provider
        model = model_override.get("model")
    elif model_override:
        model = str(model_override)
    # A vendor model id has no meaning in the company namespace. Preserve only
    # company-owned selections; an explicitly saved/selected unknown alias still fails.
    selected = model if str(provider).strip().lower() in {"hono", "bot-backend", "company-backend"} else None
    runtime = company_runtime(selected)
    return runtime["model"], runtime


def company_setup_status():
    """Company policy is local and authoritative even when its directory is offline."""
    from account_backend_session import company_backend_enabled
    from hermes_cli.config import load_config_readonly

    if not company_backend_enabled(config=load_config_readonly()):
        return None
    return {"managed": True, "provider_configured": True, "ready": True,
            "inference_provider": "hono", "free_tier_route": False}


def company_runtime_readiness(requested=None):
    from account_backend_models import CompanyModelCatalogError
    from account_backend_session import AccountBackendError

    if company_setup_status() is None:
        return None
    result = {"managed": True, "provider": "hono", "free_tier_route": False}
    try:
        if requested and requested not in {"hono", "bot-backend", "company-backend"}:
            raise ValueError("Only company models are available in this desktop application.")
        model, runtime = resolve_company_agent_runtime(provider_override=requested)
        return {**result, "ok": True, "model": model, "source": runtime["source"]}
    except (AccountBackendError, CompanyModelCatalogError, ValueError) as error:
        # Keep policy attached to a failed probe: clients must offer a retry,
        # never interpret an unavailable company service as missing vendor keys.
        return {**result, "ok": False, "error": str(error)}
