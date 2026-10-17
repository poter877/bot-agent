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


@pytest.mark.parametrize("timeout,expected", [(None, 120.0), (300.0, 300.0)])
def test_older_sdk_timeout_default_and_optional_hint(transport, monkeypatch, timeout, expected):
    monkeypatch.setattr(fal_client.client, "add_hint_header", None)
    client = _ManagedFalSyncClient(fal_client, key="token", queue_run_origin="https://queue.test")
    # Keep its real HTTP client and request helpers, vary only older SDK metadata.
    client._sync_client = SimpleNamespace(**({} if timeout is None else {"default_timeout": timeout}))
    transport[1].append(accepted())
    assert client.submit("app", {}, hint="ignored-on-old-sdk").request_id == "r1"
    assert transport[0][0].extensions["timeout"]["read"] == expected
    assert "x-fal-runner-hint" not in transport[0][0].headers
