import json

import pytest

from src.amphi_agent._browser import EmbeddedBrowserUnavailableError
from tests.agent.browser._harness import BrowserHarness

SHEET_URL = "http://127.0.0.1:5100/ab12/univer/index.html"


async def test_sheet_bridge_call_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
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
    await harness.register("controller-1", "generation-1", sheet_url=SHEET_URL)
    browser = harness.host.for_session("session-1")

    # The client only exists after the first call, so script its reply after it.
    await browser.call_sheet_bridge("status")
    client = harness.client("session-1")
    client.evaluate_reply = json.dumps({"ok": True, "value": [["a", None]]})

    result = await browser.call_sheet_bridge("readRange", ["A1:B2", None])

    # Check 1: the method and its arguments are embedded in the evaluated code.
    assert '"readRange"' in client.evaluated[-1]
    assert '["A1:B2", null]' in client.evaluated[-1]
    # Check 2: the reply is parsed rather than returned as text.
    assert result == [["a", None]]
    # Check 3: nothing asked the page for an accessibility snapshot.
    assert not any(event[0] == "snapshot" for event in client.events)


async def test_sheet_bridge_surfaces_page_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final sheet-bridge failures:

    {"refusal": "a person is editing", "unreadable": "reopen it with sheet_open"}

    Checks:
    1. A refusal from the page becomes an error carrying the page's own reason.
    2. A reply that is not the expected JSON envelope names the recovery step.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("controller-1", "generation-1", sheet_url=SHEET_URL)
    browser = harness.host.for_session("session-1")
    await browser.call_sheet_bridge("status")
    client = harness.client("session-1")

    # Check 1: the page's refusal reaches the caller verbatim.
    client.evaluate_reply = json.dumps({"ok": False, "error": "a person is editing a cell"})
    with pytest.raises(RuntimeError, match="a person is editing a cell"):
        await browser.call_sheet_bridge("writeRange", ["A1", [["x"]], None])

    # Check 2: a non-envelope reply is reported as needing a reopen.
    client.evaluate_reply = "undefined"
    with pytest.raises(RuntimeError, match="reopen it with sheet_open"):
        await browser.call_sheet_bridge("status")


async def test_sheet_page_url_follows_registration(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final sheet page availability:

    {"with_sheet_url": "http://127.0.0.1:5100/ab12/univer/index.html", "without": null}

    Checks:
    1. A controller that registered a sheet page exposes it to the Session.
    2. An App that registered no sheet page explains that instead of returning
       an unusable URL.
    """
    harness = BrowserHarness(monkeypatch)
    await harness.register("controller-1", "generation-1", sheet_url=SHEET_URL)
    browser = harness.host.for_session("session-1")

    # Check 1: the registered page is what the Session navigates to.
    assert browser.sheet_page_url() == SHEET_URL
    assert harness.host.controller_status()["sheet_available"] is True

    # Check 2: an older App without the workbench is reported as unavailable.
    await harness.register("controller-2", "generation-2")
    assert harness.host.controller_status()["sheet_available"] is False
    with pytest.raises(EmbeddedBrowserUnavailableError, match="sheet workbench is unavailable"):
        browser.sheet_page_url()
