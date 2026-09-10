from collections.abc import AsyncIterator
from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord, StepToolCall
from bridgic.amphibious._type import ThinkResult

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
    AwaitingPresentationTemplateSelection,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingWorkflowRunChoice,
    BuildStageState,
    NormalStageState,
    PresentationStageState,
    RoundPermission,
    WorkflowStageState,
)
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools.build import (
    RequestHumanTaskConfirm,
    RequestHumanWorkflowConfirm,
)
from src.amphi_agent.tools.powerpoint import PresentationStepReport
from src.amphi_agent.tools.workflow import EditWorkflow, RequestRunWorkflow, WorkflowStepReport
from src.amphi_service.protocol import (
    WsPresentationOutlineConfirmMessage,
    WsPresentationTemplateSelectionMessage,
)
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
from tests.agent.core.test_action_boundary import _call, _invoke


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


async def _execute_call(harness: _Harness, ota_context: AmphiOTAContext, call: StepToolCall) -> ActionStepResult:
    """Run one proposed call through the selected worker's admission and result pipeline."""
    record = OTARecord(think_result=ThinkResult(step_content="Handle the requested operation", tool_calls=[call]))
    record.permission = RoundPermission(execution_mode="full")
    ota_context.ota_record.append(record)
    ota_context.tools = harness.agent._select_current_tools(ota_context, harness.context)
    ota_context.think_result = await _invoke(harness.agent.before_action(ota_context, harness.context))
    ota_context.action_result = await harness.agent.action_tool_call(ota_context, harness.context)
    await _apply(harness, ota_context)
    return next(step for step in ota_context.action_result.results if step.tool_id == call.call_id)


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


async def _start_run(harness: _Harness, workflow_id: str, request: str | UserInput) -> AmphiOTAContext:
    ota_context = _ota(
        request,
        _step("request_run_workflow", RequestRunWorkflow(workflow_id, "start")),
    )
    await _apply(harness, ota_context)
    return ota_context


async def test_presentation_outline_confirmation(orchestration: _Harness) -> None:
    """An edited Plan outline resumes the parked Turn before visual design."""
    state = PresentationStageState(stage="ppt_plan", step_index=1).apply_plan_step_data(
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
                    "content_outline": ["Introduce the original framing."],
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
                "content_outline": ["Open with the audience's central question."],
                "source_ids": ["source-001"],
            }],
        }],
    ))
    await orchestration.agent.init_state(confirmed, orchestration.context)

    resumed = confirmed.think_status
    assert isinstance(resumed, PresentationStageState)
    assert resumed.step_index == 2
    assert resumed.outline_confirmed is True
    assert resumed.outline_confirmation_id is None
    assert resumed.outline[0].title == "Edited chapter"
    assert resumed.outline[0].slides[0].title == "Edited slide"
    assert resumed.outline[0].slides[0].content_outline == [
        "Open with the audience's central question."
    ]
    assert confirmed.interaction_status is None
    assert _payload(confirmed, "report_presentation_step")["status"] == "confirmed"


async def test_presentation_outline_direct_feedback_returns_to_slide_mapping(orchestration: _Harness) -> None:
    """A chat reply to the outline review reopens the combined narrative and page-map step."""
    state = PresentationStageState(stage="ppt_plan", step_index=1).apply_plan_step_data(
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
                    "content_outline": ["Introduce the original framing."],
                    "source_ids": ["source-001"],
                }],
            }]},
        )),
        state,
    )
    await _apply(orchestration, plan)
    assert isinstance(plan.interaction_status, AwaitingPresentationOutlineConfirm)

    orchestration.context.session = Session(
        orchestration.record,
        [_pending(plan, "turn-presentation-outline-feedback")],
    )
    revised = AmphiOTAContext(user_input="Make the opening shorter and add a comparison slide.")
    await orchestration.agent.init_state(revised, orchestration.context)

    resumed = revised.think_status
    assert isinstance(resumed, PresentationStageState)
    assert resumed.step_index == 1
    assert resumed.outline_confirmed is False
    assert resumed.outline_confirmation_id is None
    assert all(report.step_id != "map_slides" for report in resumed.reports)
    assert revised.interaction_status is None
    assert _payload(revised, "report_presentation_step")["status"] == "revision_requested"


