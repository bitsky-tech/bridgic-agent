from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord

from src.amphi_agent import (
    AmphiAgent,
    AmphiContext,
    AmphiOTAContext,
    Session,
    WorkflowLibrary,
    WorkflowRunLibrary,
)
from src.amphi_agent._state import (
    AwaitingBuildConflict,
    AwaitingPresentationOutlineConfirm,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingWorkflowRunChoice,
    BuildStageState,
    NormalStageState,
    PresentationStageState,
    WorkflowStageState,
)
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools._request_human import (
    RequestBuild,
    RequestHumanTaskConfirm,
    RequestHumanWorkflowConfirm,
    RequestRunWorkflow,
)
from src.amphi_agent.tools._presentation import PresentationStepReport
from src.amphi_agent.tools._workflow import EditWorkflow, WorkflowStepReport
from src.amphi_service.protocol import WsPresentationOutlineConfirmMessage
from src.amphi_store import (
    Repository,
    SessionRecord,
    SessionRepository,
    SessionTurnRecord,
    TurnStatus,
    UserInput,
    UserRepository,
    WorkflowRunStatus,
)
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
SESSION_ID = "session-orchestration"


@dataclass(frozen=True)
class _Harness:
    paths: IsolatedPaths
    agent: AmphiAgent
    record: SessionRecord
    context: AmphiContext
    workspace: Workspace
    workflows: WorkflowLibrary
    workflow_runs: WorkflowRunLibrary


@pytest.fixture
async def orchestration(test_sandbox: IsolatedPaths) -> AsyncIterator[_Harness]:
    """Build one isolated Agent orchestration context with real Store persistence."""
    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded(USER_ID)

        session_root = test_sandbox.sessions / SESSION_ID
        (session_root / ".work").mkdir(parents=True)
        record = SessionRecord(
            id=SESSION_ID,
            user_id=USER_ID,
            workspace_root=str(session_root),
        )
        await SessionRepository().save(record)
        workspace = Workspace(SESSION_ID, session_root)
        workflows = await WorkflowLibrary(USER_ID).load()
        workflow_runs = await WorkflowRunLibrary(USER_ID).load()
        context = AmphiContext(
            session=Session(record, []),
            workflows=workflows,
            workflow_runs=workflow_runs,
            workspace=workspace,
            execution_mode="full",
        )
        yield _Harness(
            paths=test_sandbox,
            agent=AmphiAgent(),
            record=record,
            context=context,
            workspace=workspace,
            workflows=workflows,
            workflow_runs=workflow_runs,
        )
    finally:
        await Repository.close()


def _write_package(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "task.md").write_text("# Task\n\nCreate the requested report.\n", encoding="utf-8")
    (root / "explore.md").write_text("# Explore\n\nUse the supplied request.\n", encoding="utf-8")
    (root / "verify.md").write_text(
        "# Verify\n\n## Overall verdict\nPASS\n",
        encoding="utf-8",
    )
    source = root / "workflow"
    source.mkdir()
    (source / "WORKFLOW.md").write_text(
        "---\nname: report-workflow\ndescription: Create a checked report\n---\n"
        "# Create report\n\nWrite the requested report to result/report.txt.\n",
        encoding="utf-8",
    )


def _step(tool_name: str, result: Any) -> ActionStepResult:
    return ActionStepResult(
        tool_id=f"call-{tool_name}",
        tool_name=tool_name,
        tool_arguments={},
        tool_result=result,
    )


def _ota(user_input: Any, step: ActionStepResult, think: Any = None) -> AmphiOTAContext:
    ota_context = AmphiOTAContext(
        user_input=user_input,
        ota_record=[OTARecord(action_result=ActionResult(results=[step]))],
    )
    if think is not None:
        ota_context.transition_think(think)
    return ota_context


async def _apply(harness: _Harness, ota_context: AmphiOTAContext) -> None:
    async for _ in harness.agent.after_action(ota_context, harness.context):
        pass


def _turn(ota_context: AmphiOTAContext, turn_id: str, status: TurnStatus) -> SessionTurnRecord:
    return SessionTurnRecord(
        id=turn_id,
        user_id=USER_ID,
        session_id=SESSION_ID,
        session_ordinal=0,
        user_input=UserInput.from_runtime(ota_context.user_input),
        ota_records=[record.model_dump(mode="json") for record in ota_context.ota_record],
        agent_state=ota_context.state.model_dump(mode="json"),
        status=status,
    )


