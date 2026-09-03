from pathlib import Path

import pytest

from src.amphi_agent._workspace import RunWorkflowState, Workspace
from src.amphi_store import UserInput


def _run_state(generation: str = "generation-1") -> RunWorkflowState:
    return RunWorkflowState(
        workflow_id="workflow-report",
        generation=generation,
        workflow_name="Report Workflow",
        workflow_input=UserInput(
            text="Create a report from the mounted files",
            blocks=[
                {"type": "mention", "id": "mount-old", "path": "report.csv"},
                {"type": "mention", "id": "mount-kept", "path": "notes.txt"},
                {"type": "text", "value": " for this week"},
            ],
        ),
    )


async def test_run_lifecycle(agent_workspace: Workspace) -> None:
    """Final Workflow Run state:

    {
      "identity": {"workflow_id": "workflow-report", "generation": "generation-1"},
      "cursor": {"stage": "execute", "step_index": 1},
      "artifact": "result/draft.txt",
      "discarded_by_generation": true
    }

    Checks:
    1. Creation pins the Workflow identity, structured input, cursor, and populated artifacts.
    2. Closing and resuming returns the same durable Run without sharing mutable input copies.
    3. Cursor updates are idempotent while stale updates cannot advance the Run.
    4. Generation-gated discard rejects an old owner and accepts the current owner.
    """
    initial_state = _run_state()

    def populate(root: Path) -> None:
        result = root / "result"
        result.mkdir()
        (result / "draft.txt").write_text("draft report\n", encoding="utf-8")

    run = await agent_workspace.prepare_run_workflow_space(
        "create",
        initial_state=initial_state,
        populate=populate,
    )

    # Check 1: The installed Run contains one pinned identity, input, cursor, and artifact tree.
    assert agent_workspace.run_workflow is run
    assert agent_workspace.has_run_workflow
    assert (run.workflow_id, run.generation, run.workflow_name) == (
        "workflow-report",
        "generation-1",
        "Report Workflow",
    )
    assert run.workflow_input == initial_state.workflow_input
    assert (run.stage, run.step_index) == ("execute", 0)
    assert (run.root / "result" / "draft.txt").read_text(encoding="utf-8") == "draft report\n"

    copied_input = run.workflow_input
    copied_input.blocks[0]["id"] = "mutated-copy"
    agent_workspace.close_run_workflow_space()
    resumed = await agent_workspace.prepare_run_workflow_space("resume")

    # Check 2: Resume reads the persisted Run and callers cannot mutate its input through a returned copy.
    assert resumed.generation == "generation-1"
    assert resumed.workflow_input.blocks[0]["id"] == "mount-old"
    assert (resumed.root / "result" / "draft.txt").is_file()

    cursor = {
        "expected_workflow_id": "workflow-report",
        "expected_generation": "generation-1",
        "expected_stage": "execute",
        "expected_step_index": 0,
        "stage": "execute",
        "step_index": 1,
    }
    assert resumed.checkpoint_cursor(**cursor) is resumed
    assert resumed.checkpoint_cursor(**cursor) is resumed

    # Check 3: The cursor advances once and a stale generation cannot change its durable position.
    assert (resumed.stage, resumed.step_index) == ("execute", 1)
    with pytest.raises(RuntimeError, match="cursor mismatch"):
        resumed.checkpoint_cursor(
            **{
                **cursor,
                "expected_generation": "generation-stale",
                "stage": "execute",
                "step_index": 0,
            }
        )
    assert (resumed.stage, resumed.step_index) == ("execute", 1)

    # Check 4: Only the active generation can discard this Run.
    assert not await agent_workspace.discard_run_workflow(expected_generation="generation-stale")
    assert agent_workspace.has_run_workflow
    assert await agent_workspace.discard_run_workflow(expected_generation="generation-1")
    assert agent_workspace.run_workflow is None
    assert not agent_workspace.has_run_workflow
    assert not resumed.root.exists()


async def test_reference_remap(agent_workspace: Workspace) -> None:
    """Final copied Run input:

    {
      "text": "Create a report from the mounted files",
      "references": ["mount-new", "mount-kept"],
      "non_reference_blocks": "unchanged"
    }

    Checks:
    1. Copy remapping replaces only reference ids present in the supplied destination map.
    2. The rewritten structured input is durable and an identical retry is a no-op.
    """
    await agent_workspace.prepare_run_workflow_space("create", initial_state=_run_state())

    # Check 1: Matching mount ids change while unmatched ids, text, and block order remain intact.
    assert agent_workspace.remap_run_workflow_references({"mount-old": "mount-new"})
    checkpoint = agent_workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.workflow_input.text == "Create a report from the mounted files"
    assert checkpoint.workflow_input.blocks == [
        {"type": "mention", "id": "mount-new", "path": "report.csv"},
        {"type": "mention", "id": "mount-kept", "path": "notes.txt"},
        {"type": "text", "value": " for this week"},
    ]

    agent_workspace.close_run_workflow_space()
    resumed = await agent_workspace.prepare_run_workflow_space("resume")

    # Check 2: Resume observes the remapped id and replaying the same map makes no write.
    assert resumed.workflow_input.blocks[0]["id"] == "mount-new"
    assert not agent_workspace.remap_run_workflow_references({"mount-old": "mount-new"})