async def test_presentation_template_selection(orchestration: _Harness) -> None:
    """A retrieved shortlist parks Plan and the selected template resumes the same Turn."""
    candidate = {
        "template_id": "template-editorial-1",
        "version": "sha256:test",
        "title": "Editorial Research",
        "aspect_ratio": "16:9",
        "slide_count": 18,
        "semantic_tags": ["editorial", "research"],
        "strengths": ["cover", "timeline"],
        "colors": ["#F7F4EE", "#25324A", "#7566E8"],
        "fonts": ["Aptos"],
        "preview_paths": [f"/templates/previews/editorial-{index}.jpg" for index in range(1, 7)],
        "role_coverage": 0.8,
        "agentic_fit": "strong",
        "agentic_reason": "The editorial hierarchy fits the confirmed research outline.",
        "agentic_use_for_roles": ["cover", "content", "timeline"],
        "agentic_risks": [],
        "structural_evidence": {"representative_slides": [1, 3, 8]},
        "materialize_ref": {"provider": "local", "path": "/templates/editorial.pptx"},
    }
    state = PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        goal="Explain a research strategy",
        outline_confirmed=True,
    )
    plan = _ota(
        "Create the presentation",
        _step("ppt_rag", json.dumps({"candidates": [candidate]})),
        state,
    )

    await _apply(orchestration, plan)

    assert isinstance(plan.interaction_status, AwaitingPresentationTemplateSelection)
    request_id = plan.interaction_status.request_id
    assert plan.think_status.template_selection_status == "pending"
    assert plan.think_status.template_candidates[0].template_id == "template-editorial-1"
    receipt = _payload(plan, "ppt_rag")
    assert receipt["status"] == "awaiting_template_selection"
    assert receipt["candidate_ids"] == ["template-editorial-1"]
    assert "candidates" not in receipt

    orchestration.context.session = Session(
        orchestration.record,
        [_pending(plan, "turn-presentation-template")],
    )
    selected = AmphiOTAContext(user_input=WsPresentationTemplateSelectionMessage(
        session_id=SESSION_ID,
        request_id=request_id,
        action="select",
        template_id="template-editorial-1",
    ))
    await orchestration.agent.init_state(selected, orchestration.context)

    resumed = selected.think_status
    assert isinstance(resumed, PresentationStageState)
    assert resumed.template_selection_status == "selected"
    assert resumed.template_selection_id is None
    assert resumed.selected_template is not None
    assert resumed.selected_template.template_id == "template-editorial-1"
    assert len(resumed.selected_template.preview_paths) == 6
    assert selected.interaction_status is None
    assert _payload(selected, "ppt_rag")["status"] == "selected"
    assert _payload(selected, "ppt_rag")["selected_template_id"] == "template-editorial-1"
    assert set(_payload(selected, "ppt_rag")) == {
        "search_id", "template_selection_id", "status", "selected_template_id", "feedback",
    }
    assert _payload(selected, "ppt_rag")["template_selection_id"] == request_id
    assert "/templates/previews/" not in str(selected.ota_record[-1].observation_result)


async def test_presentation_template_refresh_excludes_the_current_batch(orchestration: _Harness) -> None:
    """Another-batch resumes Plan with the previous ids excluded from the next retrieval."""
    candidate = {
        "template_id": "template-first-batch",
        "version": "sha256:test",
        "title": "First batch",
    }
    state = PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        outline_confirmed=True,
    )
    plan = _ota(
        "Create the presentation",
        _step("ppt_rag", json.dumps({"candidates": [candidate]})),
        state,
    )
    await _apply(orchestration, plan)
    assert isinstance(plan.interaction_status, AwaitingPresentationTemplateSelection)
    request_id = plan.interaction_status.request_id
    orchestration.context.session = Session(
        orchestration.record,
        [_pending(plan, "turn-presentation-template-refresh")],
    )
    refreshed = AmphiOTAContext(user_input=WsPresentationTemplateSelectionMessage(
        session_id=SESSION_ID,
        request_id=request_id,
        action="refresh",
    ))

    await orchestration.agent.init_state(refreshed, orchestration.context)

    resumed = refreshed.think_status
    assert isinstance(resumed, PresentationStageState)
    assert resumed.template_selection_status == "idle"
    assert resumed.template_selection_id is None
    assert resumed.template_candidates == []
    assert resumed.template_excluded_ids == ["template-first-batch"]
    assert _payload(refreshed, "ppt_rag")["status"] == "refresh_requested"