def _pending(ota_context: AmphiOTAContext, turn_id: str) -> SessionTurnRecord:
    return _turn(ota_context, turn_id, TurnStatus.AWAITING_HUMAN)


def _payload(ota_context: AmphiOTAContext, tool_name: str) -> dict[str, Any]:
    for record in reversed(ota_context.ota_record):
        action = record.action_result
        results = action.get("results", []) if isinstance(action, dict) else getattr(action, "results", [])
        for result in reversed(results):
            name = result.get("tool_name") if isinstance(result, dict) else result.tool_name
            if name == tool_name:
                payload = result.get("tool_result") if isinstance(result, dict) else result.tool_result
                assert isinstance(payload, dict)
                return payload
    raise AssertionError(f"No result for {tool_name}")


async def _prepare_build(harness: _Harness, stage: str) -> None:
    build = await harness.workspace.prepare_build_space("create", stage=stage)
    _write_package(build.root)
    harness.workflows.open_package(build.root)


async def _save_workflow(harness: _Harness, source_turn_id: str) -> Any:
    source = harness.paths.root / f"source-{source_turn_id}"
    _write_package(source)
    return await harness.workflows.materialize_workflow(
        source,
        workflow_id=None,
        source_session_id=SESSION_ID,
        source_turn_id=source_turn_id,
        name=f"Report {source_turn_id}",
        description="Create a checked report",
    )


async def _start_run(harness: _Harness, workflow_id: str, request: str) -> AmphiOTAContext:
    ota_context = _ota(
        request,
        _step("request_run_workflow", RequestRunWorkflow(workflow_id, "start")),
    )
    await _apply(harness, ota_context)
    return ota_context


async def test_presentation_outline_confirmation(orchestration: _Harness) -> None:
    """An edited Plan outline resumes the parked Turn before visual design."""
    state = PresentationStageState(stage="ppt_plan", step_index=2).apply_plan_step_data(
        "collect_evidence",
        {"sources": [{
            "kind": "conversation",
            "title": "Original request",
            "excerpt": "Explain the subject to students.",
        }]},
    )
    plan = _ota(
        "Create the presentation",
        _step("report_presentation_step", PresentationStepReport(
            "Mapped the deck.",
            ["source-001"],
            {"chapters": [{
                "title": "Original chapter",
                "slides": [{
                    "title": "Original slide",
                    "source_ids": ["source-001"],
                }],
            }]},
        )),
        state,
    )
    await _apply(orchestration, plan)
    assert isinstance(plan.interaction_status, AwaitingPresentationOutlineConfirm)
    request_id = plan.interaction_status.request_id

    orchestration.context.session = Session(
        orchestration.record,
        [_pending(plan, "turn-presentation-outline")],
    )
    confirmed = AmphiOTAContext(user_input=WsPresentationOutlineConfirmMessage(
        session_id=SESSION_ID,
        request_id=request_id,
        chapters=[{
            "id": "chapter-001",
            "title": "Edited chapter",
            "slides": [{
                "id": "slide-001",
                "title": "Edited slide",
                "key_message": "Use the clearer user-owned framing.",
                "source_ids": ["source-001"],
            }],
        }],
    ))
    await orchestration.agent.init_state(confirmed, orchestration.context)

    resumed = confirmed.think_status
    assert isinstance(resumed, PresentationStageState)
    assert resumed.step_index == 3
    assert resumed.outline_confirmed is True
    assert resumed.outline_confirmation_id is None
    assert resumed.outline[0].title == "Edited chapter"
    assert resumed.outline[0].slides[0].title == "Edited slide"
    assert confirmed.interaction_status is None


