from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from uuid import uuid4

import pytest
from sqlmodel import select

from src.amphi_agent._workflow_run import RunWorkflow, WorkflowRunLibrary
from src.amphi_agent._workflows import WorkflowLibrary, WorkflowPackage
from src.amphi_agent._workspace import (
    RunWorkflowSpace,
    Workspace,
)
from src.amphi_store import (
    UserInput,
    WorkflowRepository,
    WorkflowRun,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)


def _workflow_source(tmp_path: Path) -> Path:
    root = tmp_path / "saved-workflow"
    package = root / "workflow"
    package.mkdir(parents=True)
    (package / "WORKFLOW.md").write_text(
        "---\n"
        "name: phase-two-fixture\n"
        "description: Exercise filesystem-only active Runs.\n"
        "---\n\n"
        "# Produce\n\nWrite the requested result.\n",
        encoding="utf-8",
    )
    (package / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )
    for name in ("task.md", "explore.md", "verify.md"):
        (root / name).write_text(
            f"# {name.removesuffix('.md')}\n\nFixture.\n",
            encoding="utf-8",
        )
    return root


async def _libraries_with_workflow(
    tmp_path: Path,
) -> tuple[WorkflowLibrary, WorkflowRunLibrary, Path]:
    source = _workflow_source(tmp_path)
    await WorkflowRepository().create(
        "user-1",
        workflow_id="wf-report",
        name="Phase two fixture",
        description="Exercise filesystem-only active Runs.",
        domain=None,
        workflow_dir=str(source),
    )
    workflows = await WorkflowLibrary("user-1").load()
    return workflows, WorkflowRunLibrary("user-1"), source


async def _prepare_active_run(
    workspace: Workspace,
    workflows: WorkflowLibrary,
    workflow_runs: WorkflowRunLibrary,
    workflow_input: UserInput,
) -> tuple[RunWorkflowSpace, RunWorkflow, WorkflowPackage]:
    async with workflows.guarded_source("wf-report") as package:
        await workflow_runs.require_completed_references(workflow_input)
        state = {
            "workflow_id": "wf-report",
            "generation": uuid4().hex,
            "workflow_name": package.name or "wf-report",
            "workflow_input": workflow_input.model_dump(mode="json"),
            "stage": "execute",
            "step_index": 0,
        }
        space = await workspace.prepare_run_workflow_space(
            "create",
            initial_state=state,
            populate=lambda root: RunWorkflow(root).prepare(
                "create",
                source_root=package.root,
            ),
        )
    active_run = RunWorkflow(space.root).prepare("resume")
    pinned = WorkflowPackage(
        active_run.source_dir,
        workflow_id=space.workflow_id,
        name=space.workflow_name,
    )
    reason = pinned.validation_reason()
    if reason:
        raise ValueError(reason)
    return space, active_run, pinned


async def test_active_run_uses_workspace_without_database_row(
    connected_repo: None,
    tmp_path: Path,
) -> None:
    workflows, workflow_runs, source = await _libraries_with_workflow(tmp_path)
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    workflow_input = UserInput(text="Generate the report")

    async def stored_runs() -> list[WorkflowRun]:
        async with WorkflowRunRepository()._session() as session:
            return list((await session.execute(select(WorkflowRun))).scalars().all())

    space, active_run, pinned = await _prepare_active_run(
        workspace,
        workflows,
        workflow_runs,
        workflow_input,
    )

    assert pinned.workflow_id == "wf-report"
    assert workspace.run_workflow is not None
    generation = space.generation
    assert space.workflow_id == "wf-report"
    assert space.workflow_name == "Phase two fixture"
    assert space.workflow_input == workflow_input
    assert space.stage == "execute"
    assert space.step_index == 0
    assert await stored_runs() == []

    step = pinned.execution_steps[0]
    active_run.record_step(
        stage=space.stage,
        step_number=step.index,
        step_title=step.title,
        status="success",
        summary="Report produced.",
    )
    space.checkpoint_cursor(
        expected_workflow_id=space.workflow_id,
        expected_generation=generation,
        expected_stage=space.stage,
        expected_step_index=space.step_index,
        stage=space.stage,
        step_index=space.step_index + 1,
    )
    assert await stored_runs() == []

    shutil.rmtree(source)
    workspace.close_run_workflow_space()
    reopened_workspace = Workspace("session-1", session_root=tmp_path / "session")
    reopened_space = await reopened_workspace.prepare_run_workflow_space("resume")
    reopened_run = RunWorkflow(reopened_space.root).prepare("resume")
    reopened = WorkflowPackage(
        reopened_run.source_dir,
        workflow_id=reopened_space.workflow_id,
        name=reopened_space.workflow_name,
    )

    assert reopened.workflow_id == "wf-report"
    assert reopened.name == "Phase two fixture"
    assert [step.title for step in reopened.execution_steps] == ["Produce"]
    assert reopened_workspace.run_workflow is not None
    assert reopened_workspace.run_workflow.step_index == 1
    assert await stored_runs() == []


