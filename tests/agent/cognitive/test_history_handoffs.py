"""Live Main entries persist handoffs without relying on legacy tool decoding."""

from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, MainThink, Session
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.build.base import BuildThink
from src.amphi_agent.cognitive.normal.state import AwaitingBuildConfirm, AwaitingBuildConflict, AwaitingWorkflowRunChoice
from src.amphi_agent.cognitive.presentation.base import PresentationThink
from src.amphi_agent.cognitive.workflow.base import WorkflowRunThink
from src.amphi_agent.cognitive.workflow.state import WorkflowStageState
from src.amphi_agent.tools.build import RequestBuild
from src.amphi_agent.tools.ppt import RequestPresentation
from src.amphi_agent.tools.workflow import RequestRunWorkflow
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput


def _request(tool: str, result: Any, *, success: bool = True) -> AmphiOTAContext:
    return AmphiOTAContext(user_input="Original request", ota_record=[OTARecord(
        think_scope={"mode": "normal", "stage": "main", "session_history": "stage_scoped_v2"},
        think_result={"step_content": "PRIVATE NORMAL TRACE", "tool_calls": []},
        action_result=ActionResult(results=[ActionStepResult(
            tool_id="entry-call", tool_name=tool, tool_arguments={}, tool_result=result, success=success,
        )]),
    )])


def _handoff_text(ota: AmphiOTAContext) -> str:
    """Require the persisted generic note to stand alone after tool history is removed."""
    record = OTARecord.model_validate(ota.ota_record[-1].model_dump(mode="json"))
    record.action_result = None
    scope = (ota.think_status.mode, ota.think_status.stage)
    projected = BaseThink._project_rounds([record], scope)
    assert len(projected) == 1
    text = projected[0].record["think_result"]["step_content"]
    assert text.count("[stage handoff]") == 1
    assert f"`normal/main` → `{scope[0]}/{scope[1]}`" in text
    assert "PRIVATE NORMAL TRACE" not in text
    assert "action_result" not in projected[0].record
    return text


def _pending_context(root: Path, interaction: Any, tool: str, payload: dict) -> tuple[AmphiContext, SessionTurnRecord]:
    record = SessionRecord(id="handoff-session", user_id="local", workspace_root=str(root))
    pending = SessionTurnRecord(
        id="pending-handoff", user_id="local", session_id=record.id, session_ordinal=0,
        user_input=UserInput(text="Original request"),
        ota_records=[item.model_dump(mode="json") for item in _request(tool, payload).ota_record],
        agent_state={"think": {"mode": "normal", "stage": "main"}, "interaction": interaction.model_dump(mode="json")},
        status=TurnStatus.AWAITING_HUMAN,
    )
    return AmphiContext(session=Session(record, [pending]), workspace=Workspace(record.id, root)), pending


@pytest.mark.parametrize("entry", ["build", "presentation", "run_workflow"])
async def test_direct_entry_writes_a_generic_handoff(monkeypatch: pytest.MonkeyPatch, entry: str) -> None:
    async def enter_run(ota, context, workflow_id, action):
        ota.transition_think(WorkflowStageState(workflow_id=workflow_id, generation="generation"))
        return SimpleNamespace(workflow_id=workflow_id, name="Saved report", execution_steps=[]), "started"

    monkeypatch.setattr(WorkflowRunThink, "_enter_or_resume_run_workflow", staticmethod(enter_run))
    requests = {
        "build": ("request_build", RequestBuild("Create the reporting workflow", mode="start")),
        "presentation": ("request_presentation", RequestPresentation("Explain the quarterly results")),
        "run_workflow": ("request_run_workflow", RequestRunWorkflow("saved-report", "start", "Use the saved process")),
    }
    ota = _request(*requests[entry])
    await MainThink().handle_action_result(ota, AmphiContext(), AmphiAgent())

    text = _handoff_text(ota)
    expected = {
        "build": "Workflow goal: Create the reporting workflow",
        "presentation": "Presentation goal: Explain the quarterly results",
        "run_workflow": "Workflow `Saved report` (`saved-report`) started.",
    }
    assert expected[entry] in text
    if entry == "run_workflow":
        assert "Use the saved process" in text


