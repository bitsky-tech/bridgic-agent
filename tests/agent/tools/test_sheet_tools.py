import json
from pathlib import Path
from typing import Any, Optional

import pytest

from src.amphi_agent._browser import EmbeddedBrowserUnavailableError
from src.amphi_agent.tools._sheet import (
    sheet_changes,
    sheet_clear,
    sheet_formula,
    sheet_open,
    sheet_read,
    sheet_save,
    sheet_status,
    sheet_write,
)
from tests.agent.tools._harness import ToolHarness

_STATUS = {
    "activeSheetId": "id-0",
    "activeSheetName": "Sheet1",
    "humanEditing": False,
    "ready": True,
    "revision": 3,
    "sheets": [{"id": "id-0", "name": "Sheet1"}, {"id": "id-1", "name": "Data"}],
    "workbookName": "Budget",
}


class _RecordingSheetBrowser:
    """A Session browser whose sheet page answers from a scripted table."""

    def __init__(
        self,
        replies: Optional[dict[str, Any]] = None,
        *,
        page_url: Optional[str] = "http://127.0.0.1:5100/ab12/univer/index.html",
    ) -> None:
        self.bridge_calls: list[tuple[str, list[Any]]] = []
        self.invocations: list[tuple[str, tuple[Any, ...]]] = []
        self._page_url = page_url
        self._replies: dict[str, Any] = {"status": _STATUS, **(replies or {})}

    def sheet_page_url(self) -> str:
        if self._page_url is None:
            raise EmbeddedBrowserUnavailableError("the desktop app is not running")
        return self._page_url

    async def invoke(self, method: str, *args: Any) -> str:
        self.invocations.append((method, args))
        return f"{method} result"

    async def call_sheet_bridge(self, method: str, args: Optional[list[Any]] = None) -> Any:
        self.bridge_calls.append((method, list(args or [])))
        if method not in self._replies:
            raise RuntimeError(f"unexpected bridge call: {method}")
        return self._replies[method]


async def test_sheet_open_navigates_and_reports_state(tool_harness: ToolHarness) -> None:
    """Final sheet-open state:

    {
      "navigated": "http://127.0.0.1:5100/ab12/univer/index.html?lang=zh&name=Q3%20Budget",
      "reported_workbook": "Budget"
    }

    Checks:
    1. Opening navigates the Session browser to the App-served sheet page.
    2. The workbook name and language reach the page as encoded query parameters.
    3. The reply describes the workbook instead of the page snapshot the
       navigation returned.
    """
    browser = _RecordingSheetBrowser()
    tool_harness.context.browser = browser  # type: ignore[assignment]

    result = await sheet_open("Q3 Budget", language="zh-CN")

    # Checks 1 and 2: one navigation, carrying the encoded page parameters.
    assert browser.invocations == [(
        "navigate_to",
        ("http://127.0.0.1:5100/ab12/univer/index.html?lang=zh&name=Q3%20Budget",),
    )]
    # Check 3: the workbench's own state is reported, not "navigate_to result".
    assert "Budget" in result
    assert "Sheet1, Data" in result
    assert "A person is editing a cell right now: no" in result
    assert "navigate_to result" not in result


async def test_sheet_open_without_the_app(tool_harness: ToolHarness) -> None:
    """Final sheet-open state:

    {"navigated": false, "error": "desktop app is not running"}

    Checks:
    1. A missing App surfaces its own explanation rather than a page error.
    2. No navigation is attempted when there is no page to navigate to.
    """
    browser = _RecordingSheetBrowser(page_url=None)
    tool_harness.context.browser = browser  # type: ignore[assignment]

    with pytest.raises(EmbeddedBrowserUnavailableError):
        await sheet_open()
    assert browser.invocations == []