async def test_build_entry(orchestration: _Harness) -> None:
    """Final Build routing:

    {
      "explicit_request": {"mode": "build", "stage": "clarify", "workspace": ".build"},
      "competing_request": {"status": "pending", "retained_build": true},
      "keep_choice": {"status": "resolved", "stage": "clarify"}
    }

    Checks:
    1. An explicit reusable request enters Clarify and creates its durable Build workspace.
    2. A competing request becomes a user choice without replacing the retained Build.
    3. Keeping the existing Build resolves the card and rebinds the retained workspace.
    """
    start = _ota(
        "Create a reusable report workflow",
        _step(
            "request_build",
            RequestBuild("Create a reusable report workflow", mode="start"),
        ),
    )
    await _apply(orchestration, start)

    # Check 1: Explicit intent enters Build and binds the newly created private workspace.
    assert start.think_status == BuildStageState(stage="clarify")
    assert orchestration.workspace.has_build
    assert orchestration.workspace.build is not None
    assert orchestration.workflows.require_package().root == orchestration.workspace.build.root
    assert _payload(start, "request_build")["mode"] == "start"
    retained_task = orchestration.workspace.build.root / "task.md"
    retained_task.write_text("# Task\n\nRetain this Build.\n", encoding="utf-8")

    ask = _ota(
        "Also build a different workflow",
        _step(
            "request_build",
            RequestBuild(
                "Build a different workflow",
                mode="ask",
                reason="Another unfinished Build already exists",
                request_id="build-conflict-1",
            ),
        ),
        BuildStageState(stage="clarify"),
    )
    await _apply(orchestration, ask)

    # Check 2: The conflict is parked while the first Build remains resumable and untouched.
    assert isinstance(ask.interaction_status, AwaitingBuildConflict)
    assert ask.interaction_status.request_id == "build-conflict-1"
    assert _payload(ask, "request_build")["status"] == "pending"
    assert orchestration.workspace.has_build
    assert orchestration.workspace.build is None
    assert orchestration.workflows.package is None
    assert retained_task.read_text(encoding="utf-8") == "# Task\n\nRetain this Build.\n"

    pending = _pending(ask, "turn-build-conflict")
    orchestration.context.session = Session(orchestration.record, [pending])
    resolved = AmphiOTAContext(user_input={
        "type": "choice_answer",
        "request_id": ask.interaction_status.request_id,
        "answers": [{"index": 0, "option_id": "keep"}],
    })
    await orchestration.agent.init_state(resolved, orchestration.context)

    # Check 3: Keeping the first intent clears the conflict and resumes its durable stage.
    assert resolved.interaction_status is None
    assert resolved.think_status == BuildStageState(stage="clarify")
    assert orchestration.workspace.build is not None
    assert orchestration.workspace.build.stage == "clarify"
    payload = _payload(resolved, "request_build")
    assert payload["status"] == "resolved"
    assert payload["action"] == "keep"


async def test_build_reviews(orchestration: _Harness) -> None:
    """Final reviewed Build contract:

    {
      "task": {"status": "confirmed", "next_stage": "explore"}
    }

    Checks:
    1. Confirming the current task.md advances both cognition and durable Build state to Explore.
    """
    await _prepare_build(orchestration, "clarify")
    task = _ota(
        "Create a reusable report workflow",
        _step("request_human_task_confirm", RequestHumanTaskConfirm("task-1")),
        BuildStageState(stage="clarify"),
    )
    await _apply(orchestration, task)
    assert isinstance(task.interaction_status, AwaitingTaskConfirm)
    pending_task = _pending(task, "turn-task")
    orchestration.context.session = Session(orchestration.record, [pending_task])
    confirmed = AmphiOTAContext(user_input={
        "type": "task_confirm",
        "request_id": "task-1",
        "action": "confirm",
    })
    await orchestration.agent.init_state(confirmed, orchestration.context)

    # Check 1: Task approval resumes the held Turn at Explore in memory and on disk.
    assert _payload(confirmed, "request_human_task_confirm")["status"] == "confirmed"
    assert confirmed.think_status == BuildStageState(stage="explore")
    checkpoint = orchestration.workspace.build_checkpoint()
    assert checkpoint is not None
    assert checkpoint.stage == "explore"
    assert orchestration.workspace.build is not None
    assert orchestration.workspace.build.last_task_confirmation == {
        "request_id": "task-1",
        "task_markdown": "# Task\n\nCreate the requested report.",
    }


