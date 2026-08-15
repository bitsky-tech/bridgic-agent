"""Unit coverage for our own filesystem tools (tools/_filesystem.py).

We reimplement read/write/edit/glob/grep instead of using the framework
built-ins so a path argument defaults to the session workspace: relative
paths resolve against the Session work directory (absolute still works),
output paths render workspace-relative, and write_file creates parents. The
read-before-modify invariant is kept. These behaviors are owned here, so
they are pinned here.
"""

import os
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from bridgic.amphibious.builtin_tools import current_agent
from src.amphi_agent.tools._filesystem import (
    edit_file,
    glob,
    grep,
    read_file,
    write_file,
)


@contextmanager
def _agent_at(workspace: str):
    """Bind a running agent whose workspace is ``workspace`` (with a tracker)."""
    agent = SimpleNamespace(
        ctx=SimpleNamespace(workspace=SimpleNamespace(work_dir=workspace)), _read_tracker={},
    )
    token = current_agent.set(agent)
    try:
        yield agent
    finally:
        current_agent.reset(token)


async def test_path_resolution_relative_and_absolute(tmp_path) -> None:
    """A relative path lands under the workspace, parents auto-created, and the
    result echoes the workspace-relative path — not the long absolute one; an
    absolute path argument is honoured as-is."""
    with _agent_at(str(tmp_path)):
        msg = await write_file("out/report.md", "# hi\n")
        assert (tmp_path / "out" / "report.md").read_text() == "# hi\n"
        assert "out/report.md" in msg and str(tmp_path) not in msg

        body = await read_file("out/report.md")
        assert "# hi" in body

        # An absolute path argument is honoured as-is.
        await write_file(str(tmp_path / "abs.txt"), "x")
        assert (tmp_path / "abs.txt").read_text() == "x"
        assert "x" in await read_file(str(tmp_path / "abs.txt"))


async def test_relative_paths_stay_in_session_workspace_with_active_run(tmp_path) -> None:
    session_work = tmp_path / "session" / ".work"
    session_work.mkdir(parents=True)
    run_work = session_work / ".run" / "background" / "work"
    run_work.mkdir(parents=True)
    agent = SimpleNamespace(
        ctx=SimpleNamespace(workspace=SimpleNamespace(
            work_dir=str(session_work),
            run_workflow=SimpleNamespace(root=run_work.parents[1]),
        )),
        _read_tracker={},
    )
    token = current_agent.set(agent)
    try:
        await write_file("note.txt", "session\n")
        await write_file(str(run_work / "note.txt"), "run\n")
    finally:
        current_agent.reset(token)

    assert (session_work / "note.txt").read_text(encoding="utf-8") == "session\n"
    assert (run_work / "note.txt").read_text(encoding="utf-8") == "run\n"


async def test_read_before_modify_enforced(tmp_path) -> None:
    """edit_file (a surgical patch) refuses an unseen file until read_file;
    write_file (a full overwrite) needs no prior read and then makes the file
    editable (it tracks the write)."""
    (tmp_path / "data.txt").write_text("v1\n")  # created outside the tools
    with _agent_at(str(tmp_path)):
        with pytest.raises(RuntimeError, match="read_file"):
            await edit_file("data.txt", "v1", "v2")            # unseen → refused
        assert "Overwrote" in await write_file("data.txt", "v2\n")  # no read needed
        assert "Edited" in await edit_file("data.txt", "v2", "v3")  # write tracked it
    assert (tmp_path / "data.txt").read_text() == "v3\n"


async def test_glob_and_grep_return_workspace_relative(tmp_path) -> None:
    """Search tools resolve their dir against the workspace and render matches
    workspace-relative (short + copy-safe back into the path tools)."""
    with _agent_at(str(tmp_path)):
        await write_file("a.py", "import os\n# TODO fix\n")
        await write_file("pkg/b.py", "x = 1\n")

        names = await glob("**/*.py")
        assert "a.py" in names and os.path.join("pkg", "b.py") in names
        assert str(tmp_path) not in names  # relative, not absolute

        hits = await grep("TODO", output_mode="content")
        assert f"a.py:{2}:# TODO fix" in hits
