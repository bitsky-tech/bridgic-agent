"""Spreadsheet tools backed by the App's embedded Univer workbench.

The workbench is an ordinary page inside the Session's embedded browser, so it
appears in the same right-side dock as any other page the agent opens and a
person can type in it directly. These tools reach the page's agent bridge
(``window.__univerBridge``) instead of the generic ``browser_evaluate_javascript``
tool: the bridge returns structured values, and the generic path would attach a
full accessibility snapshot of a canvas-rendered grid to every single call.

Shared editing is arbitrated by the page, not here: while a person has a cell
editor open the bridge refuses writes, and the resulting message tells the agent
to retry. ``sheet_changes`` reports who touched what so the agent can see a
person's edits without re-reading the whole grid.
"""

import asyncio
import json
import os
from typing import Any, List, Optional
from urllib.parse import quote

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._browser import SessionBrowser
from ._filesystem import _resolve_file, display_path

SHEET_TOOL_NAMES = frozenset({
    "sheet_open",
    "sheet_status",
    "sheet_read",
    "sheet_write",
    "sheet_formula",
    "sheet_clear",
    "sheet_changes",
    "sheet_save",
})

_READY_TIMEOUT_SECONDS = 30.0
_READY_POLL_SECONDS = 0.5
_MAX_READ_CELLS = 5_000


def _get_browser() -> SessionBrowser:
    agent = current_agent.get(None)
    ctx = getattr(agent, "ctx", None) if agent is not None else None
    browser = getattr(ctx, "browser", None) if ctx is not None else None
    if browser is None:
        raise RuntimeError("sheet tools require an active Session browser")
    return browser


def _require_a1(a1: str) -> str:
    value = (a1 or "").strip()
    if not value:
        raise ValueError('a1 is required, for example "A1" or "A1:C3"')
    return value


async def _status(browser: SessionBrowser) -> dict:
    status = await browser.call_sheet_bridge("status")
    if not isinstance(status, dict):
        raise RuntimeError("The sheet page returned an unreadable status")
    return status


async def _await_ready(browser: SessionBrowser) -> dict:
    """Poll the freshly navigated page until its workbook exists."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _READY_TIMEOUT_SECONDS
    last_error: Optional[str] = None
    while loop.time() < deadline:
        try:
            status = await _status(browser)
        except RuntimeError as exc:
            last_error = str(exc)
        else:
            if status.get("ready"):
                return status
            last_error = "the workbook has not finished loading"
        await asyncio.sleep(_READY_POLL_SECONDS)
    raise RuntimeError(f"The sheet page did not become ready: {last_error}")


def _render_status(status: dict) -> str:
    sheets = ", ".join(str(sheet.get("name")) for sheet in status.get("sheets") or [])
    editing = "yes" if status.get("humanEditing") else "no"
    return (
        f"Workbook: {status.get('workbookName')}\n"
        f"Sheets: {sheets or '(none)'}\n"
        f"Active sheet: {status.get('activeSheetName')}\n"
        f"A person is editing a cell right now: {editing}\n"
        f"Revision: {status.get('revision')}"
    )


async def sheet_open(name: str = "Untitled", language: str = "en") -> str:
    """Open the spreadsheet workbench in this Session's dock and return its state.

    The workbench is shared: the person can edit the same workbook by hand while
    the agent works in it. Call this once per Session before the other sheet
    tools; calling it again replaces the open workbook with an empty one.

    Args:
        name: The workbook name shown to the person.
        language: UI language for the workbench, ``en`` or ``zh``.

    Returns:
        The workbook, its sheets, and whether a person is editing right now.
    """
    browser = _get_browser()
    page_url = browser.sheet_page_url()
    lang = "zh" if str(language).lower().startswith("zh") else "en"
    separator = "&" if "?" in page_url else "?"
    workbook_name = quote((name or "").strip() or "Untitled", safe="")
    url = f"{page_url}{separator}lang={lang}&name={workbook_name}"
    # The navigation result carries a page snapshot that is meaningless for a
    # canvas-rendered grid, so the workbench's own status is reported instead.
    await browser.invoke("navigate_to", url)
    return _render_status(await _await_ready(browser))


async def sheet_status() -> str:
    """Report the open workbook, its sheets, and whether a person is editing."""
    return _render_status(await _status(_get_browser()))


async def sheet_read(a1: str, sheet: Optional[str] = None) -> str:
    """Read a range of cells and return them as JSON rows.

    Args:
        a1: An A1 range such as ``A1`` or ``A1:D20``.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A JSON array of rows; an empty cell reads as ``null``.
    """
    result = await _get_browser().call_sheet_bridge(
        "readRange", [_require_a1(a1), sheet],
    )
    values = result.get("values") if isinstance(result, dict) else None
    if not isinstance(values, list):
        raise RuntimeError("The sheet page returned an unreadable range")
    return json.dumps(values, ensure_ascii=False)


async def sheet_write(a1: str, values: List[List[Any]], sheet: Optional[str] = None) -> str:
    """Write rows of values into a range, overwriting whatever is there.

    Refused while a person has a cell editor open — retry once ``sheet_status``
    reports that they have finished. Use ``null`` for a cell that should be
    cleared. Anchor ``a1`` at the top-left cell; the range grows to fit
    ``values``.

    Args:
        a1: Where the first row and column land, such as ``A1``.
        values: Rows of cell values (strings, numbers, booleans, or ``null``).
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation with the written shape.
    """
    if not values:
        raise ValueError("values must contain at least one row")
    cells = sum(len(row) for row in values)
    if cells > _MAX_READ_CELLS:
        raise ValueError(
            f"values covers {cells} cells; write at most {_MAX_READ_CELLS} in one call"
        )
    result = await _get_browser().call_sheet_bridge(
        "writeRange", [_require_a1(a1), values, sheet],
    )
    rows = result.get("rows") if isinstance(result, dict) else len(values)
    columns = result.get("columns") if isinstance(result, dict) else 0
    return f"Wrote {rows} row(s) x {columns} column(s) at {a1}."


async def sheet_formula(a1: str, formula: str, sheet: Optional[str] = None) -> str:
    """Set one cell's formula, for example ``=SUM(B2:B10)``.

    Args:
        a1: The single cell to set, such as ``C1``.
        formula: The formula text, which must start with ``=``.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    text = (formula or "").strip()
    if not text.startswith("="):
        raise ValueError('formula must start with "=", for example "=SUM(B2:B10)"')
    await _get_browser().call_sheet_bridge("setFormula", [_require_a1(a1), text, sheet])
    return f"Set {a1} to {text}."