async def test_build_switch(orchestration: _Harness) -> None:
    """Final admitted Build switch:

    {
      "stage_switch": {"think": "generate", "checkpoint": "generate", "handoff": "recorded"},
      "mode_exit": {"think": "normal", "build": "retained but unbound"}
    }

    Checks:
    1. An admitted stage switch updates cognition, the durable Build cursor, and its handoff note.
    2. Returning to Main closes live bindings while preserving the resumable Build at that stage.
    """
    await _prepare_build(orchestration, "explore")
    advance = _ota(
        "Create a reusable report workflow",
        _step("switch", {"mode": "build", "stage": "generate", "reason": "Exploration is complete."}),
        BuildStageState(stage="explore"),
    )
    await _apply(orchestration, advance)

    # Check 1: One admitted switch moves the in-memory and on-disk stage together.
    assert advance.think_status == BuildStageState(stage="generate")
    checkpoint = orchestration.workspace.build_checkpoint()
    assert checkpoint is not None
    assert checkpoint.stage == "generate"
    assert orchestration.workspace.build is not None
    assert orchestration.workflows.require_package().root == orchestration.workspace.build.root
    assert "`build/explore` → `build/generate`" in str(advance.ota_record[-1].observation_result)

    leave = _ota(
        "Pause this Build",
        _step("switch", {"mode": "normal", "stage": None, "reason": "Continue later."}),
        advance.think_status,
    )
    await _apply(orchestration, leave)

    # Check 2: Main receives control without deleting or silently advancing the Build.
    assert leave.think_status == NormalStageState()
    assert orchestration.workspace.has_build
    assert orchestration.workspace.build_checkpoint() == checkpoint
    assert orchestration.workspace.build is None
    assert orchestration.workflows.package is None
    assert "unfinished Build workspace was retained" in str(leave.ota_record[-1].observation_result)


async def test_terminal_rehydration(orchestration: _Harness) -> None:
    """Final state after a terminal Turn:

    {
      "build": {"mode": "build", "stage": "generate", "workspace": ".build rebound"},
      "run": {"mode": "run_workflow", "cursor": "execute/0", "workspace": ".run rebound"}
    }

    Checks:
    1. A new Turn rehydrates a retained Build from the previous terminal Turn and checkpoint.
    2. A new Turn rehydrates an unfinished Run and its pinned Workflow from the durable cursor.
    """
    await _prepare_build(orchestration, "generate")
    build_turn = AmphiOTAContext(user_input="Continue the reusable Workflow later")
    build_turn.transition_think(BuildStageState(stage="generate"))
    orchestration.workspace.close_build_space()
    orchestration.workflows.close_package()
    orchestration.context.session = Session(
        orchestration.record,
        [_turn(build_turn, "turn-terminal-build", TurnStatus.COMPLETED)],
    )
    resumed_build = AmphiOTAContext(user_input="Continue the reusable Workflow")
    await orchestration.agent.init_state(resumed_build, orchestration.context)

    # Check 1: Terminal history reopens the exact durable Build stage and package.
    assert resumed_build.think_status == BuildStageState(stage="generate")
    assert orchestration.workspace.build is not None
    assert orchestration.workspace.build.stage == "generate"
    assert orchestration.workflows.require_package().root == orchestration.workspace.build.root

    await orchestration.workspace.discard_build()
    orchestration.workflows.close_package()
    saved = await _save_workflow(orchestration, "terminal-run")
    started = await _start_run(orchestration, saved.workflow_id, "Create today's report")
    assert isinstance(started.think_status, WorkflowStageState)
    run_status = started.think_status
    orchestration.workspace.close_run_workflow_space()
    orchestration.workflow_runs.close_run_workflow()
    orchestration.workflows.close_package()
    orchestration.context.session = Session(
        orchestration.record,
        [_turn(started, "turn-terminal-run", TurnStatus.COMPLETED)],
    )
    resumed_run = AmphiOTAContext(user_input="Continue today's report")
    await orchestration.agent.init_state(resumed_run, orchestration.context)

    # Check 2: Terminal history reopens the pinned source at the authoritative Run cursor.
    assert resumed_run.think_status == run_status
    assert orchestration.workspace.run_workflow is not None
    assert orchestration.workflow_runs.run_workflow is not None
    assert orchestration.workflows.require_package().workflow_id == saved.workflow_id
    checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert (checkpoint.stage, checkpoint.step_index) == ("execute", 0)