@pytest.mark.parametrize("entry", ["build_ask", "failed_build", "failed_presentation", "failed_run"])
async def test_unentered_request_does_not_write_a_handoff(entry: str) -> None:
    requests = {
        "build_ask": ("request_build", RequestBuild("Proposed workflow", mode="ask")),
        "failed_build": ("request_build", RequestBuild("New workflow", mode="start")),
        "failed_presentation": ("request_presentation", RequestPresentation("New presentation")),
        "failed_run": ("request_run_workflow", RequestRunWorkflow("saved-report", "start")),
    }
    ota = _request(*requests[entry], success=entry == "build_ask")
    await MainThink().handle_action_result(ota, AmphiContext(), AmphiAgent())

    assert ota.think_status.mode == "normal"
    assert "[stage handoff]" not in str(ota.ota_record[-1].observation_result or "")


@pytest.mark.parametrize("entry", ["build", "presentation", "run_workflow"])
async def test_entry_failure_does_not_publish_a_handoff(monkeypatch: pytest.MonkeyPatch, entry: str) -> None:
    def fail(*args, **kwargs):
        raise RuntimeError("Entry failed")

    monkeypatch.setattr(BuildThink, "sync_build_space", AsyncMock(side_effect=RuntimeError("Entry failed")))
    monkeypatch.setattr(PresentationThink, "invalidate_artifacts", staticmethod(fail))
    monkeypatch.setattr(WorkflowRunThink, "_enter_or_resume_run_workflow", AsyncMock(side_effect=RuntimeError("Entry failed")))
    requests = {
        "build": ("request_build", RequestBuild("New workflow", mode="start")),
        "presentation": ("request_presentation", RequestPresentation("New presentation")),
        "run_workflow": ("request_run_workflow", RequestRunWorkflow("saved-report", "start")),
    }
    ota = _request(*requests[entry])
    with pytest.raises(RuntimeError, match="Entry failed"):
        await MainThink().handle_action_result(ota, AmphiContext(), AmphiAgent())
    assert "[stage handoff]" not in str(ota.ota_record[-1].observation_result or "")


@pytest.mark.parametrize("answer", ["confirm", "cancel", "chat", "confirm_error"])
async def test_build_confirmation_handoff_preserves_the_proposed_goal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, answer: str) -> None:
    pending = AwaitingBuildConfirm(request_id="build-choice", goal="Reuse the earlier analysis", reason="This task repeats")
    context, previous = _pending_context(tmp_path, pending, "request_build", {
        "mode": "ask", "goal": pending.goal, "status": "pending",
    })
    user_input = (
        {"type": "chat", "text": "Explain the proposal first"}
        if answer == "chat"
        else {"type": "build_confirm", "request_id": pending.request_id, "action": "confirm" if answer == "confirm_error" else answer}
    )
    ota = AmphiOTAContext(user_input=user_input)
    monkeypatch.setattr(BuildThink, "sync_build_space", AsyncMock(
        side_effect=RuntimeError("Entry failed") if answer == "confirm_error" else None,
    ))
    if answer == "confirm_error":
        with pytest.raises(RuntimeError, match="Entry failed"):
            await MainThink().init_state(ota, context, previous, AmphiAgent())
    else:
        await MainThink().init_state(ota, context, previous, AmphiAgent())

    if answer == "confirm":
        assert "Workflow goal: Reuse the earlier analysis" in _handoff_text(ota)
        assert ota.think_status.stage == "clarify"
    else:
        assert "[stage handoff]" not in str(ota.ota_record[-1].observation_result or "")


