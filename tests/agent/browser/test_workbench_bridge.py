import json

import pytest

from src.amphi_agent._browser import EmbeddedBrowserUnavailableError
from tests.agent.browser._harness import BrowserHarness

WORKBENCH_URL = "http://127.0.0.1:5100/ab12/univer/"
SHEET_PAGE = f"{WORKBENCH_URL}sheet/index.html"


async def test_workbench_bridge_call_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final sheet-bridge exchange:

    {
      "sent": {"method": "readRange", "args": ["A1:B2", null]},
      "received": [["a", null]],
      "snapshot_taken": false
    }

    Checks:
    1. The call reaches the page as one evaluated expression naming the method
       and its arguments.
    2. The page's JSON reply is returned as a structured value.
    3. No page snapshot is captured — the reason this path exists at all.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("controller-1", "generation-1", workbench_url=WORKBENCH_URL)
    browser = harness.host.for_session("session-1")

    # The client only exists after the first call, so script its reply after it.
    await browser.call_workbench_bridge("status")
    client = harness.client("session-1")
    client.evaluate_reply = json.dumps({"ok": True, "value": [["a", None]]})

    result = await browser.call_workbench_bridge("readRange", ["A1:B2", None])

    # Check 1: the method and its arguments are embedded in the evaluated code.
    assert '"readRange"' in client.evaluated[-1]
    assert '["A1:B2", null]' in client.evaluated[-1]
    # Check 2: the reply is parsed rather than returned as text.
    assert result == [["a", None]]
    # Check 3: nothing asked the page for an accessibility snapshot.
    assert not any(event[0] == "snapshot" for event in client.events)


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
    await browser.call_workbench_bridge("status")
    client = harness.client("session-1")

    # Check 1: the page's refusal reaches the caller verbatim.
    client.evaluate_reply = json.dumps({"ok": False, "error": "a person is editing a cell"})
    with pytest.raises(RuntimeError, match="a person is editing a cell"):
        await browser.call_workbench_bridge("writeRange", ["A1", [["x"]], None])

    # Check 2: a non-envelope reply is reported as needing a reopen.
    client.evaluate_reply = "undefined"
    with pytest.raises(RuntimeError, match="reopen the workbench"):
        await browser.call_workbench_bridge("status")

    # Check 3: a call for the other workbench is answered by the open one's kind.
    client.evaluate_reply = json.dumps(
        {"ok": False, "error": "the open workbench is a document, which has no writeRange"},
    )
    with pytest.raises(RuntimeError, match="which has no writeRange"):
        await browser.call_workbench_bridge("writeRange", ["A1", [["x"]], None])


async def test_workbench_page_url_follows_registration(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final sheet page availability:

    {"sheet": ".../univer/sheet/index.html", "doc": ".../univer/doc/index.html"}

    Checks:
    1. A controller that registered a workbench base composes each page from it.
    2. An App that registered no workbench explains that instead of returning an
       unusable URL.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("controller-1", "generation-1", workbench_url=WORKBENCH_URL)
    browser = harness.host.for_session("session-1")

    # Check 1: each workbench page is composed from the one registered base.
    assert browser.workbench_page_url("sheet") == SHEET_PAGE
    assert browser.workbench_page_url("doc") == f"{WORKBENCH_URL}doc/index.html"
    assert harness.host.controller_status()["workbench_available"] is True

    # Check 2: an older App without the workbenches is reported as unavailable.
    await harness.register("controller-2", "generation-2")
    assert harness.host.controller_status()["workbench_available"] is False
    with pytest.raises(EmbeddedBrowserUnavailableError, match="workbench is unavailable"):
        browser.workbench_page_url("sheet")
