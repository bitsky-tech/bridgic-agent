import asyncio
from pathlib import Path

import pytest

from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._context import AmphiContext
from src.amphi_agent._session import Session
from src.amphi_agent._state import WorkflowStageState
from src.amphi_agent._workflow_run import RunWorkflow, WorkflowRun, WorkflowRunLibrary
from src.amphi_agent._workflows import WorkflowLibrary
from src.amphi_agent._workspace import Workspace
from src.amphi_store import (
    SessionRecord,
    UserInput,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)


async def _active_completed_run(tmp_path: Path) -> Workspace:
    source = tmp_path / "workflow-source"
    package = source / "workflow"
    package.mkdir(parents=True)
    (package / "WORKFLOW.md").write_text(
        "---\nname: finalization-fixture\ndescription: Finalization fixture.\n---\n\n"
        "# Execute\n\nProduce the result.\n",
        encoding="utf-8",
    )
    (package / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )
    for name in ("task.md", "explore.md", "verify.md"):
        (source / name).write_text(f"# {name}\n", encoding="utf-8")
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    workflow_input = UserInput(text="Generate report")

    def populate(root: Path) -> None:
        RunWorkflow(root).prepare("create", source_root=source)

    space = await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": "wf-report",
            "generation": "generation-1",
            "workflow_name": "Report",
            "workflow_input": workflow_input.model_dump(mode="json"),
            "stage": "execute",
            "step_index": 0,
        },
        populate=populate,
    )
    run = RunWorkflow(space.root).prepare("resume")
    (run.result_dir / "report.md").write_text("# Report\n", encoding="utf-8")
    run.record_step(
        stage="execute",
        step_number=1,
        step_title="Execute",
        status="success",
        summary="Report generated",
    )
    space.checkpoint_cursor(
        expected_workflow_id=space.workflow_id,
        expected_generation=space.generation,
        expected_stage=space.stage,
        expected_step_index=space.step_index,
        stage="execute",
        step_index=1,
    )
    return workspace


async def _publish_completed_run(
    workspace: Workspace,
    library: WorkflowRunLibrary,
) -> WorkflowRun:
    space = await workspace.prepare_run_workflow_space("resume")
    run = RunWorkflow(space.root).prepare("resume")
    return await library.publish(
        run.root,
        result_id=library.terminal_result_id("session-1", space.generation),
        workflow_id=space.workflow_id,
        workflow_name=space.workflow_name,
        source_session_id="session-1",
        workflow_input=space.workflow_input,
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )


def test_terminal_result_id_is_stable_but_session_scoped() -> None:
    generation = "copied-generation"

    assert WorkflowRunLibrary.terminal_result_id("session-1", generation) == (
        WorkflowRunLibrary.terminal_result_id("session-1", generation)
    )
    assert WorkflowRunLibrary.terminal_result_id("session-1", generation) != (
        WorkflowRunLibrary.terminal_result_id("session-copy", generation)
    )


def _context(workspace: Workspace, workflow_runs: WorkflowRunLibrary) -> AmphiContext:
    record = SessionRecord(
        id="session-1",
        user_id="user-1",
        workspace_root=str(workspace.session_root),
    )
    space = workspace.run_workflow
    assert space is not None
    run = workflow_runs.open_run_workflow(space.root)
    workflows = WorkflowLibrary("user-1")
    workflows.open_package(
        run.source_dir,
        workflow_id=space.workflow_id,
        name=space.workflow_name,
        validate=True,
    )
    return AmphiContext(
        session=Session(record),
        workflows=workflows,
        workflow_runs=workflow_runs,
        workspace=workspace,
    )


async def test_workflow_run_library_publish_persists_terminal_result(
    connected_repo: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "published"))
    workspace = await _active_completed_run(tmp_path)
    generation = (await workspace.prepare_run_workflow_space("resume")).generation

    published = await _publish_completed_run(workspace, WorkflowRunLibrary("user-1"))

    assert workspace.has_run_workflow
    assert published.run_id == WorkflowRunLibrary.terminal_result_id(
        "session-1",
        generation,
    )
    assert published.status is WorkflowRunStatus.COMPLETED
    assert published.validation_status is WorkflowValidationStatus.NOT_REQUIRED
    rows = await WorkflowRunRepository().list_for_user("user-1")
    assert [row.id for row in rows] == [published.run_id]
    assert (published.root / "result" / "report.md").is_file()


async def test_publish_retry_reuses_result_id_after_database_failure(
    connected_repo: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "published"))
    workspace = await _active_completed_run(tmp_path)
    library = WorkflowRunLibrary("user-1")
    original_save = library._repo.create_or_confirm_terminal
    calls = 0

    async def fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database unavailable")
        return await original_save(*args, **kwargs)

    monkeypatch.setattr(library._repo, "create_or_confirm_terminal", fail_once)
    with pytest.raises(RuntimeError, match="database unavailable"):
        await _publish_completed_run(workspace, library)

    generation = (await workspace.prepare_run_workflow_space("resume")).generation
    result_id = library.terminal_result_id("session-1", generation)
    assert (tmp_path / "published" / "wf-report" / result_id).is_dir()
    assert await WorkflowRunRepository().list_for_user("user-1") == []

    published = await _publish_completed_run(workspace, library)

    assert published.run_id == result_id
    assert [row.id for row in await WorkflowRunRepository().list_for_user("user-1")] == [
        result_id
    ]


async def test_concurrent_publication_converges_on_one_durable_result_id(
    connected_repo: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "published"))
    workspace = await _active_completed_run(tmp_path)

    published = await asyncio.gather(
        _publish_completed_run(workspace, WorkflowRunLibrary("user-1")),
        _publish_completed_run(workspace, WorkflowRunLibrary("user-1")),
    )

    assert published[0].run_id == published[1].run_id
    rows = await WorkflowRunRepository().list_for_user("user-1")
    assert [row.id for row in rows] == [published[0].run_id]


async def test_agent_terminal_boundary_rejects_a_stale_generation(
    connected_repo: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "published"))
    workspace = await _active_completed_run(tmp_path)
    library = WorkflowRunLibrary("user-1")
    expected = WorkflowStageState(
        workflow_id="wf-report",
        generation="stale-generation",
        stage="execute",
        step_index=1,
    )

    with pytest.raises(RuntimeError, match="does not match"):
        await AmphiAgent._publish_workflow_run(
            _context(workspace, library),
            expected,
            status=WorkflowRunStatus.COMPLETED,
            validation_status=WorkflowValidationStatus.NOT_REQUIRED,
        )

    assert await WorkflowRunRepository().list_for_user("user-1") == []