async def test_presentation_template_failure_can_be_skipped(orchestration: _Harness) -> None:
    """A failed retrieval still parks on a user choice that can advance without a template."""
    state = PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        outline_confirmed=True,
    )
    plan = _ota(
        "Create the presentation",
        _step("ppt_rag", json.dumps({
            "status": "retrieval_failed",
            "retrieval_error": "The local template index is unavailable.",
            "candidates": [],
        })),
        state,
    )

    await _apply(orchestration, plan)

    assert isinstance(plan.interaction_status, AwaitingPresentationTemplateSelection)
    assert plan.think_status.template_candidates == []
    assert plan.think_status.template_selection_error == "The local template index is unavailable."
    request_id = plan.interaction_status.request_id
    orchestration.context.session = Session(
        orchestration.record,
        [_pending(plan, "turn-presentation-template-failure")],
    )
    skipped = AmphiOTAContext(user_input=WsPresentationTemplateSelectionMessage(
        session_id=SESSION_ID,
        request_id=request_id,
        action="skip",
    ))

    await orchestration.agent.init_state(skipped, orchestration.context)

    resumed = skipped.think_status
    assert isinstance(resumed, PresentationStageState)
    assert resumed.template_selection_status == "skipped"
    assert resumed.template_selection_error is None
    assert skipped.interaction_status is None


async def test_presentation_template_retry_after_exhaustion_resets_exclusions(orchestration: _Harness) -> None:
    """Retrying an empty batch starts again from the full catalogue."""
    state = PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        outline_confirmed=True,
        template_excluded_ids=["template-previous"],
    )
    plan = _ota(
        "Create the presentation",
        _step("ppt_rag", json.dumps({
            "status": "retrieval_failed",
            "retrieval_error": "No new candidates remain.",
            "candidates": [],
        })),
        state,
    )
    await _apply(orchestration, plan)
    assert isinstance(plan.interaction_status, AwaitingPresentationTemplateSelection)
    request_id = plan.interaction_status.request_id
    orchestration.context.session = Session(
        orchestration.record,
        [_pending(plan, "turn-presentation-template-retry")],
    )
    retried = AmphiOTAContext(user_input=WsPresentationTemplateSelectionMessage(
        session_id=SESSION_ID,
        request_id=request_id,
        action="refresh",
    ))

    await orchestration.agent.init_state(retried, orchestration.context)

    resumed = retried.think_status
    assert isinstance(resumed, PresentationStageState)
    assert resumed.template_selection_status == "idle"
    assert resumed.template_selection_error is None
    assert resumed.template_excluded_ids == []


