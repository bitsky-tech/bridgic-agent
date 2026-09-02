"""Spreadsheet tools backed by the App's embedded Univer workbench.

These tools reach the page's agent bridge (``window.__univerBridge``) instead of
the generic ``browser_evaluate_javascript`` tool: the bridge returns structured
values, and the generic path would attach a full accessibility snapshot of a
canvas-rendered grid to every single call.

Shared editing is arbitrated by the page, not here: while a person has a cell
editor open the bridge refuses writes, and the resulting message tells the agent
to retry. ``sheet_changes`` reports who touched what so the agent can see a
person's edits without re-reading the whole grid.
"""

import json
import os
from typing import Any, List, Literal, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ._filesystem import _resolve_file, display_path
from ._workbench import get_workbench_browser, open_workbench, workbench_status

SHEET_BASIC_TOOL_NAMES = frozenset({
    "sheet_open",
    "sheet_status",
    "sheet_read",
    "sheet_write",
    "sheet_formula",
    "sheet_clear",
    "sheet_changes",
    "sheet_data_range",
    "sheet_selection",
    "sheet_save",
    "load_sheet_tools",
})

# Presentation and structure: everything a workbook needs to be readable rather
# than merely correct. Loaded on demand so an ordinary turn is not paying for a
# dozen tool descriptions it will never call.
SHEET_ADVANCED_TOOL_NAMES = frozenset({
    "sheet_format",
    "sheet_border",
    "sheet_merge",
    "sheet_insert_lines",
    "sheet_delete_lines",
    "sheet_resize_lines",
    "sheet_freeze",
    "sheet_new_tab",
    "sheet_rename_tab",
    "sheet_delete_tab",
    "sheet_switch_tab",
})

SHEET_TOOL_NAMES = SHEET_BASIC_TOOL_NAMES | SHEET_ADVANCED_TOOL_NAMES

_MAX_WRITE_CELLS = 5_000


async def _call(method: str, args: List[Any]) -> Any:
    """Call the workbench bridge; the caller decides what the reply must look like."""
    return await get_workbench_browser().call_workbench_bridge("sheet", method, args)


async def _call_dict(method: str, args: List[Any]) -> dict:
    """Call the bridge for an operation whose reply the tool actually reads."""
    result = await _call(method, args)
    if not isinstance(result, dict):
        raise RuntimeError(f"The workbench page returned an unreadable reply to {method}")
    return result


def _require_a1(a1: str) -> str:
    value = (a1 or "").strip()
    if not value:
        raise ValueError('a1 is required, for example "A1" or "A1:C3"')
    return value


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
    return _render_status(await open_workbench("sheet", name, language))


async def sheet_status() -> str:
    """Report the open workbook, its sheets, and whether a person is editing."""
    return _render_status(await workbench_status("sheet"))


async def sheet_read(a1: str, sheet: Optional[str] = None) -> str:
    """Read a range of cells and return them as JSON rows.

    Args:
        a1: An A1 range such as ``A1`` or ``A1:D20``.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A JSON array of rows; an empty cell reads as ``null``.
    """
    result = await _call_dict("readRange", [_require_a1(a1), sheet])
    values = result.get("values") if isinstance(result, dict) else None
    if not isinstance(values, list):
        raise RuntimeError("The workbench page returned an unreadable range")
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
    if cells > _MAX_WRITE_CELLS:
        raise ValueError(
            f"values covers {cells} cells; write at most {_MAX_WRITE_CELLS} in one call"
        )
    result = await _call_dict("writeRange", [_require_a1(a1), values, sheet])
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
    await _call("setFormula", [_require_a1(a1), text, sheet])
    return f"Set {a1} to {text}."


