"""Human cloud desktop RPCs. Infrastructure, ownership and input leases remain in Hono."""

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()


def _cloud_agent_enabled():
    from plugins.computer_use import configured_backend_name
    return configured_backend_name() == "company-cloud"


def _cloud_configure(enabled):
    if enabled or _cloud_agent_enabled():
        _write_config_key("computer_use.backend", "company-cloud" if enabled else "cua")
    return {"enabled": _cloud_agent_enabled(), "appliesTo": "new-sessions"}


def _cloud_rpc(rid, params, operation):
    from account_backend_session import AccountBackendError
    from pydantic import ValidationError
    from tools.cloud_computer.client import CloudComputerClient
    from tools.cloud_computer.protocol import CloudAcquire, CloudActionResult, CloudCapture, CloudSnapshot
    from tui_gateway.contracts.registry import METHODS

    try:
        validated = METHODS[f"cloudComputer.{operation}"].params.model_validate(params)
    except ValidationError:
        return _err(rid, 4000, "Invalid cloud computer parameters.")
    data = validated.model_dump(exclude={"profile"}, exclude_none=True)
    if operation == "configure":
        return _ok(rid, _cloud_configure(data["enabled"]))
    routes = {
        "status": ("/status", CloudSnapshot), "start": ("/start", CloudSnapshot), "stop": ("/stop", CloudSnapshot),
        "capture": ("/capture", CloudCapture), "action": ("/actions", CloudActionResult),
        "lease.acquire": ("/lease/acquire", CloudAcquire), "lease.renew": ("/lease/renew", CloudSnapshot),
        "lease.release": ("/lease/release", CloudSnapshot),
    }
    path, result_type = routes[operation]
    if operation in {"capture", "action"}:
        data["actor"] = "human"
    client = None
    try:
        client = CloudComputerClient()
        result = client.request(path, result_type, None if operation == "status" else data)
        body = result.model_dump()
        if isinstance(result, CloudSnapshot):
            body["agentEnabled"] = _cloud_agent_enabled()
        return _ok(rid, body)
    except AccountBackendError as error:
        return _err(rid, 5301, str(error), data={"httpStatus": error.status_code})
    finally:
        if client is not None:
            client.close()


def _cloud_handler(operation):
    def handler(rid, params):
        return _cloud_rpc(rid, params, operation)
    return handler


for _operation in ("status", "start", "stop", "capture", "action", "lease.acquire", "lease.renew", "lease.release", "configure"):
    _registry.method(f"cloudComputer.{_operation}")(_registry.profile_scoped(_cloud_handler(_operation)))


def register(server):
    bind_module(globals(), server)
