import json
import os
import re
import time

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult

from src.amphi_agent import AmphiAgent
from src.amphi_agent.tools import _filesystem
from src.amphi_agent.tools._filesystem import (
    DEFAULT_MAX_LINES,
    READ_FILE_MAX_CHARS,
    edit_file,
    glob,
    grep,
    read_file,
    write_file,
)
from tests.agent.tools._harness import ToolHarness


async def test_file_lifecycle(tool_harness: ToolHarness) -> None:
    """Final Workspace file:

    {
      "notes/item.txt": "Replacement",
      "operations": ["create", "numbered read", "targeted edit", "full overwrite"]
    }

    Checks:
    1. A relative write creates parent directories under the Session work directory.
    2. Reading returns numbered content and records the file for a targeted edit.
    3. A targeted edit changes only the requested text in the persisted file.
    4. A later full write replaces the complete file without requiring another read.
    """
    target = tool_harness.workspace.work_dir / "notes" / "item.txt"
    display_target = os.path.join("notes", "item.txt")

    # Check 1: A relative write creates parent directories under the Session work directory.
    created = await write_file("notes/item.txt", "Alpha\nBeta\n")
    assert created == f"Created {display_target} (11 bytes)."
    assert target.read_text(encoding="utf-8") == "Alpha\nBeta\n"

    # Check 2: Reading returns numbered content and records the file for a targeted edit.
    numbered = await read_file("notes/item.txt")
    assert numbered.splitlines() == [
        f"File: {json.dumps(str(target), ensure_ascii=False)}",
        "Lines: 1-2 of 2 (0 lines remaining).",
        "",
        "     1\tAlpha",
        "     2\tBeta",
    ]

    # Check 3: A targeted edit changes only the requested text in the persisted file.
    edited = await edit_file("notes/item.txt", "Beta", "Gamma")
    assert edited == f"Edited {display_target}: replaced 1 occurrence."
    assert target.read_text(encoding="utf-8") == "Alpha\nGamma\n"

    # Check 4: A later full write replaces the complete file without requiring another read.
    overwritten = await write_file("notes/item.txt", "Replacement")
    assert overwritten == f"Overwrote {display_target} (11 bytes)."
    assert target.read_text(encoding="utf-8") == "Replacement"


async def test_edit_guard(tool_harness: ToolHarness) -> None:
    """Final guarded edit:

    {
      "before_read": "rejected",
      "changed_after_read": "rejected",
      "after_reread": "accepted"
    }

    Checks:
    1. An existing file cannot be edited before the Agent reads it.
    2. An external change invalidates the prior read snapshot.
    3. Re-reading the latest content makes the intended edit safe again.
    """
    target = tool_harness.workspace.work_dir / "guarded.txt"
    target.write_text("Original", encoding="utf-8")

    # Check 1: An existing file cannot be edited before the Agent reads it.
    with pytest.raises(RuntimeError, match="must use read_file"):
        await edit_file("guarded.txt", "Original", "Edited")
    assert target.read_text(encoding="utf-8") == "Original"

    await read_file("guarded.txt")
    target.write_text("External", encoding="utf-8")
    future = time.time() + 2
    os.utime(target, (future, future))

    # Check 2: An external change invalidates the prior read snapshot.
    with pytest.raises(RuntimeError, match="changed on disk"):
        await edit_file("guarded.txt", "External", "Edited")
    assert target.read_text(encoding="utf-8") == "External"

    # Check 3: Re-reading the latest content makes the intended edit safe again.
    await read_file("guarded.txt")
    await edit_file("guarded.txt", "External", "Edited")
    assert target.read_text(encoding="utf-8") == "Edited"


