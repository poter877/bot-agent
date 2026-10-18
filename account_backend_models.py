"""Authenticated company model directory, shared by routing and every picker.

Each read uses the current profile's session jar. No process-wide catalog survives
an account/profile change, and failures never fall back to a vendor catalog.
"""

from __future__ import annotations

class CompanyModelCatalogError(RuntimeError):
    """The authoritative directory could not authorize a model selection."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _validate_catalog(value: object) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("models"), list):
        raise CompanyModelCatalogError("Invalid company model directory response.")
    models, seen = [], set()
    for item in value["models"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
            raise CompanyModelCatalogError("Invalid company model directory entry.")
        model_id = item["id"]
        caps = item.get("capabilities")
        if model_id.casefold() in seen or not isinstance(caps, dict):
            raise CompanyModelCatalogError("Invalid company model directory entry.")
        seen.add(model_id.casefold())
        if any(not isinstance(caps.get(key), bool) for key in ("text", "tools", "vision", "video", "reasoning")):
            raise CompanyModelCatalogError("Invalid company model capabilities.")
        model = {"id": model_id, "displayName": str(item.get("displayName") or model_id),
                 "capabilities": {key: caps[key] for key in ("text", "tools", "vision", "video", "reasoning")}}
        for key in ("contextLength", "maxOutputTokens"):
            number = item.get(key)
            if number is not None:
                if type(number) is not int or number <= 0:
                    raise CompanyModelCatalogError("Invalid company model token limit.")
                model[key] = number
        models.append(model)
    default = value.get("defaultModel")
    if (models and default not in {model["id"] for model in models}) or (not models and default is not None):
        raise CompanyModelCatalogError("Invalid company default model.")
    return {"models": models, "defaultModel": default}


def fetch_company_models(*, timeout: float = 8.0) -> dict:
    """Fetch the current account's public directory; never forward vendor credentials."""
    from account_backend_session import AccountBackendError, request_account_backend

    try:
        return _validate_catalog(request_account_backend("/api/llm/models", timeout=timeout))
    except AccountBackendError as exc:
        message = ("Sign in again to load company models." if exc.status_code in (401, 403)
                   else "The company model directory is unavailable.")
        raise CompanyModelCatalogError(message, status_code=exc.status_code) from exc


def resolve_company_model(requested: str | None, task: str | None = None) -> dict:
    """Resolve a catalog alias, or its default; explicit unknown aliases fail closed."""
    catalog = fetch_company_models()
    model_id = str(requested or catalog["defaultModel"] or "").strip()
    model = next((row for row in catalog["models"] if row["id"].casefold() == model_id.casefold()), None)
    if model is None:
        raise CompanyModelCatalogError("The selected model is not available in the company model directory.")
    required = {"vision": "vision", "video": "video", "tools": "tools"}.get(task or "")
    if required and not model["capabilities"][required]:
        raise CompanyModelCatalogError(f"The selected company model does not support {required}.")
    return model


_MEDIA_TIMEOUT_SECONDS = 600.0
# Speech is one short synthesis call (input capped server-side at 20k chars), not a
# minutes-long generation job like image/video, so it fails fast relative to them.
_SPEECH_TIMEOUT_SECONDS = 120.0
_MEDIA_KIND_TIMEOUTS: dict[str, float] = {
    "image": _MEDIA_TIMEOUT_SECONDS,
    "video": _MEDIA_TIMEOUT_SECONDS,
    "speech": _SPEECH_TIMEOUT_SECONDS,
}


def generate_media(kind: str, payload: dict) -> dict:
    """Image/video/speech generation through the company backend (``/api/media/{kind}``).

    ``kind`` is ``"image"``, ``"video"`` or ``"speech"``. Returns the backend envelope
    (``{ok, images|videos: [{media_type, base64}] | audio: {media_type, base64}, ...}``);
    auth/backend failures raise :class:`AccountBackendError` (the tools surface them
    as copy)."""
    if kind not in _MEDIA_KIND_TIMEOUTS:
        raise ValueError(f"unknown media kind {kind!r}")
    from account_backend_session import request_account_backend

    return request_account_backend(
        f"/api/media/{kind}", payload=payload, timeout=_MEDIA_KIND_TIMEOUTS[kind])