async def test_cancelled_restart_keeps_the_completed_workspace_replacement(
    connected_repo: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflows, workflow_runs, _source = await _libraries_with_workflow(tmp_path)
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    await _prepare_active_run(
        workspace,
        workflows,
        workflow_runs,
        UserInput(text="first run"),
    )
    original_generation = (await workspace.prepare_run_workflow_space("resume")).generation
    installed = asyncio.Event()
    release = asyncio.Event()
    prepare = workspace.prepare_run_workflow_space

    async def delayed_prepare(operation: str, **kwargs):
        result = await prepare(operation, **kwargs)
        if operation == "create":
            installed.set()
            await release.wait()
        return result

    monkeypatch.setattr(workspace, "prepare_run_workflow_space", delayed_prepare)
    task = asyncio.create_task(_prepare_active_run(
        workspace,
        workflows,
        workflow_runs,
        UserInput(text="first run"),
    ))
    await asyncio.wait_for(installed.wait(), timeout=5)

    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    replaced = await workspace.prepare_run_workflow_space("resume")
    assert replaced.generation != original_generation
    assert replaced.workflow_input == UserInput(text="first run")


async def test_terminal_result_is_persisted_only_after_materialization(
    connected_repo: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "results"))
    _workflows, library, source = await _libraries_with_workflow(tmp_path)
    with pytest.raises(FileNotFoundError, match="unavailable"):
        await library.publish(
            tmp_path / "unavailable-active-run",
            result_id=WorkflowRunRepository.new_id(),
            workflow_id="wf-report",
            workflow_name="Phase two fixture",
            source_session_id="session-1",
            workflow_input=UserInput(text="Generate the report"),
            status=WorkflowRunStatus.COMPLETED,
            validation_status=WorkflowValidationStatus.NOT_REQUIRED,
        )
    assert await WorkflowRunRepository().list_for_user("user-1") == []

    result_id = WorkflowRunRepository.new_id()
    active_root = tmp_path / "active-run"
    active_root.mkdir()
    active_run = RunWorkflow(active_root).prepare("create", source_root=source)
    (active_run.result_dir / "report.md").write_text("# Report\n", encoding="utf-8")
    retry_dir = active_run.background_work_dir / "retry"
    retry_dir.mkdir()
    (retry_dir / "message_idempotency_key.txt").write_text(
        "delivery-key\n",
        encoding="utf-8",
    )
    (active_run.background_dir / "execution.md").write_text(
        "private execution record\n",
        encoding="utf-8",
    )

    run = await library.publish(
        active_run.root,
        result_id=result_id,
        workflow_id="wf-report",
        workflow_name="Phase two fixture",
        source_session_id="session-1",
        workflow_input=UserInput(text="Generate the report"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )

    assert run.run_id == result_id
    assert run.root == run.managed_root("wf-report", result_id)
    assert run.result_files == ("result/report.md",)
    assert run.work_files == (
        "background/work/retry/message_idempotency_key.txt",
    )
    assert run.files == (
        "result/report.md",
        "background/work/retry/message_idempotency_key.txt",
    )
    assert run.read_file("background/work/retry/message_idempotency_key.txt") == (
        "delivery-key\n"
    )
    with pytest.raises(FileNotFoundError):
        run.resolve_file("background/execution.md")
    assert [row.id for row in await WorkflowRunRepository().list_for_user("user-1")] == [
        result_id,
    ]

    confirmed = await library.publish(
        active_run.root,
        result_id=result_id,
        workflow_id="wf-report",
        workflow_name="Phase two fixture",
        source_session_id="session-1",
        workflow_input=UserInput(text="Generate the report"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )

    assert confirmed.run_id == run.run_id

    shutil.rmtree(run.background_work_dir)
    assert run.is_available
    assert run.files == ("result/report.md",)

    private_work = tmp_path / "private-work"
    private_work.mkdir()
    (private_work / "secret.txt").write_text("secret\n", encoding="utf-8")
    run.background_work_dir.symlink_to(private_work, target_is_directory=True)
    assert run.work_files == ()
    with pytest.raises(FileNotFoundError):
        run.resolve_file("background/work/secret.txt")
