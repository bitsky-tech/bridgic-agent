"""Document tools backed by the App's embedded Univer workbench.

The sibling of ``_sheet``, over the same transport, but the document facade
Univer publishes is much thinner than the spreadsheet one and these tools do not
pretend otherwise:

* Univer's insert writes at the *current selection*, which is the person's own
  caret, so every write here names an explicit offset. ``doc_append`` is the one
  write that cannot disturb where they are typing.
* There is no document equivalent of the spreadsheet's cell-editor events, so
  there is no edit lock and no attributed change log. Sharing a document with a
  person is therefore less safe than sharing a workbook: read first, prefer
  appending, and expect a person's typing to move every offset after it.
"""

import json
import os
from typing import Any, Optional

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ._arguments import require_int, require_text
from ._filesystem import _resolve_file, display_path
from ._workbench import get_workbench_browser, open_workbench, workbench_status


async def _call(method: str, args: Optional[list] = None) -> Any:
    """Call the document workbench's bridge; the caller checks the reply shape."""
    return await get_workbench_browser().call_workbench_bridge("doc", method, args)

DOC_TOOL_NAMES = frozenset({
    "doc_open",
    "doc_status",
    "doc_read",
    "doc_append",
    "doc_insert",
    "doc_replace",
    "doc_save",
})

_MAX_WRITE_CHARACTERS = 100_000
# Reading is capped for the same reason the spreadsheet's is. Cutting the tail
# is safe here in a way cutting the head would not be: offsets count from the
# start, so every offset in what is returned still addresses the same text.
_MAX_READ_CHARACTERS = 20_000


def _require_text(text: str) -> str:
    text = require_text("text", text)
    if len(text) > _MAX_WRITE_CHARACTERS:
        raise ValueError(
            f"text is {len(text)} characters; write at most "
            f"{_MAX_WRITE_CHARACTERS} in one call"
        )
    return text


def _require_offset(name: str, offset: int) -> int:
    return require_int(name, offset, minimum=0)


def _render_status(status: dict) -> str:
    return (
        f"Document: {status.get('name')}\n"
        f"Characters: {status.get('characters')}\n"
        f"Revision: {status.get('revision')}"
    )


async def doc_open(name: str = "Untitled", language: str = "en") -> str:
    """Open the document workbench in this Session's dock and return its state.

    The workbench is shared: the person can type in the same document while the
    agent works in it. Call this once per Session before the other doc tools;
    calling it again replaces the open document with an empty one.

    Args:
        name: The document name shown to the person.
        language: UI language for the workbench, ``en`` or ``zh``.

    Returns:
        The document name, its length, and how many agent writes it has taken.
    """
    return _render_status(await open_workbench("doc", name, language))


async def doc_status() -> str:
    """Report the open document's name and current length in characters.

    The length is the cheapest way to notice that a person has been typing:
    compare it with the length from an earlier call before trusting an offset.
    """
    return _render_status(await workbench_status("doc"))


async def doc_read() -> str:
    """Read the whole document as plain text.

    Offsets in this text are exactly the offsets ``doc_insert`` and
    ``doc_replace`` take, so a position found here can be acted on directly.
    Paragraph and section breaks read as newlines.

    Returns:
        The document text. A long document is cut off at the end, with a note
        saying how much is missing; offsets in what is returned stay correct.
    """
    result = await _call("read")
    text = result.get("text") if isinstance(result, dict) else None
    if not isinstance(text, str):
        raise RuntimeError("The workbench page returned an unreadable document")
    if len(text) <= _MAX_READ_CHARACTERS:
        return text
    return (
        f"{text[:_MAX_READ_CHARACTERS]}\n"
        f"[The document continues for {len(text) - _MAX_READ_CHARACTERS} more character(s). "
        f"Offsets above are still correct; use doc_status for the full length.]"
    )


async def doc_append(text: str) -> str:
    """Append text at the end of the document.

    This is the only write that cannot disturb where a person is typing, so
    prefer it whenever the position does not have to be exact.

    Args:
        text: The text to append. Use ``\\n`` to start new paragraphs.

    Returns:
        A short confirmation with the document's new length.
    """
    result = await _call("append", [_require_text(text)])
    return f"Appended {len(text)} character(s); the document is now {_length(result)}."


async def doc_insert(text: str, offset: int) -> str:
    """Insert text at an exact offset, counted from the start of the document.

    This moves the person's caret to the insertion point, so read the document
    first and avoid it while they are typing.

    Args:
        text: The text to insert.
        offset: Characters from the start, as counted by ``doc_read``.

    Returns:
        A short confirmation with the document's new length.
    """
    result = await _call("insert", [_require_text(text), _require_offset("offset", offset)])
    return (
        f"Inserted {len(text)} character(s) at {offset}; "
        f"the document is now {_length(result)}."
    )


async def doc_replace(start_offset: int, end_offset: int, text: str) -> str:
    """Replace the text between two offsets, counted from the start.

    Re-read the document immediately before calling this: a person typing
    anywhere earlier shifts every offset after them.

    Args:
        start_offset: First character to replace, as counted by ``doc_read``.
        end_offset: Character to stop before; equal to ``start_offset`` inserts.
        text: The replacement text.

    Returns:
        A short confirmation with the document's new length.
    """
    start = _require_offset("start_offset", start_offset)
    end = _require_offset("end_offset", end_offset)
    if end < start:
        raise ValueError("end_offset must not be before start_offset")
    result = await _call("replace", [start, end, _require_text(text)])
    return (
        f"Replaced characters {start}-{end}; the document is now {_length(result)}."
    )


async def doc_save(file_path: str) -> str:
    """Save the open document to a JSON file in the Session workspace.

    The file is Univer's own document format, so it reproduces the document
    exactly. Put it under version control with the workspace tools to get a
    reviewable history.

    Args:
        file_path: Path relative to the Session work directory, or absolute.

    Returns:
        A short confirmation with the written path.
    """
    snapshot = await _call("snapshot")
    abs_path = _resolve_file(require_text("file_path", file_path))
    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    payload = json.dumps(snapshot, ensure_ascii=False, indent=2)
    with open(abs_path, "w", encoding="utf-8") as handle:
        handle.write(payload)
    return f"Saved the document to {display_path(abs_path)} ({len(payload)} bytes)."


def _length(result: Optional[object]) -> str:
    characters = result.get("characters") if isinstance(result, dict) else None
    return f"{characters} character(s) long" if characters is not None else "updated"


doc_tool_specs = [
    FunctionToolSpec.from_raw(tool)
    for tool in (
        doc_open,
        doc_status,
        doc_read,
        doc_append,
        doc_insert,
        doc_replace,
        doc_save,
    )
]

__all__ = [
    "DOC_TOOL_NAMES",
    "doc_open",
    "doc_status",
    "doc_read",
    "doc_append",
    "doc_insert",
    "doc_replace",
    "doc_save",
    "doc_tool_specs",
]