async def test_workflow_confirmation(orchestration: _Harness) -> None:
    """Final Workflow confirmation:

    {
      "cancel": {"saved": false, "build_retained": true},
      "confirm": {"saved": true, "build_retained": false, "mode": "normal"}
    }

    Checks:
    1. Cancelling publication preserves the verified Build without creating a Workflow.
    2. A later confirmation materializes one saved package and removes the private Build.
    """
    await _prepare_build(orchestration, "verify")
    request = RequestHumanWorkflowConfirm(
        "Checked Report",
        "Create and validate the requested report",
        "workflow-confirm-1",
    )
    cancel_card = _ota(
        "Create a reusable report workflow",
        _step("request_human_workflow_confirm", request),
        BuildStageState(stage="verify"),
    )
    await _apply(orchestration, cancel_card)
    assert isinstance(cancel_card.interaction_status, AwaitingWorkflowConfirm)
    pending_cancel = _pending(cancel_card, "turn-workflow-cancel")
    orchestration.context.session = Session(orchestration.record, [pending_cancel])
    cancelled = AmphiOTAContext(user_input={
        "type": "workflow_confirm",
        "request_id": "workflow-confirm-1",
        "action": "cancel",
    })
    await orchestration.agent.init_state(cancelled, orchestration.context)

    # Check 1: Cancellation returns to Verify with the complete Build still available.
    assert _payload(cancelled, "request_human_workflow_confirm")["status"] == "cancelled"
    assert cancelled.think_status == BuildStageState(stage="verify")
    assert orchestration.workspace.has_build
    assert orchestration.workspace.build is not None
    assert orchestration.workflows.require_package().validation_reason() is None
    assert orchestration.workflows.is_empty()

    confirm_card = _ota(
        "Create a reusable report workflow",
        _step(
            "request_human_workflow_confirm",
            RequestHumanWorkflowConfirm(
                "Checked Report",
                "Create and validate the requested report",
                "workflow-confirm-2",
            ),
        ),
        BuildStageState(stage="verify"),
    )
    await _apply(orchestration, confirm_card)
    pending_confirm = _pending(confirm_card, "turn-workflow-confirm")
    orchestration.context.session = Session(orchestration.record, [pending_confirm])
    confirmed = AmphiOTAContext(user_input={
        "type": "workflow_confirm",
        "request_id": "workflow-confirm-2",
        "action": "confirm",
        "name": "Checked Report",
    })
    await orchestration.agent.init_state(confirmed, orchestration.context)

    # Check 2: Confirmation publishes one reusable package, exits Build, and deletes .build.
    result = _payload(confirmed, "request_human_workflow_confirm")
    saved = orchestration.workflows.get(result["workflow_id"])
    assert result["status"] == "confirmed"
    assert saved is not None
    assert saved.name == "Checked Report"
    assert saved.validation_reason() is None
    assert tuple(orchestration.workflows.data()) == (saved.workflow_id,)
    assert confirmed.think_status == NormalStageState()
    assert not orchestration.workspace.has_build
    assert orchestration.workspace.build is None
    assert orchestration.workflows.package is None


