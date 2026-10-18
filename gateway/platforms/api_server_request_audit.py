"""Request source-metadata audit helpers for the API server adapter.

``RequestAuditContextMixin`` (inherited by ``APIServerAdapter``) carries the non-secret
source-metadata builder (``_request_audit_context``, incl. the caller-chosen
``X-Correlation-Id``), its log suffix (``_request_audit_log_suffix``) and the cron-origin
projection (``_cron_origin_from_request``). api_server-internal helpers are imported lazily
inside each method: the origin imports this module (top-level import = cycle), and lazy lookup
keeps ``patch("...api_server.X")`` effective.
"""

from contextlib import suppress
from typing import Any

try:
    from aiohttp import web
except ImportError:  # pragma: no cover - mirrors api_server's optional import
    web = None  # type: ignore[assignment]


class RequestAuditContextMixin:
    """Non-secret request source metadata for security logs and cron job origins."""

    @staticmethod
    def _clean_log_value(value: Any, *, max_len: int = 200) -> str:
        """Sanitize request metadata before it reaches security logs."""
        if value is None:
            return ""
        text = str(value).replace("\r", " ").replace("\n", " ").strip()
        return text[:max_len]

    def _request_audit_context(self, request: web.Request) -> dict[str, str]:
        """Return non-secret source metadata for security/audit warnings."""
        peer_ip = ""
        with suppress(Exception):
            peer = request.transport.get_extra_info("peername") if request.transport else None
            if isinstance(peer, (tuple, list)) and peer:
                peer_ip = str(peer[0])
        from account_backend_session import sanitize_correlation_id

        return {
            "remote": self._clean_log_value(getattr(request, "remote", "") or peer_ip),
            "peer_ip": self._clean_log_value(peer_ip),
            "forwarded_for": self._clean_log_value(request.headers.get("X-Forwarded-For", "")),
            "real_ip": self._clean_log_value(request.headers.get("X-Real-IP", "")),
            "method": self._clean_log_value(request.method, max_len=16),
            "path": self._clean_log_value(request.path_qs, max_len=500),
            "user_agent": self._clean_log_value(request.headers.get("User-Agent", ""), max_len=300),
            # Empty when the request carried no (valid) correlation id — the suffix
            # builder drops empty fields, so uncorrelated log lines stay unchanged.
            "correlation_id": self._clean_log_value(sanitize_correlation_id(
                request.headers.get("X-Correlation-Id")) or "", max_len=128)}

    def _request_audit_log_suffix(self, request: web.Request) -> str:
        ctx = self._request_audit_context(request)
        fields = [f"{key}={value!r}" for key, value in ctx.items() if value]
        return " ".join(fields) if fields else "source='unknown'"

    def _cron_origin_from_request(self, request: web.Request) -> dict[str, str]:
        """Persist safe API source metadata on cron jobs created over HTTP."""
        ctx = self._request_audit_context(request)
        origin = {"platform": "api_server", "chat_id": "api"}
        for ctx_key, origin_key in (("remote", "source_ip"), ("peer_ip", "peer_ip"),
                                    ("forwarded_for", "forwarded_for"), ("real_ip", "real_ip"),
                                    ("user_agent", "user_agent")):
            if ctx.get(ctx_key):
                origin[origin_key] = ctx[ctx_key]
        return origin