async def test_ppt_rag_preserves_full_candidates_until_after_action(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Plan retains the complete shortlist and compacts it only during result handling."""
    candidate = {
        "template_id": "template-large",
        "version": "sha256:test",
        "title": "Large candidate",
        "structural_evidence": {"overview": "x" * 20_000},
        "materialize_ref": {"template_id": "template-large", "version": "sha256:test"},
    }
    state = PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        outline_confirmed=True,
    )
    payload = json.dumps({"search_id": "search-large", "candidates": [candidate]})
    result = ActionResult(results=[_step("ppt_rag", payload)])
    ota_context = AmphiOTAContext(ota_record=[OTARecord()])
    ota_context.transition_think(state)

    async def execute_tool_calls(ota_context: AmphiOTAContext, context: AmphiContext) -> ActionResult:
        return result

    monkeypatch.setattr(orchestration.agent, "_execute_tool_calls", execute_tool_calls)
    executed = await orchestration.agent.action_tool_call(ota_context, orchestration.context)
    assert executed is result
    assert result.results[0].tool_result == payload
    assert result.results[0].success is True
    assert ota_context.think_status == state
    assert ota_context.think_status.template_candidates == []
    assert ota_context.interaction_status is None
    assert not orchestration.workspace.tool_result_dir.exists()

    ota_context.action_result = executed
    await _apply(orchestration, ota_context)

    receipt = result.results[0].tool_result
    assert isinstance(receipt, dict)
    assert receipt["status"] == "awaiting_template_selection"
    assert receipt["candidate_ids"] == ["template-large"]
    assert len(json.dumps(receipt)) < 16 * 1024
    retained = ota_context.think_status.template_candidates[0]
    assert retained.model_dump(include=set(candidate)) == candidate
    assert isinstance(ota_context.interaction_status, AwaitingPresentationTemplateSelection)
    assert not orchestration.workspace.tool_result_dir.exists()

    pending_state = ota_context.state.model_dump(mode="json")
    original_receipt = dict(receipt)
    await _apply(orchestration, ota_context)

    assert ota_context.state.model_dump(mode="json") == pending_state
    assert result.results[0].tool_result == original_receipt
    assert result.results[0].success is True
    assert not orchestration.workspace.tool_result_dir.exists()


async def test_invalid_ppt_rag_payload_is_rejected_after_action_without_spill(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Plan rejects malformed data after execution and clears the failed payload."""
    state = PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        outline_confirmed=True,
    )
    payload = "{" + "x" * 20_000
    result = ActionResult(results=[_step("ppt_rag", payload)])
    ota_context = AmphiOTAContext(ota_record=[OTARecord()])
    ota_context.transition_think(state)

    async def execute_tool_calls(ota_context: AmphiOTAContext, context: AmphiContext) -> ActionResult:
        return result

    monkeypatch.setattr(orchestration.agent, "_execute_tool_calls", execute_tool_calls)
    executed = await orchestration.agent.action_tool_call(ota_context, orchestration.context)
    assert executed is result
    assert not orchestration.workspace.tool_result_dir.exists()

    step = result.results[0]
    assert step.success is True
    assert step.tool_result == payload
    assert step.error is None
    assert ota_context.think_status == state
    assert ota_context.interaction_status is None

    ota_context.action_result = executed
    await _apply(orchestration, ota_context)

    assert step.success is False
    assert step.tool_result is None
    assert step.error is not None and "invalid JSON" in step.error
    assert ota_context.think_status == state
    assert ota_context.interaction_status is None
    assert not orchestration.workspace.tool_result_dir.exists()

    original_error = step.error
    await _apply(orchestration, ota_context)

    assert step.success is False
    assert step.tool_result is None
    assert step.error == original_error
    assert ota_context.think_status == state
    assert ota_context.interaction_status is None
    assert not orchestration.workspace.tool_result_dir.exists()


@pytest.mark.parametrize("legacy_pending", [False, True], ids=["main-card", "legacy-build-card"])
async def test_build_entry(orchestration: _Harness, legacy_pending: bool) -> None:
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
    start = AmphiOTAContext(user_input="Create a reusable report workflow")
    entered = await _execute_call(orchestration, start, _call(
        "build-entry", "request_build", goal="Create a reusable report workflow", mode="start",
    ))
    assert entered.success is True

    # Check 1: Explicit intent enters Build and binds the newly created private workspace.
    assert start.think_status == BuildStageState(stage="clarify")
    assert orchestration.workspace.has_build
    assert orchestration.workspace.build is not None
    assert orchestration.workflows.require_package().root == orchestration.workspace.build.root
    assert _payload(start, "request_build")["mode"] == "start"
    retained_task = orchestration.workspace.build.root / "task.md"
    retained_task.write_text("# Task\n\nRetain this Build.\n", encoding="utf-8")

    blocked = await _execute_call(orchestration, start, _call(
        "build-reentry", "request_build", goal="Build a different workflow", mode="start",
    ))
    assert blocked.success is False
    assert "not available" in blocked.error
    assert start.think_status == BuildStageState(stage="clarify")
    assert retained_task.read_text(encoding="utf-8") == "# Task\n\nRetain this Build.\n"
    exited = await _execute_call(orchestration, start, _call("build-exit", "switch", mode="normal"))
    assert exited.success is True
    assert start.think_status == NormalStageState()
    ask = start
    requested = await _execute_call(orchestration, ask, _call(
        "build-conflict", "request_build", goal="Build a different workflow", mode="ask",
        reason="Another unfinished Build already exists",
    ))
    assert requested.success is True
    assert ask.think_status == NormalStageState()

    # Check 2: The conflict is parked while the first Build remains resumable and untouched.
    assert isinstance(ask.interaction_status, AwaitingBuildConflict)
    assert _payload(ask, "request_build")["status"] == "pending"
    assert orchestration.workspace.has_build
    assert orchestration.workspace.build is None
    assert orchestration.workflows.package is None
    assert retained_task.read_text(encoding="utf-8") == "# Task\n\nRetain this Build.\n"

    if legacy_pending:
        # Older releases parked this same card while the Build worker remained selected.
        ask.transition_think(BuildStageState(stage="clarify"))
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


