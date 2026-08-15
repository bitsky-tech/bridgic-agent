from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from uuid import uuid4

import pytest

from src.amphi_agent._workflow_run import RunWorkflow
from src.amphi_agent._workflows import WorkflowPackage
from src.amphi_agent._workspace import (
    RunWorkflowSpace,
    RunWorkflowState,
    Workspace,
)
from src.amphi_store import UserInput


def _workflow_source(tmp_path: Path, *, name: str = "fixture") -> Path:
    root = tmp_path / "saved-workflow"
    package = root / "workflow"
    package.mkdir(parents=True)
    (package / "WORKFLOW.md").write_text(
        "---\n"
        f"name: {name}\n"
        "description: Exercise RunWorkflowSpace.\n"
        "---\n\n"
        "# Collect\n\nCollect the input.\n\n"
        "# Produce\n\nWrite the result.\n",
        encoding="utf-8",
    )
    (package / "VALIDATE.md").write_text(
        "# Check\n\nCheck the result.\n",
        encoding="utf-8",
    )
    for document in ("task.md", "explore.md", "verify.md"):
        (root / document).write_text(
            f"# {document.removesuffix('.md')}\n\nFixture.\n",
            encoding="utf-8",
        )
    return root


def _workspace(tmp_path: Path) -> Workspace:
    return Workspace("session", session_root=tmp_path / "session")


async def _create_run(
    workspace: Workspace,
    source: Path,
    *,
    workflow_id: str = "wf-report",
    workflow_name: str = "Report Workflow",
    workflow_input: object = None,
) -> RunWorkflowSpace:
    stored_input = UserInput.from_runtime(workflow_input)
    return await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": workflow_id,
            "generation": uuid4().hex,
            "workflow_name": workflow_name,
            "workflow_input": stored_input.model_dump(mode="json"),
            "stage": "execute",
            "step_index": 0,
        },
        populate=lambda root: RunWorkflow(root).prepare("create", source_root=source),
    )


async def test_workspace_creates_and_resumes_a_fixed_run_snapshot(tmp_path: Path) -> None:
    source = _workflow_source(tmp_path)
    workspace = _workspace(tmp_path)
    workflow_input = UserInput(text="make a report")

    space = await _create_run(workspace, source, workflow_input=workflow_input)
    run = RunWorkflow(space.root).prepare("resume")

    assert space is workspace.run_workflow
    assert space.root == workspace.work_dir / ".run"
    assert workspace.has_run_workflow
    assert isinstance(workspace.run_workflow_checkpoint(), RunWorkflowState)
    assert space.workflow_id == "wf-report"
    assert space.workflow_name == "Report Workflow"
    assert space.workflow_input == workflow_input
    assert space.stage == "execute"
    assert space.step_index == 0
    generation = space.generation
    state_path = space.root / ".state.json"
    assert json.loads(state_path.read_text(encoding="utf-8")) == {
        "workflow_id": "wf-report",
        "generation": generation,
        "workflow_name": "Report Workflow",
        "workflow_input": {"text": "make a report", "blocks": []},
        "stage": "execute",
        "step_index": 0,
    }
    package = WorkflowPackage(run.source_dir)
    assert package.is_available
    assert run.result_dir.is_dir()
    assert run.background_work_dir.is_dir()

    pinned_workflow = package.entry_path.read_text(encoding="utf-8")
    pinned_task = (run.source_dir / "task.md").read_text(encoding="utf-8")
    (source / "workflow" / "WORKFLOW.md").write_text("# Changed\n", encoding="utf-8")
    (source / "task.md").write_text("# Changed task\n", encoding="utf-8")
    shutil.rmtree(source)
    assert package.entry_path.read_text(encoding="utf-8") == pinned_workflow
    assert (run.source_dir / "task.md").read_text(encoding="utf-8") == pinned_task

    workspace.close_run_workflow_space()
    assert workspace.run_workflow is None
    resumed = await workspace.prepare_run_workflow_space("resume")
    assert resumed is workspace.run_workflow
    assert resumed.workflow_id == "wf-report"
    assert resumed.generation == generation
    assert resumed.stage == "execute"
    assert resumed.step_index == 0