async def test_run_replacement(agent_workspace: Workspace) -> None:
    """Final replacement Run:

    {
      "failed_replacement": {"active_generation": "generation-old", "partial_files": "removed"},
      "successful_replacement": {"active_generation": "generation-new", "old_files": "removed"}
    }

    Checks:
    1. A population failure leaves the previously active Run and its artifacts untouched.
    2. Failed staging files are removed instead of becoming resumable state.
    3. A successful retry atomically replaces the old Run with the new generation.
    """
    def populate_old(root: Path) -> None:
        (root / "old.txt").write_text("keep old\n", encoding="utf-8")

    old = await agent_workspace.prepare_run_workflow_space(
        "create",
        initial_state=_run_state("generation-old"),
        populate=populate_old,
    )

    def fail_population(root: Path) -> None:
        (root / "partial.txt").write_text("partial replacement\n", encoding="utf-8")
        raise RuntimeError("replacement population failed")

    with pytest.raises(RuntimeError, match="replacement population failed"):
        await agent_workspace.prepare_run_workflow_space(
            "create",
            initial_state=_run_state("generation-new"),
            populate=fail_population,
        )

    # Check 1: Failed replacement cannot overwrite the active identity or artifact.
    assert agent_workspace.run_workflow is old
    assert agent_workspace.run_workflow_checkpoint() == _run_state("generation-old")
    assert (old.root / "old.txt").read_text(encoding="utf-8") == "keep old\n"

    # Check 2: No failed staging or backup directory remains available to a later resume.
    assert list(agent_workspace.work_dir.glob(".run.stage.*")) == []
    assert list(agent_workspace.work_dir.glob(".run.backup.*")) == []

    def populate_new(root: Path) -> None:
        (root / "new.txt").write_text("installed replacement\n", encoding="utf-8")

    replacement = await agent_workspace.prepare_run_workflow_space(
        "create",
        initial_state=_run_state("generation-new"),
        populate=populate_new,
    )

    # Check 3: A complete replacement becomes the only active Run tree.
    assert replacement.generation == "generation-new"
    assert not (replacement.root / "old.txt").exists()
    assert (replacement.root / "new.txt").read_text(encoding="utf-8") == "installed replacement\n"


async def test_run_recovery(agent_workspace: Workspace) -> None:
    """Final recovered Run:

    {
      "generation": "generation-1",
      "artifact": "result.txt",
      "interrupted_backup": "restored",
      "partial_staging": "removed"
    }

    Checks:
    1. A backup-only interrupted Run remains discoverable without mutating its files.
    2. Resume restores the backup and removes abandoned staging data.
    """
    def populate(root: Path) -> None:
        (root / "result.txt").write_text("durable result\n", encoding="utf-8")

    run = await agent_workspace.prepare_run_workflow_space(
        "create",
        initial_state=_run_state(),
        populate=populate,
    )
    agent_workspace.close_run_workflow_space()
    backup = run.root.with_name(".run.backup.interrupted")
    staging = run.root.with_name(".run.stage.interrupted")
    run.root.replace(backup)
    staging.mkdir()
    (staging / "partial.txt").write_text("partial\n", encoding="utf-8")

    reopened = Workspace("session-workspace", agent_workspace.session_root)
    checkpoint = reopened.run_workflow_checkpoint()

    # Check 1: Read-only discovery finds the complete backup without performing recovery.
    assert checkpoint == _run_state()
    assert backup.is_dir()
    assert staging.is_dir()
    assert not reopened.run_workflow_root.exists()

    recovered = await reopened.prepare_run_workflow_space("resume")

    # Check 2: Resume reinstalls the durable Run and cleans every interrupted temporary tree.
    assert recovered.generation == "generation-1"
    assert (recovered.root / "result.txt").read_text(encoding="utf-8") == "durable result\n"
    assert not backup.exists()
    assert not staging.exists()


async def test_invalid_run(agent_workspace: Workspace) -> None:
    """Final invalid Run state:

    {
      "checkpoint": "invalid JSON",
      "resumable": false,
      "artifacts": "not opened under an invented identity"
    }

    Checks:
    1. A malformed cursor document makes the retained Run unavailable.
    2. Resume rejects corrupted identity instead of binding the artifact directory.
    """
    run = await agent_workspace.prepare_run_workflow_space("create", initial_state=_run_state())
    (run.root / ".state.json").write_text("not json", encoding="utf-8")

    # Check 1: Corrupted Run state is never advertised as resumable.
    assert run.checkpoint() is None
    assert not run.is_available
    assert not agent_workspace.has_run_workflow

    agent_workspace.close_run_workflow_space()

    # Check 2: Resume fails rather than synthesizing a Workflow identity or cursor.
    with pytest.raises(ValueError, match="invalid JSON"):
        await agent_workspace.prepare_run_workflow_space("resume")
    assert agent_workspace.run_workflow is None
