"""Shared FAL.ai SDK plumbing: lazy import.

``import_fal_client`` does the lazy import + ``pm.ensure_import`` so
``fal_client`` isn't pulled at cold start (it added ~64 ms per CLI
invocation when imported eagerly).

Stateful pieces (cache globals, ``_submit_fal_request``) intentionally stay on
:mod:`tools.image_generation_tool`. That module is the patch target for
existing test suites (``tests/tools/test_image_generation.py``) and for the
``plugins/image_gen/fal/`` plugin's ``_it`` indirection — moving the
caches here would silently defeat ``monkeypatch.setattr(image_tool, ...)``
because the lookups would go against ``fal_common``'s namespace instead.
See the per-rule walkthrough at issue #26241 for details.
"""

from __future__ import annotations

from typing import Any


def import_fal_client() -> Any:
    """Import ``fal_client`` (via ``pm`` when available) and return
    the module reference.

    Callers cache the result on their own module global so tests can monkeypatch it.
    """
    try:
        from pm import ensure_import as _lazy_ensure
    except ImportError:
        # pm itself unavailable (externally-managed env, partial install) —
        # the plain import below is the authority on availability.
        pass
    else:
        try:
            _lazy_ensure("fal")
        except ImportError:
            pass  # same authority rule: let the plain import decide
        except Exception as exc:
            raise ImportError(str(exc))
    import fal_client  # type: ignore  # noqa: WPS433 — intentionally lazy
    return fal_client
