"""Company-backend TTS engine (``POST /api/media/speech``) for ``tools.tts_tool``.

公司模式下唯一的语音合成路径（判定与硬切先例：``tools/image_generation_tool.py`` /
``tools/video_generation_tool.py``）：服务端持厂商密钥，客户端不解析任何直连凭据。
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any

from tools.tts_tool_delivery import _section

logger = logging.getLogger(__name__)

DEFAULT_COMPANY_TTS_MODEL = "gpt-4o-mini-tts"
DEFAULT_COMPANY_TTS_VOICE = "alloy"


def _company_speech_response_format(output_path: str) -> str:
    """The speech endpoint accepts only ``mp3``/``wav``; pick by output extension, mp3
    otherwise (the container sniff/repair stage later renames a path whose bytes disagree)."""
    return "wav" if output_path.lower().endswith(".wav") else "mp3"


def _generate_company_speech(text: str, output_path: str, tts_config: dict[str, Any]) -> None:
    """公司模式引擎：speech envelope ``{ok, audio: {media_type, base64}}`` 解码写入既定输出路径。

    Model/voice come from ``tts.company`` (default gpt-4o-mini-tts/alloy — the closed speech
    model set the backend serves); ``speed`` rides the shared ``tts.speed`` (the per-call
    override is already merged in). Empty audio decodes to zero bytes, which the caller's
    no-output check reports through the standard error envelope."""
    from account_backend_models import generate_media

    company_cfg = _section(tts_config, "company")
    payload: dict[str, Any] = {
        "model": company_cfg.get("model") or DEFAULT_COMPANY_TTS_MODEL,
        "input": text,
        "voice": company_cfg.get("voice") or DEFAULT_COMPANY_TTS_VOICE,
        "response_format": _company_speech_response_format(output_path),
    }
    speed = tts_config.get("speed")
    if isinstance(speed, (int, float)) and float(speed) != 1.0:
        payload["speed"] = max(0.25, min(4.0, float(speed)))
    result = generate_media("speech", payload)
    audio = (result or {}).get("audio") or {}
    Path(output_path).write_bytes(base64.b64decode(str(audio.get("base64") or "")))
