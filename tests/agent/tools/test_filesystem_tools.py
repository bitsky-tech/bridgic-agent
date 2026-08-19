import os
import time

import pytest

from src.amphi_agent.tools._filesystem import edit_file, glob, grep, read_file, write_file
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

    # Check 1: A relative write creates parent directories under the Session work directory.
    created = await write_file("notes/item.txt", "Alpha\nBeta\n")
    assert created == "Created notes/item.txt (11 bytes)."
    assert target.read_text(encoding="utf-8") == "Alpha\nBeta\n"

    # Check 2: Reading returns numbered content and records the file for a targeted edit.
    numbered = await read_file("notes/item.txt")
    assert numbered.splitlines() == ["     1\tAlpha", "     2\tBeta"]

    # Check 3: A targeted edit changes only the requested text in the persisted file.
    edited = await edit_file("notes/item.txt", "Beta", "Gamma")
    assert edited == "Edited notes/item.txt: replaced 1 occurrence."
    assert target.read_text(encoding="utf-8") == "Alpha\nGamma\n"

    # Check 4: A later full write replaces the complete file without requiring another read.
    overwritten = await write_file("notes/item.txt", "Replacement")
    assert overwritten == "Overwrote notes/item.txt (11 bytes)."
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
    1. Offset and limit return the requested numbered window with a remainder marker.
    2. Oversized individual lines are bounded without losing their line number.
    3. Empty files and offsets past EOF return explicit non-error results.
    """
    await write_file("window.txt", "one\ntwo\nthree\nfour\n")

    # Check 1: Offset and limit return the requested numbered window with a remainder marker.
    window = await read_file("window.txt", offset=2, limit=2)
    assert window.splitlines() == [
        "     2\ttwo",
        "     3\tthree",
        "... [1 more lines; pass offset/limit to read further]",
    ]

    # Check 2: Oversized individual lines are bounded without losing their line number.
    await write_file("long.txt", "x" * 2_100)
    long_line = await read_file("long.txt")
    assert long_line.startswith("     1\t" + "x" * 2_000)
    assert long_line.endswith("...[line truncated]")

    # Check 3: Empty files and offsets past EOF return explicit non-error results.
    await write_file("empty.txt", "")
    assert await read_file("empty.txt") == "(File exists but is empty.)"
    assert await read_file("window.txt", offset=20) == "(Offset 20 is past the end of the file [4 lines].)"


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

    # Check 1: Glob returns matching files newest first and excludes other extensions.
    assert (await glob("*.txt", "docs")).splitlines() == ["docs/new.txt", "docs/old.txt"]

    # Check 2: Grep supports file, count, and content projections with case-insensitive matching.
    files = set((await grep("needle", glob="**/*.txt", case_insensitive=True)).splitlines())
    counts = set((await grep("needle", glob="**/*.txt", output_mode="count", case_insensitive=True)).splitlines())
    content = set((await grep("needle", glob="**/*.txt", output_mode="content", case_insensitive=True)).splitlines())
    assert files == {"docs/new.txt", "docs/old.txt"}
    assert counts == {"docs/new.txt:1", "docs/old.txt:1"}
    assert content == {"docs/new.txt:1:needle new", "docs/old.txt:1:Needle old"}

    # Check 3: Recursive Grep ignores hidden directories and honors its path glob.
    assert all(".hidden" not in result for result in files | counts | content)
    assert all("ignored.md" not in result for result in files | counts | content)
