import json
from pathlib import Path
from typing import Any, Optional

import pytest

from src.amphi_agent._browser import EmbeddedBrowserUnavailableError
from src.amphi_agent.tools._doc import (
    doc_append,
    doc_insert,
    doc_open,
    doc_read,
    doc_replace,
    doc_save,
    doc_status,
)
from tests.agent.tools._harness import ToolHarness

_STATUS = {"characters": 12, "name": "Notes", "ready": True, "revision": 2}


class _RecordingDocBrowser:
    """A Session browser whose workbench page answers from a scripted table."""

    def __init__(
        self,
        replies: Optional[dict[str, Any]] = None,
        *,
        base_url: Optional[str] = "http://127.0.0.1:5100/ab12/univer/",
    ) -> None:
        self.bridge_calls: list[tuple[str, list[Any]]] = []
        self.opened: list[tuple[str, str, str]] = []
        self._base_url = base_url
        self._replies: dict[str, Any] = {"status": _STATUS, **(replies or {})}

    async def open_workbench(self, kind: str, *, language: str = "en", name: str = "Untitled") -> None:
        if self._base_url is None:
            raise EmbeddedBrowserUnavailableError("the desktop app is not running")
        self.opened.append((kind, language, name))

    async def call_workbench_bridge(
        self, kind: str, method: str, args: Optional[list[Any]] = None,
    ) -> Any:
        self.bridge_calls.append((method, list(args or [])))
        if method not in self._replies:
            raise RuntimeError(f"unexpected bridge call: {method}")
        return self._replies[method]


async def test_doc_open_navigates_to_the_document_page(tool_harness: ToolHarness) -> None:
    """Final document-open state:

    {"opened": ["doc", "zh", "Weekly Notes"], "reported_document": "Notes"}

    Checks:
    1. Opening asks for the document workbench, not the spreadsheet one.
    2. The name and language the agent chose travel with the request.
    3. The reply describes the document, not the page.
    """
    browser = _RecordingDocBrowser()
    tool_harness.context.browser = browser  # type: ignore[assignment]

    result = await doc_open("Weekly Notes", language="zh")

    # Checks 1 and 2: one open request naming the workbench and the agent's choices.
    assert browser.opened == [("doc", "zh", "Weekly Notes")]
    # Check 3: the workbench's own state is reported.
    assert "Notes" in result
    assert "Characters: 12" in result


async def test_doc_reads_and_writes(tool_harness: ToolHarness) -> None:
    """Final document operations:

    {
      "read": "Hello\\nworld\\n",
      "append": {"characters": 20},
      "insert": {"offset": 5},
      "replace": {"span": [6, 11]}
    }

    Checks:
    1. A read returns the document's plain text.
    2. Appending forwards only the text, since it needs no position.
    3. Inserting forwards an explicit offset rather than relying on the caret.
    4. Replacing forwards the span and the replacement together.
    """
    browser = _RecordingDocBrowser({
        "read": {"characters": 12, "text": "Hello\nworld\n"},
        "append": {"characters": 20, "offset": 12},
        "insert": {"characters": 18, "offset": 5},
        "replace": {"characters": 18, "offset": 6},
    })
    tool_harness.context.browser = browser  # type: ignore[assignment]

    # Check 1: the text comes back as text, not as an envelope.
    assert await doc_read() == "Hello\nworld\n"

    # Check 2: appending carries the text alone.
    assert "20 character(s) long" in await doc_append(" more")
    assert browser.bridge_calls[1] == ("append", [" more"])

    # Check 3: inserting names its offset.
    await doc_insert(" there", 5)
    assert browser.bridge_calls[2] == ("insert", [" there", 5])

    # Check 4: replacing carries the span with the replacement.
    await doc_replace(6, 11, "there")
    assert browser.bridge_calls[3] == ("replace", [6, 11, "there"])


async def test_doc_writes_reject_bad_input(tool_harness: ToolHarness) -> None:
    """Final rejected calls:

    {"rejected": ["blank text", "negative offset", "reversed span"]}

    Checks:
    1. Blank text is refused before it reaches the page.
    2. A negative offset is refused with the unit it expects.
    3. A span whose end precedes its start is refused locally.
    """
    browser = _RecordingDocBrowser({"append": {}})
    tool_harness.context.browser = browser  # type: ignore[assignment]

    with pytest.raises(ValueError, match="text is required"):
        await doc_append("   ")
    with pytest.raises(ValueError, match="whole number of characters"):
        await doc_insert("x", -1)
    with pytest.raises(ValueError, match="must not be before"):
        await doc_replace(9, 2, "x")
    assert browser.bridge_calls == []


async def test_doc_save_writes_the_document(tool_harness: ToolHarness) -> None:
    """Final workspace state:

    {"file": "notes/weekly.univer.json", "restores_document": true}

    Checks:
    1. The snapshot is written under the Session workspace, creating parents.
    2. The file holds the document snapshot the page returned.
    """
    snapshot = {"id": "doc-1", "body": {"dataStream": "Hello\r\n"}}
    browser = _RecordingDocBrowser({"snapshot": snapshot})
    tool_harness.context.browser = browser  # type: ignore[assignment]

    result = await doc_save("notes/weekly.univer.json")

    # Checks 1 and 2: the snapshot lands in the workspace intact.
    written = Path(tool_harness.workspace.work_dir) / "notes/weekly.univer.json"
    assert json.loads(written.read_text(encoding="utf-8")) == snapshot
    assert "notes/weekly.univer.json" in result


async def test_doc_tools_require_a_session_browser(tool_harness: ToolHarness) -> None:
    """Final tool state:

    {"error": "workbench tools require an active Session browser"}

    Checks:
    1. Without a Session browser the tools explain what is missing.
    """
    tool_harness.context.browser = None  # type: ignore[assignment]
    with pytest.raises(RuntimeError, match="require an active Session browser"):
        await doc_status()
