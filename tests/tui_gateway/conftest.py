"""tui_gateway test fixtures.

Several files here import ``tui_gateway.server`` inside a ``patch.dict("sys.modules", {"hermes_constants":
MagicMock(...)})`` window so the module binds a fixed home. The server's import graph reaches
``agent.process_bootstrap`` → ``hermes_bootstrap``, which is process boot: PM dependency activation reads
the real install root through ``hermes_constants`` and exits the process when that is a MagicMock.
Importing it once here, before any window opens, keeps boot out of the mocked import.

The same graph reaches ``agent.relay_runtime``, whose module-level
``from hermes_constants import get_hermes_home`` must keep the REAL resolver: the observability
lifecycle hook calls ``current_profile_key()`` long after the window closed, and a MagicMock-bound
resolver crashes on ``.expanduser()``. Pre-import it here for the same reason.
"""

import agent.relay_runtime  # pre-window binding; see docstring
import hermes_bootstrap