async def test_edit_matches(tool_harness: ToolHarness) -> None:
    """Final explicit file mutations:

    {
      "absolute_file": "blind full overwrite allowed",
      "ambiguous_edit": "rejected without mutation",
      "replace_all": "every exact match replaced"
    }

    Checks:
    1. A full write can intentionally overwrite an unread absolute file.
    2. A targeted edit rejects duplicate matches and leaves the file unchanged.
    3. Explicit replace-all changes every exact occurrence and reports the count.
    """
    absolute = tool_harness.paths.root / "authorized.txt"
    absolute.write_text("old", encoding="utf-8")

    # Check 1: A full write can intentionally overwrite an unread absolute file.
    result = await write_file(str(absolute), "new")
    assert result == f"Overwrote {absolute} (3 bytes)."
    assert absolute.read_text(encoding="utf-8") == "new"

    repeated = tool_harness.workspace.work_dir / "repeated.txt"
    repeated.write_text("red red", encoding="utf-8")
    await read_file("repeated.txt")

    # Check 2: A targeted edit rejects duplicate matches without changing the file.
    with pytest.raises(ValueError, match="occurs 2 times"):
        await edit_file("repeated.txt", "red", "blue")
    assert repeated.read_text(encoding="utf-8") == "red red"

    # Check 3: Explicit replace-all changes every exact occurrence and reports the count.
    replaced = await edit_file("repeated.txt", "red", "blue", replace_all=True)
    assert replaced == "Edited repeated.txt: replaced 2 occurrences."
    assert repeated.read_text(encoding="utf-8") == "blue blue"


async def test_read_window(tool_harness: ToolHarness) -> None:
    """Final bounded reads:

    {
      "window": ["line 2", "line 3"],
      "remaining": 1,
      "long_line": "truncated",
      "empty_file": "recognized"
    }

    Checks:
    1. Offset and limit return the actual numbered window and remaining line count.
    2. Oversized individual lines are bounded without losing their line number.
    3. Empty files and offsets past EOF return explicit non-error results.
    """
    await write_file("window.txt", "one\ntwo\nthree\nfour\n")

    # Check 1: The result reports read facts without prescribing the next tool call.
    window = await read_file("window.txt", offset=2, limit=2)
    assert window.splitlines() == [
        f"File: {json.dumps(str(tool_harness.workspace.work_dir / 'window.txt'), ensure_ascii=False)}",
        "Lines: 2-3 of 4 (1 lines remaining).",
        "",
        "     2\ttwo",
        "     3\tthree",
        "",
        "[Output truncated: reached the 2-line read limit. Remaining file lines not shown: 1.]",
    ]

    # Check 2: Oversized individual lines are bounded without losing their line number.
    await write_file("long.txt", "x" * 2_100)
    long_line = await read_file("long.txt")
    assert long_line.split("\n\n", 1)[1].startswith("     1\t" + "x" * 2_000)
    assert long_line.endswith(
        "...[line truncated: 2100 characters exceed the 2000-character line limit; "
        "100 characters not shown]"
    )
    assert "Remaining file lines not shown" not in long_line

    # Check 3: Empty files and offsets past EOF return explicit non-error results.
    await write_file("empty.txt", "")
    assert await read_file("empty.txt") == "(File exists but is empty.)"
    assert await read_file("window.txt", offset=20) == "(Offset 20 is past the end of the file [4 lines].)"


