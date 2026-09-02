import json

import pytest

from src.amphi_agent.tools import _doc, _sheet
from src.amphi_agent.tools._arguments import (
    require_bool,
    require_choice,
    require_int,
    require_number,
    require_rows,
    require_str_list,
    require_text,
)
from tests.agent.tools._harness import ToolHarness


class _Recorder:
    """A workbench page that records exactly what the tools sent it."""

    def __init__(self, replies: dict) -> None:
        self.calls: list[tuple[str, list]] = []
        self._replies = replies

    async def call_workbench_bridge(self, kind: str, method: str, args=None):
        self.calls.append((method, list(args or [])))
        return self._replies.get(method, "ok")


def test_a_serialized_list_is_repaired() -> None:
    """Final argument handling:

    {"json": "repaired", "python_repr": "repaired", "flat_list": "refused"}

    Checks:
    1. A list the model serialized as JSON is read back as a list.
    2. Python's own repr, with single quotes, is read back too — that is the
       form the failure in the field actually took.
    3. A flat list is refused rather than guessed at, because it could equally
       be one row or one column.
    4. The refusal shows the shape that would have worked.
    """
    # Checks 1 and 2: both serializations round-trip.
    assert require_rows('[["a", 1]]') == [["a", 1]]
    assert require_rows("[['产品']]") == [["产品"]]

    # Checks 3 and 4: an ambiguous shape is refused, with an example.
    with pytest.raises(ValueError, match=r"array of ROWS"):
        require_rows(["a", "b"])
    with pytest.raises(ValueError, match=r'\[\["Product", "Price"\]'):
        require_rows("not a list")
    with pytest.raises(ValueError, match="non-empty"):
        require_rows([])


def test_quoted_scalars_are_repaired_and_nonsense_is_refused() -> None:
    """Final argument handling:

    {"quoted_number": "repaired", "word": "refused", "bool": "repaired"}

    Checks:
    1. A quoted whole number becomes a number; a word does not.
    2. A minimum is enforced with a message naming it.
    3. A boolean written as text is understood, and a boolean is never read as
       a number.
    4. A choice is checked against the options, which the message lists.
    """
    # Check 1: quoting a number is unambiguous, so it is repaired.
    assert require_int("index", "2") == 2
    assert require_number("value", "10.5") == 10.5
    with pytest.raises(ValueError, match="index must be a whole number"):
        require_int("index", "two")

    # Check 2: bounds are part of the contract, not the page's problem.
    with pytest.raises(ValueError, match="count must be 1 or more"):
        require_int("count", 0, minimum=1)

    # Check 3: booleans travel as words, and never as numbers.
    assert require_bool("bold", "true") is True
    assert require_bool("bold", "no") is False
    with pytest.raises(ValueError, match="whole number"):
        require_int("index", True)

    # Check 4: an unknown choice is answered with the real options.
    assert require_choice("axis", "rows", ("rows", "columns")) == "rows"
    with pytest.raises(ValueError, match="axis must be one of: rows, columns"):
        require_choice("axis", "diagonals", ("rows", "columns"))

    # Blank text and non-text are both refused.
    with pytest.raises(ValueError, match="name is required"):
        require_text("name", "  ")
    with pytest.raises(ValueError, match="values must be a non-empty array"):
        require_str_list("values", [])


async def test_repaired_arguments_reach_the_page_as_the_right_type(
    tool_harness: ToolHarness,
) -> None:
    """Final page traffic:

    {"writeRange": [["a"]], "insertLines": [2, 3], "recentChanges": [5]}

    Checks:
    1. A serialized grid reaches the page as a real grid, not as text.
    2. Quoted numbers reach the page as numbers, so the page's own integer
       checks cannot reject them.
    3. The repair happens before the call, so no round trip is spent on it.
    """
    browser = _Recorder({
        "writeRange": {"a1": "A1", "columns": 1, "rows": 1},
        "insertLines": "ok",
        "recentChanges": [],
    })
    tool_harness.context.browser = browser  # type: ignore[assignment]

    # Check 1: the grid arrives as nested lists.
    await _sheet.sheet_write("A1", "[['产品']]")
    assert browser.calls[0] == ("writeRange", ["A1", [["产品"]], None])

    # Check 2: quoted numbers arrive as numbers.
    await _sheet.sheet_insert_lines("rows", "2", "3")
    assert browser.calls[1] == ("insertLines", ["rows", 2, 3, None])
    await _sheet.sheet_changes("5")
    assert browser.calls[2] == ("recentChanges", [5])

    # Check 3: one call each, so nothing was retried after a page refusal.
    assert len(browser.calls) == 3


async def test_bad_shapes_never_reach_the_page(tool_harness: ToolHarness) -> None:
    """Final page traffic:

    {"calls": []}

    Checks:
    1. Every refusal happens locally, so a wrong argument costs no round trip
       and the message can say what to send instead.
    """
    browser = _Recorder({})
    tool_harness.context.browser = browser  # type: ignore[assignment]

    for call in (
        lambda: _sheet.sheet_write("A1", ["a", "b"]),
        lambda: _sheet.sheet_read(5),
        lambda: _sheet.sheet_border("A1", "diagonal", "thin"),
        lambda: _sheet.sheet_merge("A1", "sideways"),
        lambda: _sheet.sheet_insert_lines("diagonals", 0, 1),
        lambda: _sheet.sheet_sort("A1", "x"),
        lambda: _sheet.sheet_filter("clear"),
        lambda: _sheet.sheet_validate("A1", "regex"),
        lambda: _sheet.sheet_highlight("A1", "isRed", background="#f00"),
        lambda: _doc.doc_insert("x", -1),
    ):
        with pytest.raises(ValueError):
            await call()

    # Check 1: nothing was sent.
    assert browser.calls == []


async def test_reads_are_capped_so_one_call_cannot_spend_the_context(
    tool_harness: ToolHarness,
) -> None:
    """Final read output:

    {"sheet_read": "valid JSON plus a note", "doc_read": "prefix plus a note"}

    Checks:
    1. An oversized range is cut at a row boundary, so the reply is still JSON.
    2. The note says how much was left out and what to call instead.
    3. An oversized document is cut at the end, which keeps every offset in the
       returned text correct.
    """
    browser = _Recorder({
        "readRange": {"a1": "A1", "values": [["x" * 200] for _ in range(400)]},
        "read": {"characters": 60_000, "text": "y" * 60_000},
    })
    tool_harness.context.browser = browser  # type: ignore[assignment]

    # Checks 1 and 2: the JSON half still parses, and the note explains itself.
    rendered = await _sheet.sheet_read("A1:A400")
    body, note = rendered.split("\n", 1)
    assert len(json.loads(body)) < 400
    assert "sheet_data_range" in note
    assert len(rendered) < 25_000

    # Check 3: the document keeps its head, which is what offsets count from.
    document = await _doc.doc_read()
    assert document.startswith("y" * 100)
    assert "Offsets above are still correct" in document
    assert len(document) < 25_000