@pytest.mark.parametrize("answer", ["keep", "merge", "replace_edit", "replace_new", "chat"])
async def test_build_conflict_handoff_respects_the_chosen_intent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, answer: str) -> None:
    pending = AwaitingBuildConflict(
        request_id="build-conflict", existing_stage="verify", existing_workflow_id="existing-workflow",
        requested_workflow_id="requested-workflow", reason="Resolve the competing Build request",
        questions=[{"question": "Which Build should continue?", "options": [
            {"id": option, "label": f"Choose {option}", "preview": "PRIVATE CARD PREVIEW"}
            for option in ("keep", "merge", "replace_edit", "replace_new")
        ]}],
    )
    context, previous = _pending_context(tmp_path, pending, "request_build", {
        "mode": "ask", "goal": "COMPETING WORKFLOW GOAL", "status": "pending",
        **pending.model_dump(mode="json"),
    })
    monkeypatch.setattr(BuildThink, "sync_build_space", AsyncMock())
    monkeypatch.setattr(context.workspace, "discard_build", AsyncMock())
    user_input = (
        {"type": "chat", "text": "Explain the difference first"}
        if answer == "chat"
        else {"type": "choice_answer", "request_id": pending.request_id, "answers": [{"index": 0, "option_id": answer}]}
    )
    ota = AmphiOTAContext(user_input=user_input)
    await MainThink().init_state(ota, context, previous, AmphiAgent())

    text = _handoff_text(ota)
    assert ota.think_status.stage == ("verify" if answer in {"keep", "chat"} else "clarify")
    assert ("COMPETING WORKFLOW GOAL" in text) == (answer in {"merge", "replace_edit", "replace_new"})
    assert "PRIVATE CARD PREVIEW" not in text
    if answer == "chat":
        assert "Explain the difference first" in text
        assert "Context: Resolve the competing Build request" in text
        assert "Question: Which Build should continue?" in text
        assert "Options: 1. Choose keep; 2. Choose merge" in text
    else:
        assert f"Choose {answer}" in text


@pytest.mark.parametrize("answer", ["resume", "restart", "chat", "failure"])
async def test_workflow_choice_handoff_follows_the_resolved_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, answer: str) -> None:
    async def enter_run(ota, context, workflow_id, action):
        if answer == "failure":
            raise RuntimeError("Selected Workflow is unavailable")
        ota.transition_think(WorkflowStageState(workflow_id=workflow_id, generation="generation"))
        resolved = "resumed" if action == "resume" else "restarted"
        return SimpleNamespace(workflow_id=workflow_id, name="Selected report", execution_steps=[]), resolved

    monkeypatch.setattr(WorkflowRunThink, "_enter_or_resume_run_workflow", staticmethod(enter_run))
    pending = AwaitingWorkflowRunChoice(
        request_id="run-choice", existing_workflow_id="pinned-workflow", requested_workflow_id="new-workflow",
        reason="Choose between the pinned and saved Workflow", questions=[{
            "question": "Which Run should continue?", "options": [
                {"id": "resume", "label": "Resume pinned Run"},
                {"id": "restart", "label": "Restart saved Workflow"},
            ],
        }],
    )
    context, previous = _pending_context(tmp_path, pending, "request_run_workflow", {
        **pending.model_dump(mode="json"), "status": "pending",
    })
    user_input = (
        {"type": "chat", "text": "Explain the alternatives first"}
        if answer == "chat"
        else {"type": "choice_answer", "request_id": pending.request_id, "answers": [{"index": 0, "option_id": "restart" if answer == "failure" else answer}]}
    )
    ota = AmphiOTAContext(user_input=user_input)
    await MainThink().init_state(ota, context, previous, AmphiAgent())

    if answer in {"resume", "restart"}:
        text = _handoff_text(ota)
        assert ota.think_status.workflow_id == ("pinned-workflow" if answer == "resume" else "new-workflow")
        assert ("resumed." if answer == "resume" else "restarted.") in text
        assert "Choose between the pinned and saved Workflow" in text
    else:
        assert ota.think_status.mode == "normal"
        assert "[stage handoff]" not in str(ota.ota_record[-1].observation_result or "")
