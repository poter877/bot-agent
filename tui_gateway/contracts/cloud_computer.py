"""Account-owned cloud desktop, human viewing/control, and next-session Agent selection."""

from typing import Literal

from pydantic import Field

from tools.cloud_computer.protocol import CloudAction, CloudActionResult, CloudCapture, CloudSnapshot
from .base import Result
from .common import ProfileParams
from .registry import method


class CloudComputerSnapshot(CloudSnapshot, Result):
    agentEnabled: bool


class CloudComputerCaptureParams(ProfileParams):
    computerGeneration: int = Field(ge=0)
    leaseEpoch: int = Field(ge=0)
    viewerToken: str | None = None


class CloudComputerCaptureResult(CloudCapture, Result):
    pass


class CloudComputerActionParams(CloudAction, CloudComputerCaptureParams):
    viewerToken: str = Field(min_length=1)


class CloudComputerActionResult(CloudActionResult, Result):
    pass


class CloudComputerAcquireResult(CloudComputerSnapshot):
    viewerToken: str


class CloudComputerLeaseParams(ProfileParams):
    viewerToken: str = Field(min_length=1)


class CloudComputerConfigureParams(ProfileParams):
    enabled: bool


class CloudComputerConfigureResult(Result):
    enabled: bool
    appliesTo: Literal["new-sessions"]


for name in ("status", "start", "stop"):
    method(f"cloudComputer.{name}", params=ProfileParams, result=CloudComputerSnapshot,
           doc=f"{name.title()} the authenticated account's cloud computer.")
method("cloudComputer.capture", params=CloudComputerCaptureParams, result=CloudComputerCaptureResult,
       doc="Human viewer screenshot; Agent screenshots use the cloud provider's lease checks.")
method("cloudComputer.action", params=CloudComputerActionParams, result=CloudComputerActionResult,
       doc="Human input while holding this account's cloud computer lease.")
method("cloudComputer.lease.acquire", params=ProfileParams, result=CloudComputerAcquireResult,
       doc="Take over the cloud computer; returned viewerToken stays in the UI's memory.")
for name in ("release", "renew"):
    method(f"cloudComputer.lease.{name}", params=CloudComputerLeaseParams, result=CloudComputerSnapshot,
           doc=f"{name.title()} the current human viewer's lease.")
method("cloudComputer.configure", params=CloudComputerConfigureParams, result=CloudComputerConfigureResult,
       doc="Select cloud computer control for new Agent sessions without changing live sessions.")