@pytest.mark.parametrize("limit", [0, 500, 100_000])
async def test_large_file_pages(tool_harness: ToolHarness, limit: int) -> None:
    """Read every source line once without spooling or accumulating line prefixes."""
    target = tool_harness.workspace.work_dir / "requirements.txt"
    lines = [f'Requirement {index}: 中文内容 with "quoted" details ' * 2 for index in range(1464)]
    target.write_text("\n".join(lines), encoding="utf-8")
    collected: list[str] = []
    offset = 1
    page_count = 0

    while len(collected) < len(lines):
        output = await read_file("requirements.txt", offset=offset, limit=limit)
        assert len(output) <= READ_FILE_MAX_CHARS
        assert output.startswith(f"File: {json.dumps(str(target), ensure_ascii=False)}\n")
        assert "pass offset/limit" not in output
        assert "next_offset" not in output
        rows = re.findall(r"^\s*(\d+)\t(.*)$", output, re.MULTILINE)
        assert rows
        indices = [int(index) for index, _ in rows]
        assert indices == list(range(offset, offset + len(rows)))
        end = indices[-1]
        assert f"Lines: {offset}-{end} of 1464 ({1464 - end} lines remaining)." in output
        assert [content for _, content in rows] == lines[offset - 1:end]
        if end < len(lines):
            assert output.endswith(
                f"[Output truncated: reached the {READ_FILE_MAX_CHARS}-character response limit. "
                f"Remaining file lines not shown: {1464 - end}.]"
            )
        else:
            assert "[Output truncated:" not in output

        step = ActionStepResult(
            tool_id=f"read-{offset}", tool_name="read_file",
            tool_arguments={"file_path": "requirements.txt", "offset": offset, "limit": limit},
            tool_result=output,
        )
        AmphiAgent._save_large_tool_results(ActionResult(results=[step]), tool_harness.context)
        assert step.tool_result == output
        collected.extend(content for _, content in rows)
        offset = end + 1
        page_count += 1

    assert page_count > 1
    assert collected == lines
    assert target.read_text(encoding="utf-8") == "\n".join(lines)
    assert not list(tool_harness.workspace.tool_result_dir.rglob("*.txt"))
    assert await read_file("requirements.txt", offset=offset) == (
        "(Offset 1465 is past the end of the file [1464 lines].)"
    )


