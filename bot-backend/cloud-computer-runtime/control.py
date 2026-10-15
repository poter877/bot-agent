"""One fixed JSON command over stdin; no HTTP listener or worker secret in the desktop container."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import time

MAX_TEXT = 16_384
_deadline = 0.0


def remaining() -> float:
    budget = _deadline - time.monotonic()
    if budget <= 0:
        raise TimeoutError("Desktop command expired")
    return budget


def run(args: list[str], *, input_bytes: bytes | None = None) -> bytes:
    return subprocess.run(args, input=input_bytes, capture_output=True,
                          timeout=min(15, remaining()), check=True).stdout


def integer(value, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError("Invalid coordinate or count")
    return value


def capture() -> dict:
    fd, filename = tempfile.mkstemp(prefix="cloud-screen-", suffix=".png")
    os.close(fd)
    path = Path(filename)
    try:
        run(["scrot", "--silent", "--overwrite", str(path)])
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("Screenshot exceeds the capture limit")
        data = path.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("Screenshot was not a PNG")
        width, height = struct.unpack(">II", data[16:24])
        return {"image": {"mediaType": "image/png", "data": base64.b64encode(data).decode("ascii"),
                          "width": width, "height": height}}
    finally:
        path.unlink(missing_ok=True)


def coordinates(command: dict, x_key: str = "x", y_key: str = "y") -> tuple[int, int]:
    width = int(os.environ.get("CLOUD_DESKTOP_WIDTH", "1440"))
    height = int(os.environ.get("CLOUD_DESKTOP_HEIGHT", "900"))
    return integer(command.get(x_key), 0, width - 1), integer(command.get(y_key), 0, height - 1)


def move(command: dict) -> None:
    x, y = coordinates(command)
    run(["xdotool", "mousemove", "--sync", str(x), str(y)])


def click(command: dict) -> None:
    x, y = coordinates(command)
    button = {"left": "1", "middle": "2", "right": "3"}.get(command.get("button", "left"))
    if button is None:
        raise ValueError("Invalid mouse button")
    count = integer(command.get("clicks", 1), 1, 3)
    run(["xdotool", "mousemove", "--sync", str(x), str(y), "click", "--repeat", str(count), "--delay", "100", button])


def type_text(command: dict) -> None:
    text = command.get("text")
    if not isinstance(text, str) or len(text) > MAX_TEXT or "\0" in text:
        raise ValueError("Invalid text")
    # Clipboard paste preserves Unicode. Text is stdin, never executable arguments or a shell command.
    subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode(),
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=min(5, remaining()), check=True)
    run(["xdotool", "key", "--clearmodifiers", "ctrl+v"])


def key(command: dict) -> None:
    keys = command.get("keys")
    if not isinstance(keys, list) or not 1 <= len(keys) <= 8:
        raise ValueError("Invalid key combination")
    normalized = []
    for item in keys:
        if not isinstance(item, str):
            raise ValueError("Invalid key")
        item = {"+": "plus", "-": "minus"}.get(item, item)
        if not re.fullmatch(r"[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+){0,5}", item) or len(item) > 32:
            raise ValueError("Invalid key")
        normalized.append(item)
    run(["xdotool", "key", "--clearmodifiers", "+".join(normalized)])


def drag(command: dict) -> None:
    x, y = coordinates(command, "fromX", "fromY")
    end_x, end_y = coordinates(command, "toX", "toY")
    duration = integer(command.get("durationMs", 300), 100, 2000) / 1000
    run(["xdotool", "mousemove", "--sync", str(x), str(y), "mousedown", "1"])
    try:
        for step in range(1, 11):
            time.sleep(min(duration / 10, remaining()))
            run(["xdotool", "mousemove", "--sync", str(round(x + (end_x - x) * step / 10)),
                 str(round(y + (end_y - y) * step / 10))])
    finally:
        # Release a held button before the worker's owner barrier opens, even when the drag expires.
        subprocess.run(["xdotool", "mouseup", "1"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=0.3, check=True)


def scroll(command: dict) -> None:
    if "x" in command or "y" in command:
        move(command)
    button = {"up": "4", "down": "5", "left": "6", "right": "7"}.get(command.get("direction"))
    if button is None:
        raise ValueError("Invalid scroll direction")
    count = integer(command.get("amount", 3), 1, 20)
    run(["xdotool", "click", "--repeat", str(count), "--delay", "40", button])


def main() -> None:
    global _deadline
    raw = sys.stdin.buffer.read(65_537)
    if len(raw) > 65_536:
        raise ValueError("Command exceeds the input limit")
    command = json.loads(raw)
    if not isinstance(command, dict):
        raise ValueError("Command must be an object")
    deadline = command.get("deadlineAt")
    if isinstance(deadline, bool) or not isinstance(deadline, (float, int)):
        raise ValueError("Command requires an absolute deadline")
    _deadline = time.monotonic() + min(4.5, deadline / 1000 - time.time())
    remaining()
    action = command.get("action")
    if action == "screenshot":
        result = capture()
    elif action == "status":
        run(["xdpyinfo", "-display", os.environ.get("DISPLAY", ":20")])
        result = {"ok": True}
    else:
        handlers = {"click": click, "move": move, "drag": drag, "type": type_text, "key": key, "scroll": scroll}
        handler = handlers.get(action)
        if handler is None:
            raise ValueError("Unsupported action")
        params = command.get("params")
        if not isinstance(params, dict):
            raise ValueError("Action params must be an object")
        handler(params)
        result = {"ok": True}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