async def test_workflow_edit(orchestration: _Harness) -> None:
    """Final publication choices for a saved Workflow edit:

    {
      "confirm": {"workflow_id": "unchanged", "catalogue_size": 1, "content": "updated"},
      "save_as_new": {"workflow_id": "new", "catalogue_size": 2, "original": "unchanged"}
    }

    Checks:
    1. Confirming an edit replaces the selected Workflow source under its stable identity.
    2. Save-as-new publishes a distinct copy without applying copy-only changes to the original.
    """
    saved = await _save_workflow(orchestration, "workflow-edit")

    async def open_edit() -> Path:
        edit = _ota(
            "Edit the saved report Workflow",
            _step("edit_workflow", EditWorkflow(saved.workflow_id)),
        )
        await _apply(orchestration, edit)
        assert edit.think_status == BuildStageState(stage="clarify", workflow_id=saved.workflow_id)
        assert orchestration.workspace.build is not None
        return orchestration.workspace.build.root / "workflow" / "WORKFLOW.md"

    async def publish(request_id: str, action: str, name: str) -> AmphiOTAContext:
        assert orchestration.workspace.build is not None
        orchestration.workspace.build.set_stage("verify", saved.workflow_id)
        card = _ota(
            "Publish the edited Workflow",
            _step(
                "request_human_workflow_confirm",
                RequestHumanWorkflowConfirm(saved.name, "Updated report behavior", request_id),
            ),
            BuildStageState(stage="verify", workflow_id=saved.workflow_id),
        )
        await _apply(orchestration, card)
        assert isinstance(card.interaction_status, AwaitingWorkflowConfirm)
        orchestration.context.session = Session(
            orchestration.record,
            [_pending(card, f"turn-{request_id}")],
        )
        confirmed = AmphiOTAContext(user_input={
            "type": "workflow_confirm",
            "request_id": request_id,
            "action": action,
            "name": name,
        })
        await orchestration.agent.init_state(confirmed, orchestration.context)
        return confirmed

    update_source = await open_edit()
    update_source.write_text(
        update_source.read_text(encoding="utf-8").replace(
            "Write the requested report",
            "Write the updated report",
        ),
        encoding="utf-8",
    )
    updated_turn = await publish("workflow-update", "confirm", "Ignored Rename")

    # Check 1: Confirm updates source in place and retains the saved Workflow identity and name.
    updated_payload = _payload(updated_turn, "request_human_workflow_confirm")
    updated = orchestration.workflows.get(saved.workflow_id)
    assert updated_payload["status"] == "confirmed"
    assert updated_payload["operation"] == "edit"
    assert updated_payload["workflow_id"] == saved.workflow_id
    assert updated is not None
    assert updated.name == saved.name
    assert "Write the updated report" in updated.entry_path.read_text(encoding="utf-8")
    assert tuple(orchestration.workflows.data()) == (saved.workflow_id,)

    copy_source = await open_edit()
    copy_source.write_text(
        copy_source.read_text(encoding="utf-8").replace(
            "Write the updated report",
            "Write the copy-only report",
        ),
        encoding="utf-8",
    )
    copied_turn = await publish("workflow-copy", "save_as_new", "Checked Report Copy")

    # Check 2: Save-as-new creates one independent identity and leaves original source untouched.
    copied_payload = _payload(copied_turn, "request_human_workflow_confirm")
    copied = orchestration.workflows.get(copied_payload["workflow_id"])
    original = orchestration.workflows.get(saved.workflow_id)
    assert copied_payload["status"] == "confirmed"
    assert copied_payload["operation"] == "create"
    assert copied_payload["workflow_id"] != saved.workflow_id
    assert copied is not None
    assert copied.name == "Checked Report Copy"
    assert "Write the copy-only report" in copied.entry_path.read_text(encoding="utf-8")
    assert original is not None
    original_source = original.entry_path.read_text(encoding="utf-8")
    assert "Write the updated report" in original_source
    assert "copy-only" not in original_source
    assert set(orchestration.workflows.data()) == {saved.workflow_id, copied.workflow_id}