async def test_read_line_limit_and_long_lines(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Line and character limits both report the actual source range and truncation."""
    await write_file("blank.txt", "\n" * (DEFAULT_MAX_LINES + 1))
    # Isolate the line cap from platform-dependent absolute path lengths.
    with monkeypatch.context() as patch:
        patch.setattr(_filesystem, "READ_FILE_MAX_CHARS", READ_FILE_MAX_CHARS * 2)
        blank = await read_file("blank.txt")
    assert len(re.findall(r"^\s*\d+\t", blank, re.MULTILINE)) == DEFAULT_MAX_LINES
    assert f"Lines: 1-{DEFAULT_MAX_LINES} of {DEFAULT_MAX_LINES + 1} (1 lines remaining)." in blank
    assert blank.endswith(
        f"[Output truncated: reached the {DEFAULT_MAX_LINES}-line read limit. "
        "Remaining file lines not shown: 1.]"
    )
    assert len(blank) <= READ_FILE_MAX_CHARS * 2

    await write_file("long.txt", ("中" * 2100 + "\n") * 100)
    output = await read_file("long.txt", offset=90, limit=10)
    rows = re.findall(r"^\s*(\d+)\t(.*)$", output, re.MULTILINE)
    assert 0 < len(rows) < 10
    assert rows[0][0] == "90"
    assert all(content == "中" * 2000 + (
        "...[line truncated: 2100 characters exceed the 2000-character line limit; "
        "100 characters not shown]"
    ) for _, content in rows)
    assert output.endswith(
        f"[Output truncated: reached the {READ_FILE_MAX_CHARS}-character response limit. "
        f"Remaining file lines not shown: {100 - int(rows[-1][0])}.]"
    )
    assert len(output) <= READ_FILE_MAX_CHARS


async def test_read_reports_absolute_source_path(tool_harness: ToolHarness) -> None:
    """Relative and absolute inputs identify the same complete source path."""
    target = tool_harness.workspace.work_dir / "notes" / "requirements.txt"
    await write_file("notes/requirements.txt", "first\nsecond\n")
    relative = await read_file("notes/../notes/requirements.txt", limit=1)
    absolute = await read_file(str(target), limit=1)
    assert relative == absolute
    assert json.loads(relative.splitlines()[0].removeprefix("File: ")) == str(target)
    assert relative.endswith(
        "[Output truncated: reached the 1-line read limit. Remaining file lines not shown: 1.]"
    )
    assert "pass offset/limit" not in relative
    assert "next_offset" not in relative


@pytest.mark.parametrize("extra_characters", [0, 1])
async def test_read_complete_response_at_character_boundary(tool_harness: ToolHarness, extra_characters: int) -> None:
    """A complete response at the cap needs no space reserved for a truncation notice."""
    target = tool_harness.workspace.work_dir / "boundary.txt"
    header = (
        f"File: {json.dumps(str(target), ensure_ascii=False)}\n"
        "Lines: 1-17 of 17 (0 lines remaining).\n\n"
    )
    lines = ["x" * 1000] * 15 + ["", "tail"]
    numbered = "\n".join(f"{index:6d}\t{line}" for index, line in enumerate(lines, 1))
    padding = READ_FILE_MAX_CHARS - len(header + numbered) + extra_characters
    assert 0 < padding < 2000
    lines[15] = "y" * padding
    target.write_text("\n".join(lines), encoding="utf-8")
    complete = header + "\n".join(f"{index:6d}\t{line}" for index, line in enumerate(lines, 1))
    assert len(complete) == READ_FILE_MAX_CHARS + extra_characters

    output = await read_file(str(target))
    if extra_characters == 0:
        assert output == complete
    else:
        assert len(output) <= READ_FILE_MAX_CHARS
        rows = re.findall(r"^\s*(\d+)\t(.*)$", output, re.MULTILINE)
        assert rows
        end = int(rows[-1][0])
        assert end < len(lines)
        assert [content for _, content in rows] == lines[:end]
        assert output.endswith(
            f"[Output truncated: reached the {READ_FILE_MAX_CHARS}-character response limit. "
            f"Remaining file lines not shown: {len(lines) - end}.]"
        )
        remaining = await read_file(str(target), offset=end + 1)
        remaining_rows = re.findall(r"^\s*(\d+)\t(.*)$", remaining, re.MULTILINE)
        assert [content for _, content in rows + remaining_rows] == lines


async def test_file_search(tool_harness: ToolHarness) -> None:
    """Final search results:

    {
      "glob": ["docs/new.txt", "docs/old.txt"],
      "grep_files": ["docs/new.txt", "docs/old.txt"],
      "grep_count": {"docs/new.txt": 1, "docs/old.txt": 1},
      "hidden_files": "excluded"
    }

    Checks:
    1. Glob returns matching files newest first and excludes other extensions.
    2. Grep supports file, count, and content projections with case-insensitive matching.
    3. Recursive Grep ignores hidden directories and honors its path glob.
    """
    old_path = tool_harness.workspace.work_dir / "docs" / "old.txt"
    new_path = tool_harness.workspace.work_dir / "docs" / "new.txt"
    await write_file("docs/old.txt", "Needle old\n")
    await write_file("docs/new.txt", "needle new\n")
    await write_file("docs/ignored.md", "needle ignored\n")
    hidden = tool_harness.workspace.work_dir / ".hidden"
    hidden.mkdir()
    (hidden / "secret.txt").write_text("needle secret\n", encoding="utf-8")
    now = time.time()
    os.utime(old_path, (now - 10, now - 10))
    os.utime(new_path, (now, now))

    new_display = os.path.join("docs", "new.txt")
    old_display = os.path.join("docs", "old.txt")

    # Check 1: Glob returns matching files newest first and excludes other extensions.
    assert (await glob("*.txt", "docs")).splitlines() == [new_display, old_display]

    # Check 2: Grep supports file, count, and content projections with case-insensitive matching.
    files = set((await grep("needle", glob="**/*.txt", case_insensitive=True)).splitlines())
    counts = set((await grep("needle", glob="**/*.txt", output_mode="count", case_insensitive=True)).splitlines())
    content = set((await grep("needle", glob="**/*.txt", output_mode="content", case_insensitive=True)).splitlines())
    assert files == {new_display, old_display}
    assert counts == {f"{new_display}:1", f"{old_display}:1"}
    assert content == {f"{new_display}:1:needle new", f"{old_display}:1:Needle old"}

    # Check 3: Recursive Grep ignores hidden directories and honors its path glob.
    assert all(".hidden" not in result for result in files | counts | content)
    assert all("ignored.md" not in result for result in files | counts | content)
