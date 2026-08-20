import pytest

from src.amphi_agent._browser import (
    EmbeddedBrowserUnavailableError,
    _EmbeddedSessionTabs,
    _EmbeddedTargetAttachTimeout,
)
from tests.agent.browser._harness import BrowserHarness


async def test_session_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final browser ownership:

    {
      "session-a": "one reusable client, then close/reopen/release",
      "session-b": "independent until host shutdown",
      "electron": "only the owning Session surface is released"
    }

    Checks:
    1. Session handles are stable and lazy until their first browser operation.
    2. Repeated operations reuse one client while a sibling Session gets another client.
    3. Closing releases and can reopen only that Session without interrupting its sibling.
    4. Explicit release invalidates the selected handle and leaves its sibling usable.
    5. Host shutdown drains remaining surfaces and rejects future browser handles.
    """
    harness = BrowserHarness(monkeypatch)
    controller = await harness.register("desktop", "generation-1")
    session_a = harness.host.for_session("session-a")

    # Check 1: Session handles are stable and lazy until their first browser operation.
    assert harness.host.for_session("session-a") is session_a
    assert await session_a.state() is None
    assert harness.clients == []
    assert controller.ensured == []
    assert controller.listed == ["session-a"]

    assert await session_a.invoke("get_current_page_info") == "page:session-a"
    first_a = harness.client("session-a")
    assert await session_a.invoke("get_current_page_info") == "page:session-a"

    session_b = harness.host.for_session("session-b")
    assert await session_b.invoke("get_current_page_info") == "page:session-b"
    first_b = harness.client("session-b")

    # Check 2: Repeated operations reuse one client while a sibling Session gets another client.
    assert harness.client("session-a") is first_a
    assert first_b is not first_a
    assert controller.ensured == ["session-a", "session-b"]
    assert harness.prepare_calls == 1

    assert await session_a.close() is True
    assert controller.released == ["session-a"]
    assert first_a._closing is True
    assert first_b._closing is False
    assert await session_b.invoke("get_current_page_info") == "page:session-b"
    assert await session_a.invoke("get_current_page_info") == "page:session-a"
    reopened_a = harness.client("session-a")

    # Check 3: Closing releases and can reopen only that Session without interrupting its sibling.
    assert reopened_a is not first_a
    assert controller.ensured == ["session-a", "session-b", "session-a"]

    await harness.host.release_sessions(["session-a", "session-a"])

    # Check 4: Explicit release invalidates the selected handle and leaves its sibling usable.
    assert controller.released == ["session-a", "session-a"]
    with pytest.raises(RuntimeError, match="released"):
        await session_a.invoke("get_current_page_info")
    assert await session_b.invoke("get_current_page_info") == "page:session-b"

    await harness.host.shutdown()

    # Check 5: Host shutdown drains remaining surfaces and rejects future browser handles.
    assert first_b._closing is True
    assert controller.released == ["session-a", "session-a", "session-b"]
    with pytest.raises(RuntimeError, match="shut down"):
        harness.host.for_session("session-c")


async def test_restart_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    """Restarted host cleanup:

    {
      "local_handle": null,
      "electron_surface": "released"
    }

    Checks:
    1. Releasing a Session after restart removes its surviving Electron surface.
    2. Cleanup completes without creating a local browser client.
    """
    harness = BrowserHarness(monkeypatch)
    controller = await harness.register("desktop", "generation-1")
    session_id = "survived-restart"
    target_id = "target-survived-restart"
    controller.surfaces[session_id] = _EmbeddedSessionTabs(
        active_target_id=target_id,
        target_ids=frozenset({target_id}),
        state=None,
    )

    await harness.host.release_sessions([session_id])

    # Check 1: The Session's surviving Electron surface is gone after cleanup.
    assert controller.released == [session_id]
    assert session_id not in controller.surfaces

    # Check 2: Restart cleanup does not construct a local browser client.
    assert harness.clients == []


async def test_controller_replacement(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final controller binding:

    {
      "old": {"client": "disconnected", "unregister": false},
      "replacement": {"client": "connected", "active": true},
      "missing_controller": "browser unavailable"
    }

    Checks:
    1. A new Electron generation invalidates the old local client on the next operation.
    2. Unregistering an old controller id cannot remove or damage its replacement.
    3. The existing Session handle reconnects through the replacement controller.
    4. Removing the active controller produces the controlled unavailable error.
    """
    harness = BrowserHarness(monkeypatch)
    original = await harness.register("desktop-old", "generation-1")
    handle = harness.host.for_session("session-a")
    assert await handle.invoke("get_current_page_info") == "page:session-a"
    old_client = harness.client("session-a")

    replacement = await harness.register("desktop-new", "generation-2")
    assert old_client._closing is False
    assert await handle.invoke("get_current_page_info") == "page:session-a"
    new_client = harness.client("session-a")

    # Check 1: A new Electron generation invalidates the old local client on the next operation.
    assert old_client._closing is True
    assert new_client is not old_client

    # Check 2: Unregistering an old controller id cannot remove or damage its replacement.
    assert await harness.host.unregister_controller("desktop-old") is False
    assert harness.host.controller_status()["controller_id"] == "desktop-new"
    assert await handle.invoke("get_current_page_info") == "page:session-a"
    assert harness.client("session-a") is new_client

    # Check 3: The existing Session handle reconnects through the replacement controller.
    assert original.ensured == ["session-a"]
    assert replacement.ensured == ["session-a"]
    assert replacement.health_calls == 1

    assert await harness.host.unregister_controller("desktop-new") is True

    # Check 4: Removing the active controller produces the controlled unavailable error.
    with pytest.raises(EmbeddedBrowserUnavailableError, match="desktop app is not running"):
        await handle.invoke("get_current_page_info")


async def test_sync_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final browser invocation recovery:

    {
      "tab_sync": "Electron inventory is checked before each operation",
      "late_target": "stale client disconnected, operation retried once",
      "controller_loss": "connection invalidated, health checked before reconnect"
    }

    Checks:
    1. A public browser operation synchronizes the embedded Session inventory.
    2. A late target attachment replaces the stale client and completes the operation.
    3. Controller loss disconnects the client and requires a fresh health check.
    """
    harness = BrowserHarness(monkeypatch)
    controller = await harness.register("desktop", "generation-1")
    handle = harness.host.for_session("session-a")
    assert await handle.invoke("get_current_page_info") == "page:session-a"
    first = harness.client("session-a")

    # Check 1: Public invocation synchronizes the Electron-owned tab inventory.
    assert first._embedded is True
    assert first.sync_calls == 1
    assert len(first.synced_tabs) == 1
    assert controller.listed == ["session-a"]

    first.sync_errors.append(_EmbeddedTargetAttachTimeout("target is still attaching"))
    assert await handle.invoke("get_current_page_info") == "page:session-a"
    second = harness.client("session-a")

    # Check 2: One attachment timeout reconnects and transparently retries the operation.
    assert first._closing is True
    assert first._embedded is False
    assert second is not first
    assert second.sync_calls == 1
    assert controller.ensured == ["session-a", "session-a"]

    second.sync_errors.append(EmbeddedBrowserUnavailableError("controller lost"))
    with pytest.raises(EmbeddedBrowserUnavailableError, match="controller lost"):
        await handle.invoke("get_current_page_info")
    assert await handle.invoke("get_current_page_info") == "page:session-a"
    third = harness.client("session-a")

    # Check 3: Controller loss invalidates the connection before a later reconnect.
    assert second._closing is True
    assert second._embedded is False
    assert third is not second
    assert third.sync_calls == 1
    assert controller.health_calls == 2
