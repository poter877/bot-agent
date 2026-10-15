"""Validated model selection for the centrally managed company route."""


def switch_company_model(raw_input: str, explicit_provider: str, current_provider: str, is_global: bool):
    from account_backend_models import CompanyModelCatalogError, resolve_company_model
    from account_backend_session import bot_backend_base
    from agent.models_dev import ModelCapabilities
    from hermes_cli.model_switch import ModelSwitchResult

    if explicit_provider.strip().lower() not in ("", "hono", "bot-backend", "company-backend"):
        return ModelSwitchResult(False, error_message="Choose a model from the company model directory.")
    try:
        model = resolve_company_model(raw_input)
        base_url = bot_backend_base()
    except (CompanyModelCatalogError, RuntimeError) as exc:
        return ModelSwitchResult(False, error_message=str(exc))
    caps = model["capabilities"]
    return ModelSwitchResult(
        True, new_model=model["id"], target_provider="hono", provider_changed=current_provider != "hono",
        base_url=base_url, api_mode="chat_completions", provider_label="Company models", is_global=is_global,
        capabilities=ModelCapabilities(
            supports_tools=caps["tools"], supports_vision=caps["vision"], supports_reasoning=caps["reasoning"],
            context_window=model.get("contextLength", 200000), max_output_tokens=model.get("maxOutputTokens")),
    )