async def sheet_clear(a1: str, sheet: Optional[str] = None) -> str:
    """Clear the contents and formatting of a range.

    Args:
        a1: An A1 range such as ``A1:D20``.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _get_browser().call_sheet_bridge("clearRange", [_require_a1(a1), sheet])
    return f"Cleared {a1}."


async def sheet_changes(limit: int = 20) -> str:
    """List the most recent edits, showing whether the agent or a person made them.

    Use this to notice what the person changed by hand instead of re-reading the
    whole grid.

    Args:
        limit: How many recent edits to return.

    Returns:
        One line per edit, newest last, or a note that nothing has changed.
    """
    changes = await _get_browser().call_sheet_bridge("recentChanges", [limit])
    if not isinstance(changes, list) or not changes:
        return "No edits have been recorded since the workbook was opened."
    lines = [
        f"{change.get('source')}: {change.get('a1')}"
        for change in changes
        if isinstance(change, dict)
    ]
    return "\n".join(lines)


async def sheet_save(file_path: str) -> str:
    """Save the open workbook to a JSON file in the Session workspace.

    The file is Univer's own workbook format, so ``sheet_open`` on a later turn
    plus this file is enough to reproduce the workbook. Put it under version
    control with the workspace tools to get a reviewable history.

    Args:
        file_path: Path relative to the Session work directory, or absolute.

    Returns:
        A short confirmation with the written path.
    """
    snapshot = await _get_browser().call_sheet_bridge("snapshot")
    abs_path = _resolve_file(file_path)
    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    payload = json.dumps(snapshot, ensure_ascii=False, indent=2)
    with open(abs_path, "w", encoding="utf-8") as handle:
        handle.write(payload)
    return f"Saved the workbook to {display_path(abs_path)} ({len(payload)} bytes)."


sheet_tool_specs = [
    FunctionToolSpec.from_raw(tool)
    for tool in (
        sheet_open,
        sheet_status,
        sheet_read,
        sheet_write,
        sheet_formula,
        sheet_clear,
        sheet_changes,
        sheet_save,
    )
]

__all__ = [
    "SHEET_TOOL_NAMES",
    "sheet_open",
    "sheet_status",
    "sheet_read",
    "sheet_write",
    "sheet_formula",
    "sheet_clear",
    "sheet_changes",
    "sheet_save",
    "sheet_tool_specs",
]
