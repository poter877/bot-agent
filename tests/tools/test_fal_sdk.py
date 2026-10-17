"""The ``import_fal_client`` adapter against the installed SDK."""
import pytest

fal_client = pytest.importorskip("fal_client")

from tools.fal_common import import_fal_client


@pytest.mark.parametrize("failure", [None, ImportError("external SDK"), RuntimeError("PM acquisition failed")])
def test_import_adapter_keeps_pm_failure_policy(monkeypatch, failure):
    import pm
    calls = []

    def ensure(feature):
        calls.append(feature)
        if failure:
            raise failure

    monkeypatch.setattr(pm, "ensure_import", ensure)
    if isinstance(failure, RuntimeError):
        with pytest.raises(ImportError, match="PM acquisition failed"):
            import_fal_client()
    else:
        assert import_fal_client() is fal_client
    assert calls == ["fal"]


def test_import_adapter_runs_real_pm_availability_without_install(monkeypatch):
    import pm.client
    monkeypatch.setattr(pm.client, "sync_venv", lambda *a, **kw: pytest.fail("available SDK must not install"))
    assert import_fal_client() is fal_client


def test_external_sdk_remains_importable_without_pm(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "pm", None)
    assert import_fal_client() is fal_client
