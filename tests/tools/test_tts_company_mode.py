"""公司模式下 TTS 全部走公司后端（``POST /api/media/speech``），直连厂商不可达。

硬切语义与判定先例同 image/video 工具（provider 侧整体禁用见
tests/tools/test_image_gen_company_mode.py）：公司后端可用即唯一路径，本地引擎
（neutts/kittentts/piper/edge）、命令/插件 provider、直连厂商解析链全部不可达；
未配置公司后端的部署维持直连厂商分发表不变。
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from gateway.session_context import _UNSET, _VAR_MAP
from tools import tts_tool

_MP3_BYTES = b"ID3\x03\x00\x00\x00\x00\x00\x00"
_B64_MP3 = base64.b64encode(_MP3_BYTES).decode()


def _reset_session_context() -> None:
    for var in _VAR_MAP.values():
        var.set(_UNSET)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    # conftest blanks HERMES_SESSION_PLATFORM but not HERMES_DESKTOP / the backend URL;
    # company mode is opt-in per test, never inherited from the developer shell.
    for key in ("HERMES_DESKTOP", "HERMES_BOT_BACKEND_URL", "HERMES_SESSION_PLATFORM"):
        monkeypatch.delenv(key, raising=False)
    # The ignored-override warning is once-per-process per distinct value.
    tts_tool._once_warnings.clear()
    _reset_session_context()
    yield
    _reset_session_context()


def _speech_envelope(b64: str = _B64_MP3) -> dict:
    return {"ok": True, "audio": {"media_type": "audio/mpeg", "base64": b64}}


def _patch_backend(monkeypatch, envelope=_speech_envelope()) -> list:
    """Stub ``generate_media`` where production reads it (module attr at call time);
    returns the recorded ``(kind, payload)`` calls."""
    calls: list = []

    def fake_generate_media(kind, payload):
        calls.append((kind, payload))
        return envelope

    import account_backend_models
    monkeypatch.setattr(account_backend_models, "generate_media", fake_generate_media)
    return calls


def _forbid_backend(monkeypatch) -> None:
    def forbidden(*_args, **_kwargs):
        raise AssertionError("generate_media must not be called when company mode is off")

    import account_backend_models
    monkeypatch.setattr(account_backend_models, "generate_media", forbidden)


class TestCompanyModeDispatch:

    def test_company_mode_routes_speech_through_backend(self, tmp_path, monkeypatch):
        """公司模式 ⇒ 唯一路径是 generate_media("speech")，直连 OpenAI 的解析链与
        生成器（_resolve_openai_audio_client_config / _generate_openai_tts）不可达。"""
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "openai"})
        calls = _patch_backend(monkeypatch)
        out = tmp_path / "speech.mp3"
        with patch("tools.tts_tool._generate_openai_tts") as direct_gen, \
                patch("tools.tts_tool_openai._resolve_openai_audio_client_config") as resolve_cfg:
            result = json.loads(tts_tool.text_to_speech_tool("Hello world", output_path=str(out)))
        assert result["success"] is True
        assert result["provider"] == "company-backend"
        assert result["file_path"] == str(out)
        assert out.read_bytes() == _MP3_BYTES
        assert calls == [("speech", {
            "model": "gpt-4o-mini-tts", "input": "Hello world", "voice": "alloy",
            "response_format": "mp3"})]
        direct_gen.assert_not_called()
        resolve_cfg.assert_not_called()

    def test_company_mode_ignores_local_engine_selection(self, tmp_path, monkeypatch):
        """配置了本地引擎（piper）也硬切公司后端——与 image/video 工具的公司模式
        一致（它们不保留任何本地回落）。"""
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "piper"})
        calls = _patch_backend(monkeypatch)
        with patch("tools.tts_tool._generate_piper_tts") as piper_gen:
            result = json.loads(tts_tool.text_to_speech_tool(
                "Hello world", output_path=str(tmp_path / "speech.mp3")))
        assert result["success"] is True
        assert result["provider"] == "company-backend"
        assert calls and calls[0][0] == "speech"
        piper_gen.assert_not_called()

    def test_company_model_and_voice_from_config_wav_path(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setattr(tts_tool, "_load_tts_config",
                            lambda: {"company": {"model": "tts-1", "voice": "nova"}})
        calls = _patch_backend(monkeypatch)
        result = json.loads(tts_tool.text_to_speech_tool(
            "Hello world", output_path=str(tmp_path / "speech.wav")))
        assert result["success"] is True
        payload = calls[0][1]
        assert payload["model"] == "tts-1"
        assert payload["voice"] == "nova"
        assert payload["response_format"] == "wav"

    def test_speed_passthrough_and_instructions_dropped(self, tmp_path, monkeypatch):
        """speed 沿用共享 tts.speed 通道（per-call 覆写已并入）；speech 端点没有
        instructions 字段，静默丢弃（schema 已声明该行为）。"""
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setattr(tts_tool, "_load_tts_config", dict)
        calls = _patch_backend(monkeypatch)
        result = json.loads(tts_tool.text_to_speech_tool(
            "Hello world", output_path=str(tmp_path / "speech.mp3"),
            speed=1.5, instructions="cheerful whisper"))
        assert result["success"] is True
        assert calls[0][1]["speed"] == 1.5
        assert "instructions" not in calls[0][1]

    def test_company_mp3_gets_opus_voice_bubble_on_telegram(self, tmp_path, monkeypatch):
        """公司后端只产 mp3/wav：Opus 语音气泡平台经 ffmpeg 转码换语音气泡。"""
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
        monkeypatch.setattr(tts_tool, "_load_tts_config", dict)
        _patch_backend(monkeypatch)
        out, opus = tmp_path / "speech.mp3", tmp_path / "speech.ogg"

        def fake_convert(path: str) -> str:
            assert path == str(out)
            opus.write_bytes(b"ogg")
            return str(opus)

        monkeypatch.setattr(tts_tool, "_convert_to_opus", fake_convert)
        result = json.loads(tts_tool.text_to_speech_tool("Hello world", output_path=str(out)))
        assert result["success"] is True
        assert result["file_path"] == str(opus)
        assert result["voice_compatible"] is True
        assert result["media_tag"] == f"[[audio_as_voice]]\nMEDIA:{opus}"

    def test_company_default_output_is_mp3_and_degrades_without_ffmpeg(self, monkeypatch):
        """默认输出按公司引擎取 .mp3（非 native-Opus 分支）；转码不可用时按普通
        附件投递而非失败。"""
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
        monkeypatch.setattr(tts_tool, "_load_tts_config", dict)
        _patch_backend(monkeypatch)
        monkeypatch.setattr(tts_tool, "_convert_to_opus", lambda path: None)
        result = json.loads(tts_tool.text_to_speech_tool("Hello world"))
        assert result["success"] is True
        assert result["file_path"].endswith(".mp3")
        assert result["voice_compatible"] is False


class TestCompanyModeErrorSurface:

    def test_backend_error_surfaces_as_tool_error(self, tmp_path, monkeypatch):
        from account_backend_session import AccountBackendError

        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setattr(tts_tool, "_load_tts_config", dict)
        import account_backend_models
        monkeypatch.setattr(
            account_backend_models, "generate_media",
            MagicMock(side_effect=AccountBackendError("Account service is unavailable. Please retry.")))
        result = json.loads(tts_tool.text_to_speech_tool(
            "Hello world", output_path=str(tmp_path / "speech.mp3")))
        assert result["success"] is False
        assert "company-backend" in result["error"]
        assert "Account service is unavailable" in result["error"]

    def test_empty_backend_audio_reports_no_output(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.setattr(tts_tool, "_load_tts_config", dict)
        _patch_backend(monkeypatch, envelope=_speech_envelope(b64=""))
        result = json.loads(tts_tool.text_to_speech_tool(
            "Hello world", output_path=str(tmp_path / "speech.mp3")))
        assert result["success"] is False
        assert "produced no output (provider: company-backend)" in result["error"]


class TestNonCompanyModeUnaffected:

    def test_company_off_keeps_direct_vendor_dispatch(self, tmp_path, monkeypatch):
        from tests.tui_gateway.company_mode import company_mode_off

        company_mode_off(monkeypatch)
        _forbid_backend(monkeypatch)
        mock_client = MagicMock()

        def fake_stream(path):
            Path(path).write_bytes(_MP3_BYTES)

        response = MagicMock()
        response.stream_to_file.side_effect = fake_stream
        mock_client.audio.speech.create.return_value = response
        monkeypatch.setattr(tts_tool, "_import_openai_client",
                            MagicMock(return_value=MagicMock(return_value=mock_client)))
        monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "openai"})
        with patch("tools.tts_tool_openai._resolve_openai_audio_client_config",
                   return_value=("tts-openai-test-key", None)):
            result = json.loads(tts_tool.text_to_speech_tool(
                "Hello world", output_path=str(tmp_path / "out.mp3")))
        assert result["success"] is True
        assert result["provider"] == "openai"


class TestRequirements:

    def test_company_mode_requirements_ignore_local_config_and_sdks(self, monkeypatch):
        """公司模式下可用性由公司后端决定：本机 provider 配置/SDK 凭据不被咨询。"""
        monkeypatch.setenv("HERMES_DESKTOP", "1")

        def forbidden():
            raise AssertionError("local provider config must not be consulted in company mode")

        monkeypatch.setattr(tts_tool, "_load_tts_config", forbidden)
        assert tts_tool.check_tts_requirements() is True

    def test_non_company_requirements_still_check_local_provider(self, monkeypatch):
        from tests.tui_gateway.company_mode import company_mode_off

        company_mode_off(monkeypatch)
        monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "piper"})
        monkeypatch.setattr(tts_tool, "_check_piper_available", lambda: False)
        assert tts_tool.check_tts_requirements() is False
