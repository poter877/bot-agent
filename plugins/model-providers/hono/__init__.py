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

import logging
import os
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

logger = logging.getLogger(__name__)


class HonoProfile(ProviderProfile):
    """Company backend — Better Auth session auth, no vendor keys locally."""

    # Dataclass-generated __init__ assigns every field, so the dynamic
    # base_url property needs a setter; the env var stays authoritative and
    # any explicit assignment is only a fallback.
    _base_url_override: str = ""

    @property
    def base_url(self) -> str:  # type: ignore[override]
        # Dynamic on purpose: _profile_for_base_url prefix-matches the resolved
        # runtime base_url against profile.base_url, and the deployment URL is
        # only known at runtime — HERMES_BOT_BACKEND_URL, else this profile's
        # own providers.hono.base_url config entry.
        env = (os.environ.get("HERMES_BOT_BACKEND_URL") or "").rstrip("/")
        if env:
            return env
        try:
            from hermes_cli.config import load_config_readonly

            entry = (load_config_readonly().get("providers") or {}).get(self.name)
            if isinstance(entry, dict) and entry.get("base_url"):
                return str(entry["base_url"]).rstrip("/")
        except Exception:
            logger.debug("hono profile: config base_url lookup failed", exc_info=True)
        return (self._base_url_override or "").rstrip("/")

    @base_url.setter
    def base_url(self, value: str) -> None:
        self._base_url_override = value

    def create_client(self, **client_kwargs: Any) -> Any | None:
        from account_backend_session import bot_backend_base, load_account_auth_jar

        base_url = str(client_kwargs.get("base_url") or "").strip() or bot_backend_base()
        from agent.hono_stream_client import HonoStreamClient

        return HonoStreamClient(base_url=base_url, cookie_jar=load_account_auth_jar())


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
    supports_model_listing=False,
)

register_provider(hono)
