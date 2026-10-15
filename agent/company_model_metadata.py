"""Use the authenticated directory for company model limits and capabilities."""

from __future__ import annotations


def company_capabilities(provider: str, model: str):
    if provider not in {"hono", "bot-backend", "company-backend"}:
        return None
    from account_backend_models import resolve_company_model
    from agent.models_dev import ModelCapabilities

    selected = resolve_company_model(model)
    caps = selected["capabilities"]
    return ModelCapabilities(
        supports_tools=caps["tools"], supports_vision=caps["vision"], supports_reasoning=caps["reasoning"],
        context_window=selected.get("contextLength", 200000), max_output_tokens=selected.get("maxOutputTokens"))


def configure_company_agent(agent, config: dict) -> dict:
    """Project the directory onto the existing compressor and request-limit inputs."""
    if agent.provider != "hono":
        return config
    from account_backend_models import resolve_company_model

    selected = resolve_company_model(agent.model)
    agent.capabilities = dict(selected["capabilities"])
    if not agent.capabilities["tools"]:
        agent.tools = []
        agent.valid_tool_names = set()
    if ceiling := selected.get("maxOutputTokens"):
        agent.max_tokens = min(agent.max_tokens or ceiling, ceiling)
    model = config.get("model")
    model = dict(model) if isinstance(model, dict) else {}
    model.update(provider="hono", default=agent.model, base_url=agent.base_url,
                 context_length=selected.get("contextLength", 200000))
    return {**config, "model": model}
