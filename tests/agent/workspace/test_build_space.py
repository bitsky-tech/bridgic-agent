import pytest

from src.amphi_agent._workspace import Workspace


async def test_build_lifecycle(agent_workspace: Workspace) -> None:
    """Final Build state:

    {
      "resumed": {"workflow_id": "workflow-report", "stage": "generate", "task.md": "kept"},
      "replacement": {"workflow_id": null, "stage": "clarify", "old_files": "removed"},
      "discarded": true
    }

    Checks:
    1. Creating a Build binds its edit target, stage, and artifact directory.
    2. Closing and resuming preserves files and the last durable stage.
    3. Creating a replacement removes the previous Build state and artifacts.
    4. Discard removes the Build and makes a later resume unavailable.
    """
    build = await agent_workspace.prepare_build_space(
        "create",
        workflow_id="workflow-report",
        stage="explore",
    )
    task = build.root / "task.md"
    task.write_text("# Report task\n", encoding="utf-8")

    # Check 1: The new Build exposes the selected Workflow and current cognitive stage.
    assert agent_workspace.build is build
    assert agent_workspace.has_build
    assert build.workflow_id == "workflow-report"
    assert build.stage == "explore"
    assert build.root == agent_workspace.work_dir / ".build"

    build.set_stage("generate")
    agent_workspace.close_build_space()
    resumed = await agent_workspace.prepare_build_space("resume")

    # Check 2: Resume reopens the same durable Build rather than starting over.
    assert resumed.stage == "generate"
    assert resumed.workflow_id == "workflow-report"
    assert task.read_text(encoding="utf-8") == "# Report task\n"

    replacement = await agent_workspace.prepare_build_space("create", stage="clarify")

    # Check 3: A new Build replaces every artifact and identity from the previous Build.
    assert replacement.workflow_id is None
    assert replacement.stage == "clarify"
    assert not task.exists()

    await agent_workspace.discard_build()

    # Check 4: Discard removes both the binding and the resumable Build tree.
    assert agent_workspace.build is None
    assert not agent_workspace.has_build
    assert not replacement.root.exists()
    with pytest.raises(FileNotFoundError, match="missing or invalid"):
        await agent_workspace.prepare_build_space("resume")


async def test_build_receipts(agent_workspace: Workspace) -> None:
    """Final Build receipts:

    {
      "acceptance_review": {"request_id": "accept-1"},
      "edit_baseline": "# Saved task",
      "task_confirmation": {"request_id": "task-2", "task_markdown": "# Final task"}
    }

    Checks:
    1. Acceptance review identity is durable, idempotent, and cannot be rebound.
    2. The saved edit baseline is write-once but accepts an identical retry.
    3. Task confirmation rejects changed content for one request but accepts a later revision.
    4. Every receipt and the latest task confirmation survive resume.
    """
    build = await agent_workspace.prepare_build_space(
        "create",
        workflow_id="workflow-report",
        stage="clarify",
    )

    # Check 1: One acceptance request owns the Build's one-time review receipt.
    assert build.start_acceptance_review("accept-1") == "accept-1"
    assert build.start_acceptance_review("accept-1") == "accept-1"
    assert build.acceptance_review_presented
    with pytest.raises(ValueError, match="already has an acceptance review"):
        build.start_acceptance_review("accept-2")

    # Check 2: The original saved task remains the only edit baseline.
    build.record_edit_task_baseline("# Saved task")
    build.record_edit_task_baseline("# Saved task")
    with pytest.raises(RuntimeError, match="already recorded"):
        build.record_edit_task_baseline("# Different saved task")

    # Check 3: One request is immutable while a later review can replace the task snapshot.
    build.record_task_confirmation("task-1", "# Revised task")
    build.record_task_confirmation("task-1", "# Revised task")
    with pytest.raises(RuntimeError, match="snapshot changed"):
        build.record_task_confirmation("task-1", "# Corrupted task")
    build.record_task_confirmation("task-2", "# Final task")

    # Check 4: Every receipt and the latest task confirmation survive resume.
    agent_workspace.close_build_space()
    resumed = await agent_workspace.prepare_build_space("resume")
    assert resumed.acceptance_contract == {"request_id": "accept-1"}
    assert resumed.edit_task_baseline == "# Saved task"
    assert resumed.last_task_confirmation == {
        "request_id": "task-2",
        "task_markdown": "# Final task",
    }


async def test_invalid_build(agent_workspace: Workspace) -> None:
    """Final invalid Build state:

    {
      "checkpoint": "invalid JSON",
      "resumable": false
    }

    Checks:
    1. A malformed state document makes the retained Build unavailable.
    2. Resume fails instead of inventing a default state from corrupted data.
    """
    build = await agent_workspace.prepare_build_space("create")
    (build.root / ".state.json").write_text("not json", encoding="utf-8")

    # Check 1: Corrupted state is never advertised as a resumable Build.
    assert build.checkpoint() is None
    assert not build.is_available
    assert not agent_workspace.has_build

    agent_workspace.close_build_space()

    # Check 2: Resume reports the invalid Build rather than silently resetting it.
    with pytest.raises(FileNotFoundError, match="missing or invalid"):
        await agent_workspace.prepare_build_space("resume")
