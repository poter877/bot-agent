"""Hono-only cloud transport, pinned to the account that admitted this local work."""

from pydantic import ValidationError

from account_backend_session import (
    AccountBackendError, account_session_lock, bind_account_request_authority, capture_account_session,
    current_account_request_authority, request_account_backend, require_account_session_binding,
)
from .protocol import CloudAcquire, CloudAction, CloudActionResult, CloudCapture, CloudSnapshot

_PREFIX = "/v1/cloud-computer"


class CloudComputerClient:
    def __init__(self):
        with account_session_lock():
            if (authority := current_account_request_authority()) is not None:
                require_account_session_binding(authority)
            _, self.binding = capture_account_session()
        self.closed = False

    def close(self):
        # Closing one Agent's handle must not stop the account's persistent computer.
        self.closed = True

    def request(self, path, result_type, payload=None):
        if self.closed:
            raise AccountBackendError("This cloud computer client is closed. Start a new request.")
        with bind_account_request_authority(self.binding):
            result = request_account_backend(_PREFIX + path, payload=payload)
        require_account_session_binding(self.binding)
        try:
            return result_type.model_validate(result)
        except ValidationError:
            raise AccountBackendError("The cloud computer returned an invalid response.") from None

    def status(self):
        return self.request("/status", CloudSnapshot)

    def start(self):
        return self.request("/start", CloudSnapshot, {})

    def stop(self):
        return self.request("/stop", CloudSnapshot, {})

    def acquire(self):
        return self.request("/lease/acquire", CloudAcquire, {})

    def renew(self, viewer_token):
        return self.request("/lease/renew", CloudSnapshot, {"viewerToken": viewer_token})

    def release(self, viewer_token):
        return self.request("/lease/release", CloudSnapshot, {"viewerToken": viewer_token})

    def capture(self, *, actor, computer_generation, lease_epoch, viewer_token=None):
        payload = {"actor": actor, "computerGeneration": computer_generation, "leaseEpoch": lease_epoch}
        if viewer_token is not None:
            payload["viewerToken"] = viewer_token
        return self.request("/capture", CloudCapture, payload)

    def action(self, action, params, *, actor, computer_generation, lease_epoch, viewer_token=None):
        operation = CloudAction.model_validate({"action": action, "params": params})
        payload = {**operation.model_dump(exclude_none=True), "actor": actor,
                   "computerGeneration": computer_generation, "leaseEpoch": lease_epoch}
        if viewer_token is not None:
            payload["viewerToken"] = viewer_token
        return self.request("/actions", CloudActionResult, payload)


def running_computer(snapshot):
    if not snapshot.enabled:
        raise AccountBackendError("Cloud computer is not enabled on the company server.")
    computer = snapshot.computer
    if computer is not None and computer.state == "stopped":
        raise AccountBackendError("用户已停止云电脑，请在云电脑页面恢复后重试", 409)
    if computer is None or computer.state != "running":
        raise AccountBackendError("The cloud computer is not running. Start it and retry.", 409)
    return computer
