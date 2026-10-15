"""Company Hono backend provider profile (doc《流式服务端重构》§2/§6).

All managed model requests ride the company backend: the client names a
server-side catalog id, auth is the profile's Better Auth session cookie
(shared with the accountAuth bridge — never a vendor key), and the wire is
POST /api/llm/stream speaking AI SDK Core events over SSE. Reports
api_mode="chat_completions" but runs on HonoStreamClient — the
GeminiNativeClient pattern — so the agent's stream loop, tool accumulation,
interrupts and normalize_response work unchanged.

Resolution: a ``providers.hono: {base_url: ...}`` config entry resolves the
runtime (named-custom rung), then ``_profile_for_base_url`` matches this
profile's dynamic ``base_url`` (HERMES_BOT_BACKEND_URL, the same env the
account bridge requires) and ``create_client`` engages.
"""

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

class HonoProfile(ProviderProfile):
    """Company backend — Better Auth session auth, no vendor keys locally."""

    # Dataclass-generated __init__ assigns every field, so the dynamic
    # base_url property needs a setter; the env var stays authoritative and
    # any explicit assignment is only a fallback.
    _base_url_override: str = ""

    @property
    def base_url(self) -> str:  # type: ignore[override]
        from account_backend_session import AccountBackendError, bot_backend_base

        # Discovery also runs on installations where the hidden plugin is unconfigured.
        # Credential scope violations must propagate rather than reading the launch profile.
        try:
            return bot_backend_base()
        except AccountBackendError:
            return (self._base_url_override or "").rstrip("/")

    @base_url.setter
    def base_url(self, value: str) -> None:
        self._base_url_override = value

    def create_client(self, **client_kwargs: Any) -> Any | None:
        from agent.company_backend_policy import create_company_client

        return create_company_client()

    def fetch_models(self, *, api_key=None, base_url=None, timeout: float = 8.0):
        from account_backend_models import fetch_company_models

        return [model["id"] for model in fetch_company_models(timeout=timeout)["models"]]


hono = HonoProfile(
    name="hono",
    aliases=("bot-backend", "company-backend"),
    api_mode="chat_completions",
    # The registry rung keys on auth_type="api_key": the "credential" is the
    # backend endpoint's presence (HERMES_BOT_BACKEND_URL — also this
    # profile's dynamic base_url). The stream client ignores api_key entirely;
    # real auth is the profile's Better Auth session cookie.
    auth_type="api_key",
    env_vars=("HERMES_BOT_BACKEND_URL",),
    display_name="Hermes Bot Backend",
    description="Company backend model streams (Better Auth session)",
    # Company-internal product route: pickers skip it; an explicit
    # model.provider: hono opts in.
    hidden=True,
    supports_health_check=False,
    supports_model_listing=True,
    native_reasoning_details_type="hono.native_assistant",
)

register_provider(hono)
