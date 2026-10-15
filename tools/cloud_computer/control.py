"""Remote lease fence shared by one Agent tool call and its optional follow-up screenshot."""

from contextlib import contextmanager
from contextvars import ContextVar

from tools.bot_desktop.lease import HumanHasControl
from .client import CloudComputerClient, running_computer

_admission = ContextVar("cloud_computer_admission", default=None)


def agent_target(client):
    current = _admission.get()
    snapshot = current[1] if current is not None else client.status()
    computer = running_computer(snapshot)
    if snapshot.lease.holder != "agent":
        raise HumanHasControl("A human controls the cloud computer. Wait until they hand control back.")
    return computer, snapshot.lease


@contextmanager
def cloud_action_scope():
    client = CloudComputerClient()
    try:
        snapshot = client.status()
        if snapshot.enabled and snapshot.computer is None:
            snapshot = client.start()
        computer = running_computer(snapshot)
        if snapshot.lease.holder != "agent":
            raise HumanHasControl("A human controls the cloud computer. Wait until they hand control back.")

        def fence():
            latest = client.status()
            target = running_computer(latest)
            if (target.id, target.generation, latest.lease.epoch, latest.lease.holder) != (
                    computer.id, computer.generation, snapshot.lease.epoch, "agent"):
                raise HumanHasControl("Cloud computer control changed while the action ran. Its result was discarded.")

        token = _admission.set((client, snapshot))
        try:
            yield fence
        finally:
            _admission.reset(token)
    finally:
        client.close()
