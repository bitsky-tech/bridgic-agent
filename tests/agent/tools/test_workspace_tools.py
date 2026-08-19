from src.amphi_agent.tools._filesystem import write_file
from src.amphi_agent.tools._workspace import (
    load_workspace_tools,
    workspace_checkpoint,
    workspace_diff,
    workspace_history,
    workspace_restore,
    workspace_restore_file,
    workspace_status,
)
from tests.agent.tools._harness import ToolHarness


async def test_checkpoint_cycle(tool_harness: ToolHarness) -> None:
    """Final checkpoint history:

    {
      "checkpoint": "Baseline note",
      "tracked_file": "notes.txt",
      "latest_content": "version two",
      "workspace": "clean"
    }

    Checks:
    1. Status exposes a new Workspace file before it is checkpointed.
    2. A checkpoint records the file and appears in history with its chosen message.
    3. A later edit produces a file-scoped Git diff.
    4. Re-checkpointing the edit leaves the Workspace clean with the latest change visible.
    """
    await write_file("notes.txt", "version one\n")

    # Check 1: Status exposes a new Workspace file before it is checkpointed.
    status = await workspace_status()
    assert "Workspace changes:" in status
    assert "New File: notes.txt" in status

    # Check 2: A checkpoint records the file and appears in history with its chosen message.
    created = await workspace_checkpoint("Baseline note")
    assert created.startswith("Created workspace checkpoint ")
    history = await workspace_history()
    assert "Baseline note" in history
    checkpoint_id = created.removeprefix("Created workspace checkpoint ").removesuffix(".")
    assert "notes.txt" in await workspace_diff(checkpoint_id=checkpoint_id)

    await write_file("notes.txt", "version two\n")

    # Check 3: A later edit produces a file-scoped Git diff.
    diff = await workspace_diff(file_path="notes.txt")
    assert "-version one" in diff
    assert "+version two" in diff

    # Check 4: Re-checkpointing the edit leaves the Workspace clean with the latest change visible.
    assert (await workspace_checkpoint("Update note")).startswith("Created workspace checkpoint ")
    assert "Workspace is clean." in await workspace_status()
    assert "version two\n" == (tool_harness.workspace.work_dir / "notes.txt").read_text(encoding="utf-8")


async def test_restore_cycle(tool_harness: ToolHarness) -> None:
    """Final restored Workspace:

    {
      "notes.txt": "first",
      "extra.txt": "absent",
      ".run/state.json": "preserved",
      "dirty_state": "protected by checkpoint",
      "restore_scope": ["single file", "complete Workspace"]
    }

    Checks:
    1. Restoring one file retrieves its checkpointed content without changing another file.
    2. Restoring the complete Workspace removes later files but preserves the active Run state.
    3. Restore protects the pre-restore dirty state in checkpoint history.
    4. A clean Workspace does not create an empty checkpoint.
    5. Loading advanced versioning tools changes the current Turn tool state.
    """
    await write_file("notes.txt", "first\n")
    first_result = await workspace_checkpoint("First state")
    first_id = first_result.removeprefix("Created workspace checkpoint ").removesuffix(".")
    await write_file("notes.txt", "second\n")
    await write_file("extra.txt", "keep for now\n")
    await workspace_checkpoint("Second state")
    await write_file("notes.txt", "dirty\n")
    await write_file("extra.txt", "dirty extra\n")
    run_state = tool_harness.workspace.work_dir / ".run" / "state.json"
    run_state.parent.mkdir(parents=True)
    run_state.write_text('{"stage":"verify"}\n', encoding="utf-8")

    # Check 1: Restoring one file retrieves its checkpointed content without changing another file.
    restored = await workspace_restore_file(first_id, "notes.txt")
    assert restored == f"Restored notes.txt from checkpoint {first_id}."
    assert (tool_harness.workspace.work_dir / "notes.txt").read_text(encoding="utf-8") == "first\n"
    assert (tool_harness.workspace.work_dir / "extra.txt").read_text(encoding="utf-8") == "dirty extra\n"

    # Check 2: Complete restore removes later files while preserving active Run state.
    whole = await workspace_restore(first_id)
    assert whole == f"Restored workspace to checkpoint {first_id}."
    assert (tool_harness.workspace.work_dir / "notes.txt").read_text(encoding="utf-8") == "first\n"
    assert not (tool_harness.workspace.work_dir / "extra.txt").exists()
    assert run_state.read_text(encoding="utf-8") == '{"stage":"verify"}\n'

    # Check 3: Restore protects the pre-restore dirty state in checkpoint history.
    assert "Protection checkpoint before restore" in await workspace_history()

    # Check 4: A clean Workspace does not create an empty checkpoint.
    assert (await workspace_checkpoint("Record restore")).startswith("Created workspace checkpoint ")
    assert await workspace_checkpoint("No changes") == "Workspace is clean; no checkpoint created."

    # Check 5: Loading advanced versioning tools changes the current Turn tool state.
    assert tool_harness.ota_context.workspace_tools_loaded is False
    assert "Advanced workspace tools are loaded" in await load_workspace_tools()
    assert tool_harness.ota_context.workspace_tools_loaded is True