async def test_sheet_reads_and_writes(tool_harness: ToolHarness) -> None:
    """Final workbook operations:

    {
      "read": [["a", null], [1, true]],
      "write": {"a1": "A1", "rows": 2, "columns": 2},
      "formula": "=SUM(B2:B10)",
      "cleared": "A1:D20"
    }

    Checks:
    1. A read returns JSON rows with empty cells preserved as null.
    2. A write forwards the rows and the target sheet, and reports the shape.
    3. A formula reaches the page unchanged once it starts with "=".
    4. Clearing forwards the range to the page.
    """
    browser = _RecordingSheetBrowser({
        "readRange": {"a1": "A1:B2", "values": [["a", None], [1, True]]},
        "writeRange": {"a1": "A1", "columns": 2, "rows": 2},
        "setFormula": {"a1": "C1"},
        "clearRange": {"a1": "A1:D20"},
    })
    tool_harness.context.browser = browser  # type: ignore[assignment]

    # Check 1: reads round-trip as JSON, null included.
    assert json.loads(await sheet_read("A1:B2")) == [["a", None], [1, True]]

    # Check 2: writes carry the rows and the named sheet.
    assert await sheet_write("A1", [["a", "b"], [1, 2]], sheet="Data") == (
        "Wrote 2 row(s) x 2 column(s) at A1."
    )
    assert browser.bridge_calls[1] == ("writeRange", ["A1", [["a", "b"], [1, 2]], "Data"])

    # Check 3: the formula is forwarded verbatim.
    assert "=SUM(B2:B10)" in await sheet_formula("C1", "=SUM(B2:B10)")
    assert browser.bridge_calls[2] == ("setFormula", ["C1", "=SUM(B2:B10)", None])

    # Check 4: clearing forwards the range.
    assert await sheet_clear("A1:D20") == "Cleared A1:D20."


async def test_sheet_write_rejects_bad_input(tool_harness: ToolHarness) -> None:
    """Final rejected calls:

    {"rejected": ["empty values", "blank range", "formula without ="]}

    Checks:
    1. A write with no rows is refused before it reaches the page.
    2. A blank range is refused with an example of the expected form.
    3. A formula missing its leading "=" is refused locally.
    """
    browser = _RecordingSheetBrowser({"writeRange": {}})
    tool_harness.context.browser = browser  # type: ignore[assignment]

    with pytest.raises(ValueError, match="at least one row"):
        await sheet_write("A1", [])
    with pytest.raises(ValueError, match="a1 is required"):
        await sheet_write("  ", [["a"]])
    with pytest.raises(ValueError, match='must start with "="'):
        await sheet_formula("A1", "SUM(B1:B2)")
    assert browser.bridge_calls == []


async def test_sheet_changes_attributes_edits(tool_harness: ToolHarness) -> None:
    """Final change log:

    {"lines": ["agent: Sheet1!A1", "human: Sheet1!B7"]}

    Checks:
    1. Each recorded edit is rendered with the party that made it.
    2. An empty log says so instead of returning nothing.
    """
    browser = _RecordingSheetBrowser({
        "recentChanges": [
            {"a1": "Sheet1!A1", "at": 1, "source": "agent"},
            {"a1": "Sheet1!B7", "at": 2, "source": "human"},
        ],
    })
    tool_harness.context.browser = browser  # type: ignore[assignment]

    # Check 1: attribution is preserved per line.
    assert await sheet_changes() == "agent: Sheet1!A1\nhuman: Sheet1!B7"

    # Check 2: an empty log is explained.
    browser._replies["recentChanges"] = []
    assert "No edits" in await sheet_changes()


async def test_sheet_save_writes_the_workbook(tool_harness: ToolHarness) -> None:
    """Final workspace state:

    {"file": "reports/budget.univer.json", "restores_workbook": true}

    Checks:
    1. The snapshot is written under the Session workspace, creating parents.
    2. The file holds the workbook snapshot the page returned.
    3. The confirmation names the workspace-relative path.
    """
    snapshot = {"id": "book-1", "name": "Budget", "sheets": {}}
    browser = _RecordingSheetBrowser({"snapshot": snapshot})
    tool_harness.context.browser = browser  # type: ignore[assignment]

    result = await sheet_save("reports/budget.univer.json")

    # Checks 1 and 2: the file exists in the workspace with the snapshot in it.
    written = Path(tool_harness.workspace.work_dir) / "reports/budget.univer.json"
    assert json.loads(written.read_text(encoding="utf-8")) == snapshot
    # Check 3: the confirmation stays workspace-relative.
    assert "reports/budget.univer.json" in result


async def test_sheet_tools_require_a_session_browser(tool_harness: ToolHarness) -> None:
    """Final tool state:

    {"error": "sheet tools require an active Session browser"}

    Checks:
    1. Without a Session browser the tools explain what is missing.
    """
    tool_harness.context.browser = None  # type: ignore[assignment]
    with pytest.raises(RuntimeError, match="require an active Session browser"):
        await sheet_status()
