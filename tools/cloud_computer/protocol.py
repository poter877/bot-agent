"""Provider-independent Hono cloud computer wire shapes."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CloudWire(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CloudCapabilities(CloudWire):
    actions: list[Literal["click", "move", "drag", "type", "key", "scroll"]]
    capture: bool


class CloudComputer(CloudWire):
    id: str
    state: Literal["starting", "running", "stopping", "stopped", "error"]
    generation: int = Field(ge=0)
    width: int = Field(ge=1, le=8192)
    height: int = Field(ge=1, le=8192)
    capabilities: CloudCapabilities
    error: str | None


class CloudLease(CloudWire):
    holder: Literal["agent", "human"]
    epoch: int = Field(ge=0)
    expiresAt: str | None


class CloudSnapshot(CloudWire):
    enabled: bool
    computer: CloudComputer | None
    lease: CloudLease


class CloudAcquire(CloudSnapshot):
    viewerToken: str


class CloudImage(CloudWire):
    mediaType: Literal["image/png"]
    data: str
    width: int = Field(ge=1, le=8192)
    height: int = Field(ge=1, le=8192)


class CloudResult(CloudWire):
    computerGeneration: int = Field(ge=0)
    leaseEpoch: int = Field(ge=0)


class CloudCapture(CloudResult):
    image: CloudImage


class CloudActionResult(CloudResult):
    ok: Literal[True]


class CloudClickArgs(CloudWire):
    x: int = Field(ge=0, le=8191)
    y: int = Field(ge=0, le=8191)
    button: Literal["left", "middle", "right"] = "left"
    clicks: int = Field(default=1, ge=1, le=3)


class CloudMoveArgs(CloudWire):
    x: int = Field(ge=0, le=8191)
    y: int = Field(ge=0, le=8191)


class CloudDragArgs(CloudWire):
    fromX: int = Field(ge=0, le=8191)
    fromY: int = Field(ge=0, le=8191)
    toX: int = Field(ge=0, le=8191)
    toY: int = Field(ge=0, le=8191)
    durationMs: int = Field(default=300, ge=100, le=2000)


class CloudTypeArgs(CloudWire):
    text: str = Field(min_length=1, max_length=8000)


class CloudKeyArgs(CloudWire):
    keys: list[str] = Field(min_length=1, max_length=8)

    @field_validator("keys")
    @classmethod
    def valid_keys(cls, keys):
        import re
        if any(not re.fullmatch(r"[A-Za-z0-9_+-]{1,32}", key) for key in keys):
            raise ValueError("Invalid key name")
        return keys


class CloudScrollArgs(CloudWire):
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(ge=1, le=20)
    x: int | None = Field(default=None, ge=0, le=8191)
    y: int | None = Field(default=None, ge=0, le=8191)


_ACTION_PARAMS = {"click": CloudClickArgs, "move": CloudMoveArgs, "drag": CloudDragArgs,
                  "type": CloudTypeArgs, "key": CloudKeyArgs, "scroll": CloudScrollArgs}


class CloudAction(CloudWire):
    action: Literal["click", "move", "drag", "type", "key", "scroll"]
    params: CloudClickArgs | CloudMoveArgs | CloudDragArgs | CloudTypeArgs | CloudKeyArgs | CloudScrollArgs

    @field_validator("params", mode="before")
    @classmethod
    def matching_params(cls, params, info):
        kind = _ACTION_PARAMS.get(info.data.get("action"))
        return kind.model_validate(params) if kind is not None else params
