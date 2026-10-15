"""Company catalog projection onto the existing provider/model picker contract."""

from __future__ import annotations


def build_company_model_payload(current_model: str = "", current_provider: str = "") -> dict:
    from account_backend_models import CompanyModelCatalogError, fetch_company_models

    catalog = fetch_company_models()
    models = catalog["models"]
    if not models:
        raise CompanyModelCatalogError("No company models are available. Check the backend model catalog and provider configuration.")
    ids = [row["id"] for row in models]
    selected = current_model if current_provider == "hono" and current_model in ids else catalog["defaultModel"] or ""
    row = {
        "slug": "hono", "name": "Company models", "models": ids,
        "display_names": {model["id"]: model["displayName"] for model in models},
        "managed": True, "authenticated": True, "auth_type": "session",
        "is_current": True, "total_models": len(ids), "featured_models": ids,
        "capabilities": {
            model["id"]: {"fast": False, **model["capabilities"]} for model in models
        },
    }
    return {"providers": [row], "provider": "hono", "model": selected, "managed": True,
            "default_model": catalog["defaultModel"]}