@pytest.mark.parametrize("choice", ["keep", "replace_edit"])
async def test_competing_workflow_edit_stays_in_main_until_the_user_chooses(orchestration: _Harness, choice: str) -> None:
    """Main preserves the retained Build while resolving a different saved Workflow target."""
    retained = await _save_workflow(orchestration, "retained-edit")
    requested = await _save_workflow(orchestration, "requested-edit")
    ota_context = AmphiOTAContext(user_input="Edit the selected saved Workflow")
    entered = await _execute_call(orchestration, ota_context, _call(
        "edit-retained", "edit_workflow", workflow_id=retained.workflow_id,
    ))
    assert entered.success is True
    build = orchestration.workspace.build
    assert build is not None
    build.set_stage("explore", retained.workflow_id)
    ota_context.transition_think(BuildStageState(stage="explore", workflow_id=retained.workflow_id))
    marker = build.root / "retained.txt"
    marker.write_text("Keep this unfinished work.\n", encoding="utf-8")
    checkpoint = orchestration.workspace.build_checkpoint()
    await _execute_call(orchestration, ota_context, _call("leave-first-edit", "switch", mode="normal"))

    reopened = await _execute_call(orchestration, ota_context, _call(
        "edit-same-target", "edit_workflow", workflow_id=retained.workflow_id,
    ))
    assert reopened.success is True
    assert ota_context.think_status == BuildStageState(stage="explore", workflow_id=retained.workflow_id)
    assert orchestration.workspace.build_checkpoint() == checkpoint
    assert marker.read_text(encoding="utf-8") == "Keep this unfinished work.\n"
    await _execute_call(orchestration, ota_context, _call("leave-retained-edit", "switch", mode="normal"))

    selected = await _execute_call(orchestration, ota_context, _call(
        "edit-different-target", "edit_workflow", workflow_id=requested.workflow_id,
    ))
    assert selected.success is True
    assert ota_context.think_status == NormalStageState()
    assert "request_build" in selected.tool_result["message"]
    assert orchestration.workspace.build_checkpoint() == checkpoint
    assert orchestration.workspace.build is None
    assert orchestration.workflows.package is None
    assert marker.read_text(encoding="utf-8") == "Keep this unfinished work.\n"

    proposed = await _execute_call(orchestration, ota_context, _call(
        "resolve-edit-conflict", "request_build", goal="Edit the newly selected Workflow", mode="ask",
        reason="Another saved Workflow has an unfinished edit",
    ))
    assert proposed.success is True
    conflict = ota_context.interaction_status
    assert isinstance(conflict, AwaitingBuildConflict)
    assert ota_context.think_status == NormalStageState()
    assert conflict.existing_workflow_id == retained.workflow_id
    assert conflict.requested_workflow_id == requested.workflow_id
    assert {option["id"] for option in conflict.questions[0]["options"]} == {"keep", "replace_edit"}
    orchestration.context.session = Session(orchestration.record, [_pending(ota_context, "edit-conflict")])
    resumed = AmphiOTAContext(user_input={
        "type": "choice_answer",
        "request_id": conflict.request_id,
        "answers": [{"index": 0, "option_id": choice}],
    })

    await orchestration.agent.init_state(resumed, orchestration.context)

    assert resumed.interaction_status is None
    assert resumed.think_status == BuildStageState(
        stage="explore" if choice == "keep" else "clarify",
        workflow_id=retained.workflow_id if choice == "keep" else requested.workflow_id,
    )
    assert marker.exists() is (choice == "keep")
    assert _payload(resumed, "request_build")["action"] == ("keep" if choice == "keep" else "replace")