async def test_run_entry(orchestration: _Harness) -> None:
    """Final Workflow Run entry:

    {
      "start": {"stage": "execute", "step_index": 0, "source": "pinned"},
      "ambiguous_reentry": {"choice": "resume", "generation": "unchanged"},
      "restart": {"generation": "new", "cursor": "execute/0", "input": "preserved"}
    }

    Checks:
    1. Starting a saved Workflow creates a pinned private Run and enters its first section.
    2. An ambiguous re-entry parks for a choice and Resume reopens the same generation.
    3. Restart replaces the active attempt while preserving its original Workflow input.
    """
    saved = await _save_workflow(orchestration, "run-entry")
    started = await _start_run(orchestration, saved.workflow_id, "Create today's report")

    # Check 1: Start snapshots the saved source and enters its first execution section.
    assert isinstance(started.think_status, WorkflowStageState)
    assert started.think_status.workflow_id == saved.workflow_id
    assert (started.think_status.stage, started.think_status.step_index) == ("execute", 0)
    generation = started.think_status.generation
    assert _payload(started, "request_run_workflow")["status"] == "started"
    assert orchestration.workspace.run_workflow is not None
    pinned = orchestration.workflow_runs.require_run_workflow().source_dir
    assert (pinned / "workflow" / "WORKFLOW.md").is_file()

    ask = _ota(
        "Continue the report",
        _step(
            "request_run_workflow",
            RequestRunWorkflow(saved.workflow_id, "ask", "An unfinished Run exists"),
        ),
    )
    await _apply(orchestration, ask)
    assert isinstance(ask.interaction_status, AwaitingWorkflowRunChoice)
    choice = ask.interaction_status
    pending = _pending(ask, "turn-run-choice")
    orchestration.context.session = Session(orchestration.record, [pending])
    resumed = AmphiOTAContext(user_input={
        "type": "choice_answer",
        "request_id": choice.request_id,
        "answers": [{"index": 0, "option_id": "resume"}],
    })
    await orchestration.agent.init_state(resumed, orchestration.context)

    # Check 2: The explicit Resume choice binds the original snapshot and generation.
    assert isinstance(resumed.think_status, WorkflowStageState)
    assert resumed.think_status.generation == generation
    assert resumed.think_status.workflow_id == saved.workflow_id
    payload = _payload(resumed, "request_run_workflow")
    assert payload["status"] == "resolved"
    assert payload["action"] == "resume"
    assert payload["resolved_action"] == "resumed"
    checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.generation == generation

    active = orchestration.workflow_runs.require_run_workflow()
    partial = active.result_dir / "partial.txt"
    partial.write_text("discard this attempt\n", encoding="utf-8")
    restarted = _ota(
        "This text must not replace the original Run input",
        _step("request_run_workflow", RequestRunWorkflow(saved.workflow_id, "restart")),
    )
    await _apply(orchestration, restarted)

    # Check 3: Restart atomically replaces attempt-local output and resets only the generation.
    assert isinstance(restarted.think_status, WorkflowStageState)
    assert restarted.think_status.workflow_id == saved.workflow_id
    assert restarted.think_status.generation != generation
    assert (restarted.think_status.stage, restarted.think_status.step_index) == ("execute", 0)
    assert _payload(restarted, "request_run_workflow")["status"] == "restarted"
    restarted_checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert restarted_checkpoint is not None
    assert restarted_checkpoint.generation == restarted.think_status.generation
    assert (restarted_checkpoint.stage, restarted_checkpoint.step_index) == ("execute", 0)
    assert restarted_checkpoint.workflow_input.text == "Create today's report"
    assert not partial.exists()


async def test_run_completion(orchestration: _Harness) -> None:
    """Final completed Workflow Run:

    {
      "execute_success": {"run": "completed"},
      "private_run": "deleted",
      "published_result": "result/report.txt"
    }

    Checks:
    1. A successful final execution report publishes the result, returns to Main, and removes .run.
    """
    saved = await _save_workflow(orchestration, "run-completion")
    started = await _start_run(orchestration, saved.workflow_id, "Create today's report")
    assert isinstance(started.think_status, WorkflowStageState)
    active = orchestration.workflow_runs.require_run_workflow()
    (active.result_dir / "report.txt").write_text("Today's checked report\n", encoding="utf-8")

    execute = _ota(
        "Create today's report",
        _step(
            "report_workflow_step",
            WorkflowStepReport("success", "Report created", ["result/report.txt"]),
        ),
        started.think_status,
    )
    await _apply(orchestration, execute)

    # Check 1: Execution publishes immutable output, exits Workflow mode, and deletes .run.
    payload = _payload(execute, "report_workflow_step")
    published = orchestration.workflow_runs.get(payload["run_id"])
    assert payload["run_status"] == WorkflowRunStatus.COMPLETED.value
    assert published is not None
    assert published.read_file("result/report.txt") == "Today's checked report\n"
    assert execute.think_status == NormalStageState()
    assert not orchestration.workspace.has_run_workflow
    assert orchestration.workspace.run_workflow is None
    assert orchestration.workflow_runs.run_workflow is None
    assert orchestration.workflows.package is None
    assert execute.ota_record[-1].workflow_result["run_id"] == published.run_id


