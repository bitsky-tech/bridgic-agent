from pathlib import Path

import pytest

from src.amphi_agent._workspace import Workspace
from src.amphi_store import SessionMountRecord
from tests._support.sandbox import IsolatedPaths


async def test_prepare(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Workspace shell:

    {
      "session_files": {"existing.txt": "preserved"},
      "system_directories": [".git", ".internal", ".work"],
      "mounts": {"mount-project": "<absolute project path>", "missing": "omitted"}
    }

    Checks:
    1. Constructing a Workspace binds paths without creating the Session directory.
    2. Preparation creates the system shell once and preserves existing Session files.
    3. Mounted references resolve only known ids while the complete mount list stays available.
    """
    session_root = test_sandbox.sessions / "session-prepare"
    mounted_root = test_sandbox.root / "mounted-project"
    mounted_root.mkdir()
    mount = SessionMountRecord(
        id="mount-project",
        session_id="session-prepare",
        user_id="local",
        name="mounted-project",
        abs_path=str(mounted_root),
        kind="folder",
    )

    workspace = Workspace("session-prepare", session_root, mounts=[mount])

    # Check 1: Construction binds paths without touching the Session filesystem.
    assert workspace.session_root == session_root
    assert not session_root.exists()

    session_root.mkdir(parents=True)
    existing = session_root / "existing.txt"
    existing.write_text("preserved\n", encoding="utf-8")
    monkeypatch.setattr(workspace.environment, "prepare", lambda: None)
    await workspace.prepare_workspace()
    await workspace.prepare_workspace()

    # Check 2: Repeated preparation keeps user files and one initialized Workspace shell.
    assert existing.read_text(encoding="utf-8") == "preserved\n"
    assert workspace.work_dir.is_dir()
    assert (session_root / ".internal").is_dir()
    assert (session_root / ".git").is_dir()
    assert [item["message"] for item in workspace.checkpoints.history()] == ["Initial workspace"]

    # Check 3: Only hydrated mount ids resolve, while all mount roots remain available.
    assert workspace.reference_map(["mount-project", "missing"]) == {
        "mount-project": str(mounted_root),
    }
    assert workspace.mount_roots() == [str(mounted_root)]


async def test_version_scope(agent_workspace: Workspace) -> None:
    """Final checkpoint boundary:

    {
      "versioned": ["note.txt"],
      "excluded": [".run/.state.json"],
      "restorable_scope": ".work excluding the reserved Workflow Run tree"
    }

    Checks:
    1. A checkpoint records ordinary Workspace files without capturing the reserved Run tree.
    2. File restore refuses both the reserved Run tree and paths outside the Workspace.
    """
    note = agent_workspace.work_dir / "note.txt"
    note.write_text("checkpointed\n", encoding="utf-8")
    run_state = agent_workspace.work_dir / ".run" / ".state.json"
    run_state.parent.mkdir()
    run_state.write_text('{"generation":"active"}\n', encoding="utf-8")

    # Check 1: The reserved Run tree never becomes part of ordinary Workspace version history.
    checkpoint_id = agent_workspace.checkpoints.checkpoint("Record note")
    assert checkpoint_id is not None
    diff = agent_workspace.checkpoints.checkpoint_diff(checkpoint_id)
    assert "note.txt" in diff
    assert ".run/.state.json" not in diff

    # Check 2: Restore cannot target the reserved Run tree or escape the Workspace root.
    with pytest.raises(ValueError, match="active Workflow Run"):
        agent_workspace.checkpoints.restore_file(checkpoint_id, ".run/.state.json")
    with pytest.raises(ValueError, match="inside the workspace"):
        agent_workspace.checkpoints.restore_file(checkpoint_id, str(Path("..") / "outside.txt"))
