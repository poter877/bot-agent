"""Provider availability for config selectors, including the company directory policy."""


def list_available_providers() -> list[dict]:
    """Return provider identity and authentication metadata for the current profile."""
    from account_backend_session import company_backend_enabled

    if company_backend_enabled():
        from account_backend_models import fetch_company_models

        fetch_company_models()
        return [{"id": "hono", "label": "Company models", "aliases": [], "authenticated": True}]

    from hermes_cli.models import _PROVIDER_ALIASES, _PROVIDER_LABELS, _provider_has_credentials
    from hermes_cli.models_catalog_static import listed_canonical_providers

    aliases_for: dict[str, list[str]] = {}
    for alias, canonical in _PROVIDER_ALIASES.items():
        aliases_for.setdefault(canonical, []).append(alias)
    return [{"id": pid, "label": _PROVIDER_LABELS.get(pid, pid),
             "aliases": aliases_for.get(pid, []), "authenticated": _provider_has_credentials(pid)}
            for pid in [provider.slug for provider in listed_canonical_providers()] + ["custom"]]