async def test_multi_section_execution(orchestration: _Harness) -> None:
    """Final multi-section Workflow Run:

    {
      "section_1": {"cursor": "execute/1", "run": "active"},
      "section_2": {"run": "completed"},
      "private_run": "deleted",
      "published_result": "result/report.txt"
    }

    Checks:
    1. Completing the first of two execution sections advances only to the second section.
    2. The final execution section publishes the result and cleans .run.
    """
    source = orchestration.paths.root / "multi-section-source"
    _write_package(source)
    (source / "workflow" / "WORKFLOW.md").write_text(
        "---\nname: multi-section-report\ndescription: Create a report in two steps\n---\n"
        "# Gather report source\n\nCollect the source material in background/work.\n\n"
        "# Write final report\n\nWrite the requested report to result/report.txt.\n",
        encoding="utf-8",
    )
    saved = await orchestration.workflows.materialize_workflow(
        source,
        workflow_id=None,
        source_session_id=SESSION_ID,
        source_turn_id="multi-section-source",
        name="Multi-section Report",
        description="Create a report in two steps",
    )
    started = await _start_run(orchestration, saved.workflow_id, "Create today's report")
    assert isinstance(started.think_status, WorkflowStageState)
    active = orchestration.workflow_runs.require_run_workflow()

    first = _ota(
        "Create today's report",
        _step(
            "report_workflow_step",
            WorkflowStepReport("success", "Source material gathered", ["background/work"]),
        ),
        started.think_status,
    )
    await _apply(orchestration, first)

    # Check 1: The first success keeps the Run active at the next execution section.
    first_payload = _payload(first, "report_workflow_step")
    assert isinstance(first.think_status, WorkflowStageState)
    assert (first.think_status.stage, first.think_status.step_index) == ("execute", 1)
    assert first_payload["step_number"] == 1
    assert first_payload["step_count"] == 2
    assert "run_id" not in first_payload
    checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert (checkpoint.stage, checkpoint.step_index) == ("execute", 1)
    (active.result_dir / "report.txt").write_text("Multi-section report\n", encoding="utf-8")

    second = _ota(
        "Create today's report",
        _step(
            "report_workflow_step",
            WorkflowStepReport("success", "Final report written", ["result/report.txt"]),
        ),
        first.think_status,
    )
    await _apply(orchestration, second)

    # Check 2: The final execution boundary publishes the terminal result.
    second_payload = _payload(second, "report_workflow_step")
    published = orchestration.workflow_runs.get(second_payload["run_id"])
    assert second_payload["step_number"] == 2
    assert second_payload["run_status"] == WorkflowRunStatus.COMPLETED.value
    assert published is not None
    assert published.read_file("result/report.txt") == "Multi-section report\n"
    assert second.think_status == NormalStageState()
    assert not orchestration.workspace.has_run_workflow
    assert orchestration.workspace.run_workflow is None
    assert orchestration.workflow_runs.run_workflow is None
    assert orchestration.workflows.package is None


async def test_run_failure(orchestration: _Harness) -> None:
    """Final failed Workflow Run:

    {
      "step": {"status": "failure", "summary": "Source data is unavailable"},
      "run": {"status": "failed"},
      "private_run": "deleted",
      "failure_report": "published"
    }

    Checks:
    1. A failed section becomes one durable failed result with its diagnostic report.
    2. Terminal failure returns to Main and removes every live Run binding and .run tree.
    """
    saved = await _save_workflow(orchestration, "run-failure")
    started = await _start_run(orchestration, saved.workflow_id, "Create today's report")
    assert isinstance(started.think_status, WorkflowStageState)
    failed = _ota(
        "Create today's report",
        _step(
            "report_workflow_step",
            WorkflowStepReport(
                "failure",
                "Source data is unavailable",
                ["input.csv is missing"],
            ),
        ),
        started.think_status,
    )
    await _apply(orchestration, failed)

    # Check 1: Failure is published with its terminal status and readable diagnosis.
    payload = _payload(failed, "report_workflow_step")
    published = orchestration.workflow_runs.get(payload["run_id"])
    assert payload["run_status"] == WorkflowRunStatus.FAILED.value
    assert published is not None
    assert "Source data is unavailable" in published.read_file("result/failure.md")

    # Check 2: A terminal failure cannot leave live Workflow state behind in the Session.
    assert failed.think_status == NormalStageState()
    assert not orchestration.workspace.has_run_workflow
    assert orchestration.workspace.run_workflow is None
    assert orchestration.workflow_runs.run_workflow is None
    assert orchestration.workflows.package is None