async def test_create_preserves_active_run_when_snapshot_staging_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_source = _workflow_source(tmp_path / "original", name="original")
    replacement_source = _workflow_source(tmp_path / "replacement", name="replacement")
    workspace = _workspace(tmp_path)
    original_space = await _create_run(
        workspace,
        original_source,
        workflow_id="wf-original",
        workflow_name="Original",
    )
    generation = original_space.generation
    original_run = RunWorkflow(original_space.root).prepare("resume")
    (original_run.result_dir / "old.txt").write_text("keep", encoding="utf-8")

    original_prepare = RunWorkflow.prepare

    def reject_populate(run: RunWorkflow, operation: str, *, source_root=None):
        if source_root == replacement_source:
            raise RuntimeError("snapshot staging failed")
        return original_prepare(run, operation, source_root=source_root)

    monkeypatch.setattr(RunWorkflow, "prepare", reject_populate)
    with pytest.raises(RuntimeError, match="snapshot staging failed"):
        await _create_run(
            workspace,
            replacement_source,
            workflow_id="wf-replacement",
            workflow_name="Replacement",
        )

    resumed = await workspace.prepare_run_workflow_space("resume")
    resumed_run = RunWorkflow(resumed.root).prepare("resume")
    assert resumed.workflow_id == "wf-original"
    assert resumed.generation == generation
    assert (resumed_run.result_dir / "old.txt").read_text(encoding="utf-8") == "keep"
    assert list(workspace.work_dir.glob(".run.stage.*")) == []
    assert list(workspace.work_dir.glob(".run.backup.*")) == []


async def test_create_restores_active_run_when_snapshot_install_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_source = _workflow_source(tmp_path / "original", name="original")
    replacement_source = _workflow_source(tmp_path / "replacement", name="replacement")
    workspace = _workspace(tmp_path)
    original_space = await _create_run(
        workspace,
        original_source,
        workflow_id="wf-original",
        workflow_name="Original",
    )
    generation = original_space.generation
    original_run = RunWorkflow(original_space.root).prepare("resume")
    (original_run.result_dir / "old.txt").write_text("keep", encoding="utf-8")
    replace = os.replace
    rejected = False

    def reject_staged_install(source_path: os.PathLike[str], target_path: os.PathLike[str]) -> None:
        nonlocal rejected
        source = Path(source_path)
        target = Path(target_path)
        if not rejected and source.name.startswith(".run.stage.") and target == original_space.root:
            rejected = True
            raise RuntimeError("snapshot install failed")
        replace(source, target)

    monkeypatch.setattr("src.amphi_agent._workspace.os.replace", reject_staged_install)
    with pytest.raises(RuntimeError, match="snapshot install failed"):
        await _create_run(
            workspace,
            replacement_source,
            workflow_id="wf-replacement",
            workflow_name="Replacement",
        )

    assert rejected
    resumed = await workspace.prepare_run_workflow_space("resume")
    resumed_run = RunWorkflow(resumed.root).prepare("resume")
    assert resumed.workflow_id == "wf-original"
    assert resumed.generation == generation
    assert (resumed_run.result_dir / "old.txt").read_text(encoding="utf-8") == "keep"
    assert list(workspace.work_dir.glob(".run.stage.*")) == []
    assert list(workspace.work_dir.glob(".run.backup.*")) == []