@pytest.mark.parametrize("legacy_pending", [False, True], ids=["main-card", "legacy-run-card"])
@pytest.mark.parametrize("choice_action", ["resume", "restart"])
async def test_run_entry(orchestration: _Harness, legacy_pending: bool, choice_action: str) -> None:
    """Final Workflow Run entry:

    {
      "start": {"stage": "execute", "step_index": 0, "source": "pinned"},
      "ambiguous_reentry": {
        "resume": {"generation": "unchanged", "source": "pinned", "input": "original"},
        "restart": {"generation": "new", "source": "latest", "input": "current_request"}
      }
    }

    Checks:
    1. Starting a saved Workflow creates a pinned private Run and enters its first section.
    2. Current and previously persisted cards resume the original input or restart with the initiating request.
    """
    saved = await _save_workflow(orchestration, "run-entry")
    original_input = UserInput(
        text="Create today's report",
        blocks=[{"type": "mention", "group": "Workflow", "id": saved.workflow_id, "label": saved.name, "path": ""}],
    )
    started = await _start_run(orchestration, saved.workflow_id, original_input)

    # Check 1: Start snapshots the saved source and enters its first execution section.
    assert isinstance(started.think_status, WorkflowStageState)
    assert started.think_status.workflow_id == saved.workflow_id
    assert (started.think_status.stage, started.think_status.step_index) == ("execute", 0)
    generation = started.think_status.generation
    assert _payload(started, "request_run_workflow")["status"] == "started"
    assert orchestration.workspace.run_workflow is not None
    pinned = orchestration.workflow_runs.require_run_workflow().source_dir
    assert (pinned / "workflow" / "WORKFLOW.md").is_file()
    partial = orchestration.workflow_runs.require_run_workflow().result_dir / "partial.txt"
    partial.write_text("Retain this attempt unless restarted.\n", encoding="utf-8")
    with saved.entry_path.open("a", encoding="utf-8") as source:
        source.write("\n# Check report\n\nCheck the completed report.\n")

    current_input = UserInput(
        text="Create tomorrow's report with the updated requirements",
        blocks=[
            {"type": "text", "value": "Use tomorrow's updated requirements."},
            {"type": "mention", "group": "Workflow", "id": saved.workflow_id, "label": saved.name, "path": ""},
        ],
    )
    ask = _ota(
        current_input,
        _step(
            "request_run_workflow",
            RequestRunWorkflow(saved.workflow_id, "ask", "An unfinished Run exists"),
        ),
    )
    await _apply(orchestration, ask)
    assert isinstance(ask.interaction_status, AwaitingWorkflowRunChoice)
    choice = ask.interaction_status
    if legacy_pending:
        # Older releases could request this card while the Run worker remained selected.
        ask.transition_think(started.think_status)
    pending = _pending(ask, "turn-run-choice")
    orchestration.context.session = Session(orchestration.record, [pending])
    resumed = AmphiOTAContext(user_input={
        "type": "choice_answer",
        "request_id": choice.request_id,
        "answers": [{"index": 0, "option_id": choice_action}],
    })
    await orchestration.agent.init_state(resumed, orchestration.context)

    # Check 2: Resume retains the original input; Restart uses the request that opened the card.
    assert isinstance(resumed.think_status, WorkflowStageState)
    assert (resumed.think_status.generation == generation) is (choice_action == "resume")
    assert resumed.think_status.workflow_id == saved.workflow_id
    payload = _payload(resumed, "request_run_workflow")
    assert payload["status"] == "resolved"
    assert payload["action"] == choice_action
    assert payload["resolved_action"] == {"resume": "resumed", "restart": "restarted"}[choice_action]
    checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.generation == resumed.think_status.generation
    assert (checkpoint.stage, checkpoint.step_index) == ("execute", 0)
    assert checkpoint.workflow_input == (original_input if choice_action == "resume" else current_input)
    assert partial.exists() is (choice_action == "resume")
    assert len(orchestration.workflows.require_package().execution_steps) == (1 if choice_action == "resume" else 2)