async def sheet_clear(a1: str, sheet: Optional[str] = None) -> str:
    """Clear the contents and formatting of a range.

    Args:
        a1: An A1 range such as ``A1:D20``.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _call("clearRange", [_require_a1(a1), sheet])
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
    changes = await _call("recentChanges", [limit])
    if not isinstance(changes, list) or not changes:
        return "No edits have been recorded since the workbook was opened."
    lines = [
        f"{change.get('source')}: {change.get('a1')}"
        for change in changes
        if isinstance(change, dict)
    ]
    return "\n".join(lines)


async def sheet_data_range(sheet: Optional[str] = None) -> str:
    """Report the rectangle that actually holds content.

    Use this before reading: it is how the agent finds where a person's data
    ends instead of guessing a range.

    Args:
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        The used range in A1 notation with its shape.
    """
    result = await _call_dict("dataRange", [sheet])
    return (
        f"Used range: {result.get('a1')} "
        f"({result.get('rows')} row(s) x {result.get('columns')} column(s))"
    )


async def sheet_selection(sheet: Optional[str] = None) -> str:
    """Report what the person currently has selected.

    Use this to work where they are looking, and to stay out of the range they
    are about to edit.

    Args:
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        The selected ranges, or a note that nothing is selected.
    """
    result = await _call_dict("selection", [sheet])
    ranges = result.get("ranges") if isinstance(result, dict) else None
    if not ranges:
        return "Nobody has selected anything in this sheet."
    return f"Selected: {', '.join(str(item) for item in ranges)} (active {result.get('active')})"


async def load_sheet_tools() -> str:
    """Load the presentation and structure sheet tools for the next step.

    Call this when values alone are not enough — when the workbook needs
    formatting, borders, merged cells, inserted or resized rows and columns,
    frozen headers, or more than one sheet tab. The tools appear on the next
    reasoning round, not in this one.
    """
    agent = current_agent.get(None)
    ota_ctx = getattr(agent, "ota_ctx", None) if agent is not None else None
    if ota_ctx is None:
        raise RuntimeError("load_sheet_tools can only run inside an agent turn.")
    ota_ctx.sheet_tool_loaded = True
    return (
        "Advanced sheet tools are loaded for the next reasoning step.\n\n"
        "New sheet tools include:\n"
        "- sheet_format: colors, bold/italic, size, alignment, wrapping, number format\n"
        "- sheet_border: cell borders\n"
        "- sheet_merge: merge or split cells\n"
        "- sheet_insert_lines / sheet_delete_lines / sheet_resize_lines: rows and columns\n"
        "- sheet_freeze: keep header rows and columns in view\n"
        "- sheet_new_tab / sheet_rename_tab / sheet_delete_tab / sheet_switch_tab: sheets\n"
        "\nContinue with the next reasoning step to call them."
    )


# ---------------------------------------------------------------------------
# Advanced sheet tools (loaded on demand via load_sheet_tools)
# ---------------------------------------------------------------------------

async def sheet_format(
    a1: str,
    background: Optional[str] = None,
    font_color: Optional[str] = None,
    font_size: Optional[int] = None,
    bold: Optional[bool] = None,
    italic: Optional[bool] = None,
    horizontal_align: Optional[Literal["left", "center", "normal"]] = None,
    vertical_align: Optional[Literal["top", "middle", "bottom"]] = None,
    wrap: Optional[bool] = None,
    number_format: Optional[str] = None,
    sheet: Optional[str] = None,
) -> str:
    """Style a range: colors, weight, size, alignment, wrapping, number format.

    Everything given is applied in one step; anything omitted is left as it is.
    Colors are CSS hex such as ``#fff2cc``. ``number_format`` is an Excel
    pattern such as ``#,##0.00`` or ``0.0%``.

    Args:
        a1: An A1 range such as ``A1:D1``.
        background: Cell background color.
        font_color: Text color.
        font_size: Text size in points.
        bold: Whether the text is bold.
        italic: Whether the text is italic.
        horizontal_align: Horizontal alignment.
        vertical_align: Vertical alignment.
        wrap: Whether text wraps inside the cell.
        number_format: Excel number-format pattern.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation naming what was applied.
    """
    options = {
        "background": background,
        "bold": bold,
        "fontColor": font_color,
        "fontSize": font_size,
        "horizontalAlign": horizontal_align,
        "italic": italic,
        "numberFormat": number_format,
        "verticalAlign": vertical_align,
        "wrap": wrap,
    }
    applied = {key: value for key, value in options.items() if value is not None}
    if not applied:
        raise ValueError("give at least one formatting option")
    await _call("format", [_require_a1(a1), applied, sheet])
    return f"Formatted {a1} ({', '.join(sorted(applied))})."


async def sheet_border(
    a1: str,
    border_type: Literal[
        "all", "bottom", "horizontal", "inside", "left",
        "none", "outside", "right", "top", "vertical",
    ] = "all",
    style: Literal["thin", "medium", "thick", "dashed", "dotted", "double", "none"] = "thin",
    color: Optional[str] = None,
    sheet: Optional[str] = None,
) -> str:
    """Draw or clear borders on a range.

    Args:
        a1: An A1 range such as ``A1:D10``.
        border_type: Which edges to draw.
        style: Line style; ``none`` erases.
        color: CSS hex color such as ``#d9d9d9``.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _call("border", [_require_a1(a1), border_type, style, color, sheet])
    return f"Set {border_type} {style} borders on {a1}."


