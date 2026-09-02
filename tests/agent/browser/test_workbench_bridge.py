import json

import pytest

from src.amphi_agent._browser import EmbeddedBrowserUnavailableError
from tests.agent.browser._harness import BrowserHarness

WORKBENCH_URL = "http://127.0.0.1:5100/ab12/univer/"


async def test_workbench_bridge_call_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final sheet-bridge exchange:

    {
      "sent": {"method": "readRange", "args": ["A1:B2", null]},
      "received": [["a", null]],
      "target": "the sheet workbench, not the active browser tab",
      "snapshot_taken": false
    }

    Checks:
    1. The call reaches the page as one evaluated expression naming the method
       and its arguments.
    2. It is evaluated against the workbench's own target, so a person reading a
       browser tab is not interrupted.
    3. The page's JSON reply is returned as a structured value.
    4. No page snapshot is captured — the reason this path exists at all.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("controller-1", "generation-1", workbench_url=WORKBENCH_URL)
    browser = harness.host.for_session("session-1")

    # The client only exists after the first call, so script its reply after it.
    await browser.call_workbench_bridge("sheet", "status")
    client = harness.client("session-1")
    client.evaluate_reply = json.dumps({"ok": True, "value": [["a", None]]})

    result = await browser.call_workbench_bridge("sheet", "readRange", ["A1:B2", None])

    # Check 1: the method and its arguments are embedded in the evaluated code.
    assert '"readRange"' in client.evaluated[-1]
    assert '["A1:B2", null]' in client.evaluated[-1]
    # Check 2: the evaluation is aimed at the workbench target.
    assert client.evaluated_targets[-1] == "workbench-session-1-sheet"
    # Check 3: the reply is parsed rather than returned as text.
    assert result == [["a", None]]
    # Check 4: nothing asked the page for an accessibility snapshot.
    assert not any(event[0] == "snapshot" for event in client.events)


async def test_opening_a_workbench_does_not_present_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final workbench state:

    {"opened": {"kind": "doc", "create": true}, "browser_tab_navigated": false}

    Checks:
    1. Opening asks the App to create that Session's workbench page.
    2. The name and language the agent chose travel with the request.
    3. Nothing navigates a browser tab, so the person keeps whatever they were
       reading.
    """
    harness = BrowserHarness(monkeypatch)
    probe = await harness.register("controller-1", "generation-1", workbench_url=WORKBENCH_URL)
    browser = harness.host.for_session("session-1")

    await browser.open_workbench("doc", language="zh", name="Weekly Notes")

    # Checks 1 and 2: one create request carrying the agent's choices.
    assert probe.workbenches == [("session-1", "doc", True, "zh", "Weekly Notes")]
    # Check 3: no client was started to drive a tab.
    assert harness.clients == []


async def test_working_in_a_closed_workbench_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final workbench state:

    {"create_requested": false}

    Checks:
    1. A call that is not an open asks for the existing workbench only, so a
       workbench the person closed is reported rather than silently recreated.
    """
    harness = BrowserHarness(monkeypatch)
    probe = await harness.register("controller-1", "generation-1", workbench_url=WORKBENCH_URL)
    browser = harness.host.for_session("session-1")

    await browser.call_workbench_bridge("sheet", "status")

    # Check 1: the lookup never carries `create`.
    assert probe.workbenches == [("session-1", "sheet", False, "en", "Untitled")]


async def test_workbench_bridge_surfaces_page_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final sheet-bridge failures:

    {"refusal": "a person is editing", "unreadable": "reopen the workbench",
     "wrong_workbench": "which has no writeRange"}

    Checks:
    1. A refusal from the page becomes an error carrying the page's own reason.
    2. A reply that is not the expected JSON envelope names the recovery step.
    3. Calling a method the open workbench does not have says which one is open.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("controller-1", "generation-1", workbench_url=WORKBENCH_URL)
    browser = harness.host.for_session("session-1")
    await browser.call_workbench_bridge("sheet", "status")
    client = harness.client("session-1")

    # Check 1: the page's refusal reaches the caller verbatim.
    client.evaluate_reply = json.dumps({"ok": False, "error": "a person is editing a cell"})
    with pytest.raises(RuntimeError, match="a person is editing a cell"):
        await browser.call_workbench_bridge("sheet", "writeRange", ["A1", [["x"]], None])

    # Check 2: a non-envelope reply is reported as needing a reopen.
    client.evaluate_reply = "undefined"
    with pytest.raises(RuntimeError, match="reopen the workbench"):
        await browser.call_workbench_bridge("sheet", "status")

    # Check 3: a call for the other workbench is answered by the open one's kind.
    client.evaluate_reply = json.dumps(
        {"ok": False, "error": "the open workbench is a document, which has no writeRange"},
    )
    with pytest.raises(RuntimeError, match="which has no writeRange"):
        await browser.call_workbench_bridge("sheet", "writeRange", ["A1", [["x"]], None])


async def test_workbench_needs_an_app_that_serves_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final workbench availability:

    {"with_workbench_url": true, "without": "explained, not attempted"}

    Checks:
    1. A controller that registered a workbench base reports it as available.
    2. An App that registered none explains that instead of failing obscurely.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("controller-1", "generation-1", workbench_url=WORKBENCH_URL)
    browser = harness.host.for_session("session-1")

    # Check 1: the registration is what makes the workbenches reachable.
    assert harness.host.controller_status()["workbench_available"] is True
    await browser.open_workbench("sheet")

    # Check 2: an older App without the workbenches is reported as unavailable.
    await harness.register("controller-2", "generation-2")
    assert harness.host.controller_status()["workbench_available"] is False
    with pytest.raises(EmbeddedBrowserUnavailableError, match="workbench is unavailable"):
        await browser.open_workbench("sheet")