@pytest.mark.parametrize("action", ["start", "ask"])
async def test_workflow_reentry_requires_an_explicit_handoff_to_main(orchestration: _Harness, action: str) -> None:
    """Run controls return to Main before replacing or asking about retained work."""
    saved = await _save_workflow(orchestration, f"active-reentry-{action}")
    with saved.entry_path.open("a", encoding="utf-8") as source:
        source.write("\n# Check report\n\nCheck the completed report.\n")
    requested = await _start_run(orchestration, saved.workflow_id, "Create today's report")
    reported = await _execute_call(orchestration, requested, _call(
        "run-report", "report_workflow_step", status="success", summary="Created the report",
    ))
    assert reported.success is True
    initial = requested.think_status
    assert isinstance(initial, WorkflowStageState)
    assert initial.step_index == 1
    partial = orchestration.workflow_runs.require_run_workflow().result_dir / "partial.txt"
    partial.write_text("Retain this attempt unless restarted.\n", encoding="utf-8")
    arguments = {
        "workflow_id": saved.workflow_id,
        "action": action,
        "reason": "Resolve the user's intent for the unfinished report.",
    }

    blocked = await _execute_call(orchestration, requested, _call("run-reentry", "request_run_workflow", **arguments))
    assert blocked.success is False
    assert "not available" in blocked.error
    assert requested.think_status == initial
    assert partial.exists()
    assert requested.interaction_status is None
    exited = await _execute_call(orchestration, requested, _call("run-exit", "switch", mode="normal"))
    assert exited.success is True
    assert requested.think_status == NormalStageState()

    entered = await _execute_call(orchestration, requested, _call("main-reentry", "request_run_workflow", **arguments))
    assert entered.success is True
    payload = _payload(requested, "request_run_workflow")
    state = requested.think_status
    checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.workflow_input.text == "Create today's report"
    if action == "ask":
        assert state == NormalStageState()
        assert isinstance(requested.interaction_status, AwaitingWorkflowRunChoice)
        assert payload["status"] == "pending"
        assert requested.interaction_status.existing_workflow_id == saved.workflow_id
        assert requested.interaction_status.requested_workflow_id == saved.workflow_id
        assert checkpoint.generation == initial.generation
        assert checkpoint.step_index == initial.step_index
        assert partial.exists()
    else:
        assert isinstance(state, WorkflowStageState)
        assert state.workflow_id == saved.workflow_id
        assert requested.interaction_status is None
        assert payload["status"] == "restarted"
        assert (state.stage, state.step_index) == ("execute", 0)
        assert checkpoint.generation == state.generation
        assert state.generation != initial.generation
        assert not partial.exists()


@pytest.mark.parametrize("same_workflow", [True, False], ids=["same-workflow", "different-workflow"])
@pytest.mark.parametrize("fail_population", [False, True], ids=["replacement", "preserved-on-failure"])
async def test_start_replaces_retained_run(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch, same_workflow: bool, fail_population: bool) -> None:
    """Explicit Start replaces retained work atomically using the current structured task input."""
    saved = await _save_workflow(orchestration, "start-replacement")
    original_input = UserInput(
        text="Create the original report",
        blocks=[{"type": "mention", "group": "Workflow", "id": saved.workflow_id}],
    )
    started = AmphiOTAContext(user_input=original_input)
    result = await _execute_call(orchestration, started, _call(
        "initial-start", "request_run_workflow", workflow_id=saved.workflow_id,
    ))
    assert result.success is True
    initial = orchestration.workspace.run_workflow_checkpoint()
    assert initial is not None
    assert initial.workflow_input == original_input
    partial = orchestration.workflow_runs.require_run_workflow().result_dir / "partial.txt"
    partial.write_text("Retained work\n", encoding="utf-8")
    await _execute_call(orchestration, started, _call("pause-for-new-request", "switch", mode="normal"))

    target = saved if same_workflow else await _save_workflow(orchestration, "replacement-target")
    with target.entry_path.open("a", encoding="utf-8") as source:
        source.write("\n# Check report\n\nCheck the completed report.\n")
    current_input = UserInput(
        text="Start the requested Workflow from the beginning",
        blocks=[{"type": "mention", "group": "Workflow", "id": target.workflow_id}],
    )
    requested = AmphiOTAContext(user_input=current_input)
    call = _call("replacement-start", "request_run_workflow", workflow_id=target.workflow_id, action="start")
    if fail_population:
        def fail_populate(root: Path, source_root: Path) -> None:
            raise RuntimeError("Simulated Workflow snapshot failure")

        monkeypatch.setattr(orchestration.workflow_runs, "populate_run_workflow", fail_populate)
        with pytest.raises(RuntimeError, match="snapshot failure"):
            await _execute_call(orchestration, requested, call)
        assert orchestration.workspace.run_workflow_checkpoint() == initial
        assert partial.read_text(encoding="utf-8") == "Retained work\n"
        assert requested.think_status == NormalStageState()
        return

    result = await _execute_call(orchestration, requested, call)
    assert result.success is True
    assert _payload(requested, "request_run_workflow")["status"] == "restarted"
    checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.generation != initial.generation
    assert checkpoint.workflow_id == target.workflow_id
    assert checkpoint.workflow_input == current_input
    assert (checkpoint.stage, checkpoint.step_index) == ("execute", 0)
    assert len(orchestration.workflows.require_package().execution_steps) == 2
    assert not partial.exists()


