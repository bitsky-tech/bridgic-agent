from __future__ import annotations

from types import SimpleNamespace

from bridgic.amphibious.builtin_tools import current_agent

from src.amphi_agent._context import AmphiOTAContext
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.tools import (
    WORKSPACE_ADVANCED_TOOL_NAMES,
    WORKSPACE_BASIC_TOOL_NAMES,
    WORKSPACE_TOOL_NAMES,
    workspace_tool_specs,
)
from src.amphi_agent.tools import _workspace as workspace_mod


def test_workspace_tool_names_and_library_registration() -> None:
    spec_names = {spec.tool_name for spec in workspace_tool_specs}
    assert WORKSPACE_TOOL_NAMES == WORKSPACE_BASIC_TOOL_NAMES | WORKSPACE_ADVANCED_TOOL_NAMES
    assert spec_names == WORKSPACE_TOOL_NAMES
    library_names = {spec.tool_name for spec in TOOL_LIBRARY.all()}
    assert WORKSPACE_TOOL_NAMES <= library_names

async def test_load_workspace_tools_sets_independent_flag() -> None:
    ota = AmphiOTAContext(user_input="x")
    token = current_agent.set(SimpleNamespace(ota_ctx=ota))
    try:
        result = await workspace_mod.load_workspace_tools()
    finally:
        current_agent.reset(token)

    assert ota.workspace_tools_loaded is True
    assert ota.browser_tool_loaded is False
    assert "workspace_checkpoint" in result
    assert "Restore tools are already available" in result


async def test_workspace_status_tool_uses_session_root(tmp_path, monkeypatch) -> None:
    from src.amphi_agent._workspace import Workspace

    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session")
    await workspace.prepare_workspace()
    session_root = workspace.session_root
    work = workspace.work_dir
    (work / "note.txt").write_text("hello\n", encoding="utf-8")

    agent = SimpleNamespace(
        ctx=SimpleNamespace(
            workspace_root=str(work),
            session=SimpleNamespace(workspace_root=str(session_root)),
            workspace=workspace,
        )
    )
    token = current_agent.set(agent)
    try:
        result = await workspace_mod.workspace_status()
    finally:
        current_agent.reset(token)

    assert "New File: note.txt (+1 lines, -0 lines)" in result
    assert "Untracked" not in result
    assert "note.txt" in result
    assert "Latest checkpoint:" in result


async def test_workspace_status_tool_shows_latest_checkpoint_when_clean(
    tmp_path,
    monkeypatch,
) -> None:
    from src.amphi_agent._workspace import Workspace

    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session")
    await workspace.prepare_workspace()
    work = workspace.work_dir
    (work / "test_01.txt").write_text("1\n", encoding="utf-8")
    (work / "test_02.txt").write_text("2\n", encoding="utf-8")
    checkpoint = workspace.checkpoints.checkpoint("Add test files")
    assert checkpoint is not None

    agent = SimpleNamespace(ctx=SimpleNamespace(workspace=workspace))
    token = current_agent.set(agent)
    try:
        result = await workspace_mod.workspace_status()
    finally:
        current_agent.reset(token)

    assert "Workspace is clean." in result
    assert f"Latest checkpoint: {checkpoint[:12]}" in result
    assert "Add test files" in result
    assert "Latest checkpoint changes:" in result
    assert "New File: test_01.txt (+1 lines, -0 lines)" in result
    assert "New File: test_02.txt (+1 lines, -0 lines)" in result


async def test_workspace_diff_tool_can_show_checkpoint_diff(tmp_path, monkeypatch) -> None:
    from src.amphi_agent._workspace import Workspace

    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session")
    await workspace.prepare_workspace()
    work = workspace.work_dir
    (work / "note.txt").write_text("hello\n", encoding="utf-8")
    checkpoint = workspace.checkpoints.checkpoint("Add note")
    assert checkpoint is not None

    agent = SimpleNamespace(ctx=SimpleNamespace(workspace=workspace))
    token = current_agent.set(agent)
    try:
        result = await workspace_mod.workspace_diff(checkpoint_id=checkpoint[:12])
        invalid = await workspace_mod.workspace_diff(
            staged=True,
            checkpoint_id=checkpoint[:12],
        )
    finally:
        current_agent.reset(token)

    assert "diff --git" in result
    assert "+hello" in result
    assert "checkpoint_id cannot be used with staged=true" in invalid
