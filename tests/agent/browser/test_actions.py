import asyncio
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.amphi_agent._browser import SessionBrowser, _SessionBrowserClient
from tests._support.sandbox import IsolatedPaths
from tests.agent.browser._harness import BrowserHarness, FakeClient


async def test_action_snapshots(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final action feedback:

    {
      "success": "action result + latest snapshot",
      "unsettled": "action result + bounded warning",
      "failure": "original error + latest snapshot",
      "cancelled": "CancelledError without follow-up capture"
    }

    Checks:
    1. A successful page action settles and returns its canonical follow-up snapshot.
    2. An unsettled page returns the successful action plus an explicit bounded warning.
    3. A failed action includes the settled page snapshot in the raised error.
    4. Cancellation propagates immediately without capturing misleading page state.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("desktop", "generation-1")

    async def prepared_client(session_id: str) -> tuple[SessionBrowser, FakeClient]:
        handle = harness.host.for_session(session_id)
        await handle.invoke("get_current_page_info")
        client = harness.client(session_id)
        client.events.clear()
        return handle, client

    success_handle, success_client = await prepared_client("success")
    success_client.snapshot = "- button Submit [ref=submit]"
    success = await success_handle.invoke("click_element_by_ref", "submit")

    # Check 1: A successful page action settles and returns its canonical follow-up snapshot.
    assert success.startswith("clicked:submit")
    assert "Latest page snapshot bundle after browser action" in success
    assert "button Submit [ref=submit]" in success
    assert [event[0] for event in success_client.events] == [
        "settle_events",
        "click",
        "discard_prefetch",
        "settle_state",
        "snapshot",
    ]

    unsettled_handle, unsettled_client = await prepared_client("unsettled")
    unsettled_client.settle_result = False
    unsettled = await unsettled_handle.invoke("click_element_by_ref", "menu")

    # Check 2: An unsettled page returns the successful action plus an explicit bounded warning.
    assert unsettled.startswith("clicked:menu")
    assert "did not settle safely" in unsettled
    assert "snapshot" not in [event[0] for event in unsettled_client.events]

    failed_handle, failed_client = await prepared_client("failure")
    failed_client.action_error = ValueError("click failed")
    failed_client.snapshot = "- dialog Error [ref=dialog]"

    # Check 3: A failed action includes the settled page snapshot in the raised error.
    with pytest.raises(ValueError) as caught:
        await failed_handle.invoke("click_element_by_ref", "broken")
    assert "click failed" in str(caught.value)
    assert "dialog Error [ref=dialog]" in str(caught.value)

    cancelled_handle, cancelled_client = await prepared_client("cancelled")
    cancelled_client.action_error = asyncio.CancelledError()

    # Check 4: Cancellation propagates immediately without capturing misleading page state.
    with pytest.raises(asyncio.CancelledError):
        await cancelled_handle.invoke("click_element_by_ref", "cancel")
    assert [event[0] for event in cancelled_client.events] == [
        "settle_events",
        "click",
    ]


async def test_oversized_snapshot(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Oversized snapshot delivery:

    {
      "inline": "bounded actionable refs + exact full-file pointer",
      "file": "complete page snapshot below its Session tool-results directory",
      "sibling_session": "different tool-results directory"
    }

    Checks:
    1. Each Session binds its browser client to a different resolved result root.
    2. An oversized snapshot writes the complete page state below its Session root.
    3. The returned text retains a bounded actionable preview, file pointer, and truncation notice.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("desktop", "generation-1")
    root_a = test_sandbox.sessions / "session-a" / "tool-results"
    root_b = test_sandbox.sessions / "session-b" / "tool-results"
    handle_a = harness.host.for_session("session-a", tool_result_dir=root_a)
    handle_b = harness.host.for_session("session-b", tool_result_dir=root_b)
    await handle_a.invoke("get_current_page_info")
    await handle_b.invoke("get_current_page_info")

    # Check 1: Sibling Sessions bind their clients to distinct resolved result roots.
    assert harness.client("session-a").snapshot_output_dir == root_a.resolve()
    assert harness.client("session-b").snapshot_output_dir == root_b.resolve()
    assert root_a.resolve() != root_b.resolve()

    client = _SessionBrowserClient(snapshot_output_dir=root_a)
    client._page = SimpleNamespace(url="https://example.test")
    client._snapshot_generator = SimpleNamespace(INTERACTIVE_ROLES={"button", "link", "textbox"})
    first_ref = '- button "Submit" [ref=submit]'
    oversized_ref = f'- link "{"Details " * 20}" [ref=details]'
    last_ref = '- textbox "Email" [ref=email]'
    tree = "\n".join((first_ref, oversized_ref, "content " * 2_000, last_ref))
    snapshot = SimpleNamespace(
        tree=tree,
        refs={
            "submit": SimpleNamespace(role="button"),
            "details": SimpleNamespace(role="link"),
            "email": SimpleNamespace(role="textbox"),
        },
    )

    async def get_snapshot(interactive: bool = False, full_page: bool = True) -> SimpleNamespace:
        del interactive, full_page
        client._last_snapshot = snapshot
        return snapshot

    async def get_title(page: SimpleNamespace) -> str:
        del page
        return "Example"

    monkeypatch.setattr(client, "get_snapshot", get_snapshot)
    monkeypatch.setattr(client, "_get_page_title", get_title)
    rendered = await client.get_snapshot_text(limit=64)
    pointer = re.search(r"saved to: (.+)", rendered)
    assert pointer is not None
    path = Path(pointer.group(1))
    saved = path.read_text(encoding="utf-8")

    # Check 2: The complete oversized state is saved below this Session's result root.
    assert path.is_relative_to(root_a.resolve())
    assert saved == f"[Page: https://example.test | Example]\n{tree}"
    assert all(marker in saved for marker in ("[ref=submit]", "[ref=details]", "[ref=email]"))

    # Check 3: The inline result points to the file and retains a bounded actionable preview.
    inline_refs = [line for line in rendered.splitlines() if "[ref=" in line]
    assert str(path) in rendered
    assert inline_refs
    assert len("\n".join(inline_refs)) <= 64
    assert "Actionable preview truncated" in rendered
