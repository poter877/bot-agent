"""The computer-use ABC over the authenticated company API; no local desktop fallback."""

import base64

from tools.cloud_computer.client import CloudComputerClient
from tools.cloud_computer.control import agent_target
from tools.computer_use.backend import ActionResult, CaptureResult, ComputerUseBackend, image_dimensions_from_bytes


def _unsupported(action):
    return ActionResult(ok=False, action=action, code="unsupported_action",
                        message="This cloud computer supports full-screen screenshots and pixel-based input.")


class CompanyCloudBackend(ComputerUseBackend):
    _last_app = "screen"

    def __init__(self):
        self.client = CloudComputerClient()

    def start(self):
        pass  # The provider's action scope starts the account computer when necessary.

    def stop(self):
        self.client.close()

    def is_available(self):
        return not self.client.closed

    def capture(self, mode="som", app=None, pid=None, window_id=None):
        if mode == "ax" or app not in (None, "", "screen") or pid is not None or window_id is not None:
            raise ValueError("Cloud computer supports full-screen vision capture; use mode='vision' without an app target.")
        computer, lease = agent_target(self.client)
        result = self.client.capture(actor="agent", computer_generation=computer.generation, lease_epoch=lease.epoch)
        raw = base64.b64decode(result.image.data, validate=True)
        if len(raw) > 16 * 1024 * 1024 or image_dimensions_from_bytes(raw) != (result.image.width, result.image.height):
            raise ValueError("Cloud computer screenshot dimensions or size are invalid.")
        return CaptureResult(mode="vision", width=result.image.width, height=result.image.height,
                             png_b64=result.image.data, png_bytes_len=len(raw), image_mime_type=result.image.mediaType,
                             app="screen", note="Account cloud computer; use screenshot pixel coordinates. "
                             "Accessibility elements are unavailable. Terminal and file tools still use their own configured environment.")

    def _action(self, action, params):
        computer, lease = agent_target(self.client)
        self.client.action(action, params, actor="agent", computer_generation=computer.generation, lease_epoch=lease.epoch)
        return ActionResult(ok=True, action=action, path="company-cloud", message="Cloud computer input delivered.")

    def click(self, *, element=None, x=None, y=None, button="left", click_count=1, modifiers=None, **_):
        if element is not None or modifiers or x is None or y is None:
            return _unsupported("click")
        return self._action("click", {"x": x, "y": y, "button": button, "clicks": click_count})

    def drag(self, *, from_element=None, to_element=None, from_xy=None, to_xy=None, button="left", modifiers=None, **_):
        if from_element is not None or to_element is not None or not from_xy or not to_xy or button != "left" or modifiers:
            return _unsupported("drag")
        return self._action("drag", {"fromX": from_xy[0], "fromY": from_xy[1], "toX": to_xy[0], "toY": to_xy[1]})

    def scroll(self, *, direction, amount=3, element=None, x=None, y=None, modifiers=None, **_):
        if element is not None or modifiers:
            return _unsupported("scroll")
        return self._action("scroll", {"direction": direction, "amount": amount, "x": x, "y": y})

    def type_text(self, text, **_):
        return self._action("type", {"text": text})

    def key(self, keys, **_):
        aliases = {"cmd": "Super_L", "command": "Super_L", "option": "Alt_L", "control": "ctrl",
                   "return": "Return", "enter": "Return", "escape": "Escape", "space": "space", "tab": "Tab",
                   "backspace": "BackSpace", "delete": "Delete", "up": "Up", "down": "Down", "left": "Left", "right": "Right"}
        parts = keys.replace("-", "+").split("+")
        return self._action("key", {"keys": [aliases.get(part.lower(), part) for part in parts]})

    def list_apps(self):
        return []

    def list_windows(self):
        return []

    def focus_app(self, app, raise_window=False):
        return _unsupported("focus_app")

    def set_value(self, value, element=None):
        return _unsupported("set_value")