@pytest.mark.parametrize("source_state", ["removed", "invalid"])
async def test_ask_resumes_retained_run_without_valid_saved_source(orchestration: _Harness, source_state: str) -> None:
    """Ask resumes the pinned snapshot when the current saved source cannot start a new Run."""
    saved = await _save_workflow(orchestration, "removed-run-source")
    started = await _start_run(orchestration, saved.workflow_id, "Create the original report")
    initial = started.think_status
    assert isinstance(initial, WorkflowStageState)
    partial = orchestration.workflow_runs.require_run_workflow().result_dir / "partial.txt"
    partial.write_text("Retained work\n", encoding="utf-8")
    await _execute_call(orchestration, started, _call("pause-before-removal", "switch", mode="normal"))
    if source_state == "removed":
        assert await orchestration.workflows.delete(saved.workflow_id)
    else:
        saved.entry_path.write_text("This is not a valid Workflow source.\n", encoding="utf-8")

    requested = AmphiOTAContext(user_input="Continue the retained report")
    blocked = await _execute_call(orchestration, requested, _call(
        "start-unavailable-source", "request_run_workflow", workflow_id=saved.workflow_id, action="start",
    ))
    assert blocked.success is False
    checkpoint = orchestration.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.generation == initial.generation
    assert partial.read_text(encoding="utf-8") == "Retained work\n"
    result = await _execute_call(orchestration, requested, _call(
        "ask-retained-run", "request_run_workflow", workflow_id=saved.workflow_id,
        action="ask", reason="The unfinished report can still be continued.",
    ))
    assert result.success is True
    assert isinstance(requested.interaction_status, AwaitingWorkflowRunChoice)
    choice = requested.interaction_status
    assert {option["id"] for question in choice.questions for option in question["options"]} == {"resume"}
    orchestration.context.session = Session(orchestration.record, [_pending(requested, "removed-source-choice")])
    resumed = AmphiOTAContext(user_input={
        "type": "choice_answer",
        "request_id": choice.request_id,
        "answers": [{"index": 0, "option_id": "resume"}],
    })
    await orchestration.agent.init_state(resumed, orchestration.context)
    assert resumed.think_status == initial
    assert resumed.interaction_status is None
    assert _payload(resumed, "request_run_workflow")["resolved_action"] == "resumed"
    assert partial.read_text(encoding="utf-8") == "Retained work\n"
    assert orchestration.workflows.require_package().workflow_id == saved.workflow_id


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

    repeated = await _execute_call(orchestration, execute, _call(
        "repeat-run", "request_run_workflow", workflow_id=saved.workflow_id, action="start",
    ))
    assert repeated.success is False
    assert "already ran the Workflow" in repeated.error
    assert execute.think_status == NormalStageState()
    assert not orchestration.workspace.has_run_workflow


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