async def sheet_merge(
    a1: str,
    mode: Literal["all", "across", "vertically", "break"] = "all",
    sheet: Optional[str] = None,
) -> str:
    """Merge a range into one cell, merge it per row or per column, or split it.

    Args:
        a1: An A1 range such as ``A1:D1``.
        mode: ``all`` merges everything, ``across`` merges each row, ``vertically``
            merges each column, and ``break`` splits merged cells apart.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _call("merge", [_require_a1(a1), mode, sheet])
    return f"Applied merge mode {mode} to {a1}."


async def sheet_insert_lines(
    axis: Literal["rows", "columns"],
    index: int,
    count: int = 1,
    sheet: Optional[str] = None,
) -> str:
    """Insert empty rows or columns, shifting the existing ones down or right.

    Args:
        axis: Whether to insert rows or columns.
        index: Zero-based position to insert at.
        count: How many to insert.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _call("insertLines", [axis, index, count, sheet])
    return f"Inserted {count} {axis} at {index}."


async def sheet_delete_lines(
    axis: Literal["rows", "columns"],
    index: int,
    count: int = 1,
    sheet: Optional[str] = None,
) -> str:
    """Delete rows or columns along with their contents.

    Args:
        axis: Whether to delete rows or columns.
        index: Zero-based position to delete from.
        count: How many to delete.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _call("deleteLines", [axis, index, count, sheet])
    return f"Deleted {count} {axis} at {index}."


async def sheet_resize_lines(
    axis: Literal["rows", "columns"],
    index: int,
    count: int,
    pixels: int,
    sheet: Optional[str] = None,
) -> str:
    """Set the height of rows or the width of columns.

    Args:
        axis: Whether to size rows or columns.
        index: Zero-based position to start from.
        count: How many to size.
        pixels: Height or width in pixels.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _call("resizeLines", [axis, index, count, pixels, sheet])
    return f"Sized {count} {axis} at {index} to {pixels}px."


async def sheet_freeze(rows: int = 0, columns: int = 0, sheet: Optional[str] = None) -> str:
    """Keep leading rows and columns in view while the rest scrolls.

    Args:
        rows: How many leading rows to freeze; ``0`` for none.
        columns: How many leading columns to freeze; ``0`` for none.
        sheet: Sheet name; the active sheet is used when omitted.

    Returns:
        A short confirmation.
    """
    await _call("freeze", [rows, columns, sheet])
    if rows == 0 and columns == 0:
        return "Released the frozen rows and columns."
    return f"Froze {rows} row(s) and {columns} column(s)."


async def sheet_new_tab(name: str) -> str:
    """Add a new sheet tab to the workbook.

    Args:
        name: The name for the new sheet.

    Returns:
        A short confirmation naming the created sheet.
    """
    result = await _call_dict("addSheet", [name])
    return f"Added sheet {result.get('name')}."


async def sheet_rename_tab(name: str, new_name: str) -> str:
    """Rename one sheet tab.

    Args:
        name: The sheet to rename.
        new_name: Its new name.

    Returns:
        A short confirmation.
    """
    result = await _call_dict("renameSheet", [name, new_name])
    return f"Renamed {name} to {result.get('name')}."


async def sheet_delete_tab(name: str) -> str:
    """Delete one sheet tab and everything on it.

    Args:
        name: The sheet to delete.

    Returns:
        A short confirmation.
    """
    await _call("removeSheet", [name])
    return f"Deleted sheet {name}."


async def sheet_switch_tab(name: str) -> str:
    """Bring one sheet tab to the front, for the person as well as the agent.

    Args:
        name: The sheet to show.

    Returns:
        A short confirmation.
    """
    result = await _call_dict("activateSheet", [name])
    return f"Switched to sheet {result.get('name')}."


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
    snapshot = await _call("snapshot", [])
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
        sheet_data_range,
        sheet_selection,
        sheet_save,
        load_sheet_tools,
        sheet_format,
        sheet_border,
        sheet_merge,
        sheet_insert_lines,
        sheet_delete_lines,
        sheet_resize_lines,
        sheet_freeze,
        sheet_new_tab,
        sheet_rename_tab,
        sheet_delete_tab,
        sheet_switch_tab,
    )
]

__all__ = [
    "SHEET_ADVANCED_TOOL_NAMES",
    "SHEET_BASIC_TOOL_NAMES",
    "SHEET_TOOL_NAMES",
    "sheet_open",
    "sheet_status",
    "sheet_read",
    "sheet_write",
    "sheet_formula",
    "sheet_clear",
    "sheet_changes",
    "sheet_save",
    "sheet_data_range",
    "sheet_selection",
    "load_sheet_tools",
    "sheet_format",
    "sheet_border",
    "sheet_merge",
    "sheet_insert_lines",
    "sheet_delete_lines",
    "sheet_resize_lines",
    "sheet_freeze",
    "sheet_new_tab",
    "sheet_rename_tab",
    "sheet_delete_tab",
    "sheet_switch_tab",
    "sheet_tool_specs",
]