async def test_resume_recovers_an_interrupted_backup_and_removes_staging(
    tmp_path: Path,
) -> None:
    source = _workflow_source(tmp_path)
    workspace = _workspace(tmp_path)
    space = await _create_run(workspace, source)
    generation = space.generation
    run = RunWorkflow(space.root).prepare("resume")
    (run.result_dir / "kept.txt").write_text("keep", encoding="utf-8")
    backup = space.root.with_name(".run.backup.interrupted")
    staging = space.root.with_name(".run.stage.interrupted")
    space.root.replace(backup)
    staging.mkdir()
    (staging / "partial.txt").write_text("partial", encoding="utf-8")

    recovered_workspace = Workspace("session", session_root=workspace.session_root)
    recovered = await recovered_workspace.prepare_run_workflow_space("resume")
    recovered_run = RunWorkflow(recovered.root).prepare("resume")

    assert recovered.workflow_id == "wf-report"
    assert recovered.generation == generation
    assert (recovered_run.result_dir / "kept.txt").read_text(encoding="utf-8") == "keep"
    assert not backup.exists()
    assert not staging.exists()


def test_checkpoint_does_not_remove_an_in_progress_staging_tree(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    workspace.work_dir.mkdir(parents=True)
    staging = workspace.work_dir / ".run.stage.in-progress"
    staging.mkdir()
    marker = staging / "snapshot.tmp"
    marker.write_text("in progress\n", encoding="utf-8")

    assert workspace.run_workflow_checkpoint() is None
    assert marker.read_text(encoding="utf-8") == "in progress\n"


async def test_resume_accepts_and_rewrites_a_legacy_session_owner_field(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    run = await _create_run(workspace, _workflow_source(tmp_path))
    state_path = run.root / ".state.json"
    payload = json.loads(state_path.read_text(encoding="utf-8"))
    payload["source_session_id"] = "old-session"
    state_path.write_text(json.dumps(payload), encoding="utf-8")
    workspace.close_run_workflow_space()

    resumed = await workspace.prepare_run_workflow_space("resume")
    resumed.checkpoint_cursor(
        expected_workflow_id=resumed.workflow_id,
        expected_generation=resumed.generation,
        expected_stage="execute",
        expected_step_index=0,
        stage="execute",
        step_index=1,
    )

    assert "source_session_id" not in json.loads(state_path.read_text(encoding="utf-8"))


async def test_checkpoint_cursor_is_atomic_and_idempotent(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    run = await _create_run(workspace, _workflow_source(tmp_path))
    generation = run.generation
    arguments = {
        "expected_workflow_id": "wf-report",
        "expected_generation": generation,
        "expected_stage": "execute",
        "expected_step_index": 0,
        "stage": "execute",
        "step_index": 1,
    }

    assert run.checkpoint_cursor(**arguments) is run
    assert run.stage == "execute"
    assert run.step_index == 1
    assert run.checkpoint_cursor(**arguments) is run

    with pytest.raises(RuntimeError, match="cursor mismatch"):
        run.checkpoint_cursor(
            **{
                **arguments,
                "expected_generation": "stale-generation",
                "stage": "validate",
                "step_index": 0,
            }
        )
    assert json.loads((run.root / ".state.json").read_text(encoding="utf-8"))[
        "step_index"
    ] == 1


async def test_successful_step_is_idempotent_and_rejects_stale_or_changed_retries(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path)
    space = await _create_run(workspace, _workflow_source(tmp_path))
    run = RunWorkflow(space.root).prepare("resume")
    arguments = {
        "stage": "execute",
        "step_number": 1,
        "step_title": "Collect",
        "status": "success",
        "summary": "Input collected.",
        "evidence": ("result/input.json",),
    }

    run.record_step(**arguments)
    space.checkpoint_cursor(
        expected_workflow_id=space.workflow_id,
        expected_generation=space.generation,
        expected_stage="execute",
        expected_step_index=0,
        stage="execute",
        step_index=1,
    )
    run.record_step(**arguments)
    report_path = run.background_dir / "execution.md"
    report = report_path.read_text(encoding="utf-8")
    assert report.count("<!-- workflow-step:execute:1:start -->") == 1
    assert "- Evidence:\n  - result/input.json" in report

    with pytest.raises(RuntimeError, match="already reported with different content"):
        run.record_step(**{**arguments, "summary": "Different content."})
    assert space.step_index == 1
    assert report_path.read_text(encoding="utf-8") == report


async def test_failed_step_is_idempotent_and_cannot_be_rewritten_or_advanced(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path)
    space = await _create_run(workspace, _workflow_source(tmp_path))
    run = RunWorkflow(space.root).prepare("resume")
    arguments = {
        "stage": "execute",
        "step_number": 1,
        "step_title": "Collect",
        "status": "failure",
        "summary": "The input is unavailable.",
        "evidence": (),
    }

    run.record_step(**arguments)
    run.record_step(**arguments)
    report_path = run.background_dir / "execution.md"
    failure_path = run.result_dir / "failure.md"
    report = report_path.read_text(encoding="utf-8")
    failure = failure_path.read_text(encoding="utf-8")
    assert report.count("<!-- workflow-step:execute:1:start -->") == 1
    assert "The input is unavailable." in failure

    assert run.record_step(
        **{
            **arguments,
            "summary": "A different failure.",
            "evidence": ("background/retry.log",),
        }
    ) == "The input is unavailable."
    with pytest.raises(RuntimeError, match="terminal failure"):
        run.record_step(
            **{**arguments, "status": "success", "summary": "Recovered after failure."}
        )
    assert space.stage == "execute"
    assert space.step_index == 0
    assert report_path.read_text(encoding="utf-8") == report
    assert failure_path.read_text(encoding="utf-8") == failure


async def test_workspace_discards_only_the_expected_generation(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    run = await _create_run(workspace, _workflow_source(tmp_path))
    generation = run.generation

    assert not await workspace.discard_run_workflow(expected_generation="stale-generation")
    assert workspace.has_run_workflow
    assert (await workspace.prepare_run_workflow_space("resume")).generation == generation

    assert await workspace.discard_run_workflow(expected_generation=generation)
    assert workspace.run_workflow is None
    assert not workspace.has_run_workflow
    assert not run.root.exists()
    assert not await workspace.discard_run_workflow(expected_generation=generation)


async def test_run_rejects_source_and_active_tree_symlink_boundaries(tmp_path: Path) -> None:
    source = _workflow_source(tmp_path)
    workspace = _workspace(tmp_path)
    source_link = tmp_path / "source-link"
    source_link.symlink_to(source, target_is_directory=True)

    with pytest.raises(FileNotFoundError):
        await _create_run(workspace, source_link)

    workspace.work_dir.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    run_root = workspace.work_dir / ".run"
    run_root.symlink_to(outside, target_is_directory=True)
    assert not workspace.has_run_workflow
    with pytest.raises(FileNotFoundError):
        await workspace.prepare_run_workflow_space("resume")

    await workspace.discard_run_workflow()
    assert not run_root.exists()
    assert sentinel.read_text(encoding="utf-8") == "keep"


async def test_run_rejects_symlinked_state_without_following_it(
    tmp_path: Path,
) -> None:
    source = _workflow_source(tmp_path)
    workspace = _workspace(tmp_path)
    run = await _create_run(workspace, source)
    outside = tmp_path / "outside"
    outside.mkdir()

    state_path = run.root / ".state.json"
    durable_state = state_path.read_text(encoding="utf-8")
    external_state = outside / "state.json"
    external_state.write_text(durable_state, encoding="utf-8")
    state_path.unlink()
    state_path.symlink_to(external_state)
    assert not workspace.has_run_workflow
    with pytest.raises(FileNotFoundError):
        await workspace.prepare_run_workflow_space("resume")
    with pytest.raises(FileNotFoundError):
        run.checkpoint_cursor(
            expected_workflow_id="wf-report",
            expected_generation=json.loads(durable_state)["generation"],
            expected_stage="execute",
            expected_step_index=0,
            stage="execute",
            step_index=1,
        )
    await workspace.discard_run_workflow()
    assert external_state.read_text(encoding="utf-8") == durable_state
