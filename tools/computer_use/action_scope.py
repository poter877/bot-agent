"""Default computer-use control scope for providers driving this profile's local desktop."""

from contextlib import contextmanager


@contextmanager
def local_action_scope():
    from tools.bot_desktop import lease, runtime

    admitted = lease.assert_agent_may_act()
    runtime.ensure_started_for_tool()

    def fence():
        if lease.get().epoch != admitted.epoch:
            raise lease.HumanHasControl(
                "A human took over this desktop while the action ran; its result was discarded. "
                "Tell the user what you need and re-capture once they hand back.")

    yield fence
