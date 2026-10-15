"""Lossless AI SDK assistant blocks inside the existing persisted reasoning carrier.

Provider metadata is attached to a *block*, not a whole answer. Signatures can
arrive on start, empty delta, or end events; flattening those blocks destroys
Anthropic thinking, Gemini thought signatures, and OpenAI reasoning item replay.
"""

from __future__ import annotations

import copy
from typing import Any


CARRIER_TYPE = "hono.native_assistant"


def _merge_metadata(target: dict[str, Any], metadata: Any) -> None:
    if not isinstance(metadata, dict):
        return
    for provider, values in metadata.items():
        if not isinstance(values, dict):
            continue
        options = target.setdefault("providerOptions", {}).setdefault(provider, {})
        for key, value in values.items():
            # Providers send null placeholders at block start; a later empty
            # placeholder must not erase an already received opaque value.
            if value is not None or key not in options:
                options[key] = copy.deepcopy(value)


class AssistantReplay:
    """Collect ordered blocks while the original deltas continue streaming."""

    def __init__(self) -> None:
        self._parts: list[dict[str, Any]] = []
        self._blocks: dict[tuple[str, str], dict[str, Any]] = {}

    def _block(self, kind: str, block_id: str) -> dict[str, Any]:
        key = (kind, block_id)
        if key not in self._blocks:
            part = {"type": kind, **({"text": ""} if kind != "tool-call" else {"toolCallId": block_id})}
            self._blocks[key] = part
            self._parts.append(part)
        return self._blocks[key]

    def feed(self, event: dict[str, Any]) -> None:
        event_type = event.get("type") or ""
        kind, _, phase = event_type.rpartition("-")
        if kind in ("text", "reasoning") and phase in ("start", "delta", "end"):
            part = self._block(kind, event.get("id") or "")
            if phase == "delta":
                part["text"] += event.get("text") or ""
            _merge_metadata(part, event.get("providerMetadata"))
        elif event_type in ("tool-input-start", "tool-call"):
            part = self._block("tool-call", event.get("toolCallId") or event.get("id") or "")
            part["toolName"] = event.get("toolName") or ""
            if event_type == "tool-call":
                part["input"] = copy.deepcopy(event.get("input"))
            _merge_metadata(part, event.get("providerMetadata"))

    def record(self) -> dict[str, Any] | None:
        if not any(p.get("providerOptions") or p["type"] == "reasoning" for p in self._parts):
            return None
        return {"type": CARRIER_TYPE, "content": copy.deepcopy(self._parts)}


def replay_assistant_content(message: dict[str, Any], current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Restore exact block order on a request copy; local tool decisions remain authoritative.

    The turn loop may filter invalid/duplicate calls or correct their arguments.
    Match by call ID, never position, so opaque state cannot migrate to a different
    call and a removed call cannot reappear merely because its metadata was saved.
    """
    details = message.get("reasoning_details") or []
    record = next((d for d in details if isinstance(d, dict) and d.get("type") == CARRIER_TYPE), None)
    if not record or not isinstance(record.get("content"), list):
        return current
    calls = {p["toolCallId"]: p for p in current if p["type"] == "tool-call"}
    parts = []
    for saved in record["content"]:
        part = copy.deepcopy(saved)
        if part.get("type") == "tool-call":
            call = calls.pop(part.get("toolCallId"), None)
            if call is None:
                continue
            part.update(call)
        parts.append(part)
    parts.extend(calls.values())
    # Files supplied by local tools/history are not model-generated output and
    # are not in the stream carrier; keep the existing multimodal input path.
    parts.extend(p for p in current if p["type"] == "file")
    return parts


def legacy_reasoning_parts(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Read pre-carrier Hono histories without inventing lost provider state."""
    signed = [d for d in message.get("reasoning_details") or []
              if isinstance(d, dict) and d.get("type") == "reasoning.text" and d.get("signature")]
    if signed:
        return [{"type": "reasoning", "text": d.get("text") or "",
                 "providerOptions": {"anthropic": {"signature": d["signature"]}}} for d in signed]
    reasoning = message.get("reasoning") or message.get("reasoning_content")
    return [{"type": "reasoning", "text": reasoning}] if isinstance(reasoning, str) and reasoning else []
