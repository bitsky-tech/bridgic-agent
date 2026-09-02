from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pytest

from src.amphi_agent._invocation import (
    AgentInvocation,
    InvocationDisposition,
    InvocationRunResult,
    InvocationStaleAnswerError,
)
from src.amphi_agent._state import (
    AgentState,
    AwaitingBuildConfirm,
    AwaitingBuildConflict,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingWorkflowRunChoice,
    BuildStageState,
)
from src.amphi_agent._workflow_run import WorkflowRunLibrary
from src.amphi_agent._workflows import WorkflowLibrary
from src.amphi_agent._workspace import RunWorkflowState, Workspace
from src.amphi_agent.runtime._environment import (
    AppCommandEnvironmentSnapshot,
    app_command_environment,
)
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_service.runtime._system_events import SystemEventBroker
from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    SessionTurnRecord,
    SessionTurnRepository,
    TurnStatus,
    UserInput,
)
from tests._support.sandbox import IsolatedPaths
from tests.service.flows._scripted_llm import ScriptedLlm


USER_ID = "local"


@dataclass(frozen=True, slots=True)
class _Harness:
    paths: IsolatedPaths
    llm: ScriptedLlm
    invocation: AgentInvocation
    sessions: SessionRepository
    turns: SessionTurnRepository

    async def create_session(self, session_id: str) -> SessionRecord:
        record = SessionRecord(
            id=session_id,
            user_id=USER_ID,
            workspace_root=str(self.paths.sessions / session_id),
            title=f"Interaction {session_id}",
        )
        await self.sessions.save(record)
        return record

    async def run(self, session_id: str, user_input: Any) -> InvocationRunResult:
        return await (await self.invocation.arun(session_id, user_input))

    async def workspace(self, record: SessionRecord) -> Workspace:
        workspace = Workspace(record.id, Path(record.workspace_root))
        await workspace.prepare_workspace()
        return workspace


@pytest.fixture
async def interactions(agent_store: None, agent_model: str, test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[_Harness]:
    """Create one real Store and Invocation with only the model boundary scripted."""
    class StaticLlms:
        def __init__(self, llm: ScriptedLlm) -> None:
            self._llm = llm

        async def resolve(self, _user: Any, _model: str) -> ScriptedLlm:
            return self._llm

    environment = {
        **test_sandbox.process_environment(),
        "PATH": os.environ.get("PATH", ""),
    }
    snapshot = AppCommandEnvironmentSnapshot(
        environment=MappingProxyType(environment),
        managed_environment=MappingProxyType(dict(environment)),
        uv_executable=None,
        uv_version=None,
        python_executable=Path(sys.executable),
        python_version=sys.version.split()[0],
        node_executable=None,
        node_version=None,
    )
    monkeypatch.setattr(app_command_environment, "snapshot", lambda: snapshot)

    invocation: AgentInvocation | None = None
    llm = ScriptedLlm(model=agent_model)
    try:
        sessions = SessionRepository()
        turns = SessionTurnRepository()
        invocation = AgentInvocation(
            StaticLlms(llm),
            SessionEventBroker(),
            SystemEventBroker(),
            session_repository=sessions,
            turn_repository=turns,
        )
        yield _Harness(test_sandbox, llm, invocation, sessions, turns)
        llm.assert_finished()
    finally:
        if invocation is not None:
            await invocation.shutdown()


def _write_package(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "task.md").write_text(
        "# Report workflow\n\nCreate and validate the requested report.\n",
        encoding="utf-8",
    )
    (root / "explore.md").write_text(
        "# Implementation plan\n\nRead the request, create the report, and validate it.\n",
        encoding="utf-8",
    )
    (root / "verify.md").write_text(
        "# Verification\n\nThe isolated checks passed.\n\n## Overall verdict\nPASS\n",
        encoding="utf-8",
    )
    source = root / "workflow"
    source.mkdir(exist_ok=True)
    (source / "WORKFLOW.md").write_text(
        "---\nname: report-workflow\ndescription: Create a checked report\n---\n"
        "# Create report\n\nWrite the requested report to result/report.txt.\n",
        encoding="utf-8",
    )
def _tool_result(turn: SessionTurnRecord, tool_name: str) -> dict[str, Any]:
    for record in reversed(turn.ota_records or []):
        action = record.get("action_result") or {}
        for step in reversed(action.get("results") or []):
            if step.get("tool_name") == tool_name:
                result = step.get("tool_result")
                assert isinstance(result, dict)
                return result
    raise AssertionError(f"No persisted result for {tool_name}")


async def test_build_confirm(interactions: _Harness) -> None:
    """Final Build proposal:

    {
      "proposal": {"disposition": "awaiting_build_confirm"},
      "resolution": {"status": "confirmed"},
      "build": {"created": true, "retained_stage": "clarify"},
      "turn": {"count": 1, "status": "completed"}
    }

    Checks:
    1. A model-proposed reusable task becomes a persisted Build-confirmation request.
    2. Confirmation creates the private Build and completes the original logical Turn.
    """
    record = await interactions.create_session("build-confirm")
    interactions.llm.enqueue_tool(
        "request_build",
        {
            "goal": "Turn this report into a reusable workflow",
            "mode": "ask",
            "reason": "The same report may be requested again",
        },
        call_id="call-build-proposal",
    )

    # Check 1: Invocation maps and persists the dedicated confirmation outcome.
    proposal = await interactions.run(record.id, "Prepare this report for me.")
    assert proposal.outcome.disposition is InvocationDisposition.AWAITING_BUILD_CONFIRM
    assert isinstance(proposal.interaction, AwaitingBuildConfirm)
    pending = await interactions.turns.latest(record.id, USER_ID)
    assert pending is not None
    assert pending.status is TurnStatus.AWAITING_HUMAN
    assert pending.agent_state["interaction"]["request_id"] == proposal.interaction.request_id

    interactions.llm.enqueue_tool(
        "switch",
        {"mode": "normal", "reason": "Pause the new Build after creation."},
        call_id="call-pause-build",
    )
    interactions.llm.enqueue_text("The reusable Build was created.")
    completed = await interactions.run(record.id, {
        "type": "build_confirm",
        "request_id": proposal.interaction.request_id,
        "action": "confirm",
    })

    # Check 2: The answer resolves the card, creates .build, and replaces the parked tail.
    assert completed.outcome.disposition is InvocationDisposition.COMPLETED
    turns = await interactions.turns.list_conversation(USER_ID, record.id)
    assert len(turns) == 1
    assert turns[0].status is TurnStatus.COMPLETED
    assert turns[0].session_ordinal == 0
    assert _tool_result(turns[0], "request_build")["status"] == "confirmed"
    workspace = await interactions.workspace(record)
    checkpoint = workspace.build_checkpoint()
    assert checkpoint is not None
    assert checkpoint.stage == "clarify"


async def test_build_conflict(interactions: _Harness) -> None:
    """Final conflicting Build request:

    {
      "choice": {"action": "keep", "status": "resolved"},
      "retained_build": {"stage": "clarify", "marker": "original"},
      "turn": {"count": 1, "status": "completed"}
    }

    Checks:
    1. A competing Build request parks through Invocation without replacing the retained Build.
    2. The Keep choice reopens the original Build and completes the same persisted Turn.
    """
    record = await interactions.create_session("build-conflict")
    workspace = await interactions.workspace(record)
    build = await workspace.prepare_build_space("create", stage="clarify")
    marker = build.root / "marker.txt"
    marker.write_text("original\n", encoding="utf-8")
    workspace.close_build_space()
    interactions.llm.enqueue_tool(
        "request_build",
        {
            "goal": "Create a different reusable workflow",
            "mode": "ask",
            "reason": "A different unfinished Build already exists",
        },
        call_id="call-build-conflict",
    )

    # Check 1: The conflict becomes a generic choice disposition while preserving .build.
    conflict = await interactions.run(record.id, "Build a different reusable workflow.")
    assert conflict.outcome.disposition is InvocationDisposition.AWAITING_FEEDBACK
    assert isinstance(conflict.interaction, AwaitingBuildConflict)
    assert marker.read_text(encoding="utf-8") == "original\n"

    interactions.llm.enqueue_tool(
        "switch",
        {"mode": "normal", "reason": "Continue the retained Build later."},
        call_id="call-leave-retained-build",
    )
    interactions.llm.enqueue_text("I kept the original unfinished Build.")
    completed = await interactions.run(record.id, {
        "type": "choice_answer",
        "request_id": conflict.interaction.request_id,
        "answers": [{"index": 0, "option_id": "keep"}],
    })

    # Check 2: The selected stable option resolves the held tool result and retained state.
    assert completed.outcome.disposition is InvocationDisposition.COMPLETED
    turns = await interactions.turns.list_conversation(USER_ID, record.id)
    assert len(turns) == 1
    assert turns[0].status is TurnStatus.COMPLETED
    assert turns[0].session_ordinal == 0
    result = _tool_result(turns[0], "request_build")
    assert (result["status"], result["action"]) == ("resolved", "keep")
    assert marker.read_text(encoding="utf-8") == "original\n"
    assert workspace.build_checkpoint() is not None


async def test_workflow_confirm(interactions: _Harness, agent_model: str) -> None:
    """Final verified Workflow publication:

    {
      "confirmation": {"status": "confirmed", "name": "Checked Report"},
      "workflow": {"saved": true, "build_deleted": true},
      "publication_turn": {"status": "completed", "ordinal": 1}
    }

    Checks:
    1. Verify returns a specialized publication request through Invocation and persistence.
    2. The matching confirmation saves one Workflow, removes .build, and completes that Turn.
    """
    async def seed_verify_turn(record: SessionRecord) -> None:
        await interactions.turns.append_result(
            USER_ID,
            session_id=record.id,
            expected_tail_id=None,
            user_input=UserInput(text="Create a reusable report workflow."),
            ota_records=[],
            agent_state=AgentState(
                think=BuildStageState(stage="verify"),
            ).model_dump(mode="json"),
            browser_tool_loaded=False,
            workspace_tools_loaded=False,
            skills_tool_loaded=False,
            status=TurnStatus.COMPLETED,
            final_answer="The Build is ready for verification.",
            error=None,
            context_usage={"model_id": agent_model},
            model=agent_model,
            execution_mode="auto",
            max_rounds=8,
        )

    record = await interactions.create_session("workflow-confirm")
    workspace = await interactions.workspace(record)
    build = await workspace.prepare_build_space("create", stage="verify")
    _write_package(build.root)
    workspace.close_build_space()
    await seed_verify_turn(record)
    interactions.llm.enqueue_tool(
        "request_human_workflow_confirm",
        {
            "prompt": (
                '{"default_name":"Checked Report",'
                '"summary":"Create and validate the requested report"}'
            ),
        },
        call_id="call-workflow-confirm",
    )

    # Check 1: Verify's real tool outcome is mapped and stored as its dedicated disposition.
    confirmation = await interactions.run(record.id, "Publish the verified workflow.")
    assert confirmation.outcome.disposition is InvocationDisposition.AWAITING_WORKFLOW_CONFIRM
    assert isinstance(confirmation.interaction, AwaitingWorkflowConfirm)
    request_id = confirmation.interaction.workflow_confirm["request_id"]
    pending = await interactions.turns.latest(record.id, USER_ID)
    assert pending is not None
    assert pending.status is TurnStatus.AWAITING_HUMAN
    assert pending.session_ordinal == 1

    interactions.llm.enqueue_text("The verified Workflow was saved as Checked Report.")
    completed = await interactions.run(record.id, {
        "type": "workflow_confirm",
        "request_id": request_id,
        "action": "confirm",
        "name": "Checked Report",
    })

    # Check 2: Publication resolves in the same ordinal and removes the private source tree.
    assert completed.outcome.disposition is InvocationDisposition.COMPLETED
    turns = await interactions.turns.list_conversation(USER_ID, record.id)
    assert len(turns) == 2
    assert turns[-1].status is TurnStatus.COMPLETED
    assert turns[-1].session_ordinal == 1
    result = _tool_result(turns[-1], "request_human_workflow_confirm")
    assert (result["status"], result["name"]) == ("confirmed", "Checked Report")
    workflows = await WorkflowLibrary(USER_ID).load()
    saved = workflows.get(result["workflow_id"])
    assert saved is not None
    assert saved.name == "Checked Report"
    assert workspace.build_checkpoint() is None


async def test_run_choice(interactions: _Harness) -> None:
    """Final retained Workflow Run choice:

    {
      "choice": {"action": "resume", "status": "resolved"},
      "run": {"generation": "retained-generation", "preserved": true},
      "turn": {"count": 1, "status": "completed"}
    }

    Checks:
    1. An ambiguous Run request parks through Invocation with both stable choices.
    2. Resume reopens the retained generation and completes the original logical Turn.
    """
    record = await interactions.create_session("run-choice")
    workspace = await interactions.workspace(record)
    source = interactions.paths.root / "saved-workflow-source"
    _write_package(source)
    workflows = await WorkflowLibrary(USER_ID).load()
    saved = await workflows.materialize_workflow(
        source,
        workflow_id=None,
        source_session_id=record.id,
        source_turn_id="seed-run-choice",
        name="Checked Report",
        description="Create a checked report",
    )
    workflow_runs = await WorkflowRunLibrary(USER_ID).load()
    initial_state = RunWorkflowState(
        workflow_id=saved.workflow_id,
        generation="retained-generation",
        workflow_name=saved.name,
        workflow_input=UserInput(text="Create the original report."),
    )

    def populate(root: Path) -> None:
        workflow_runs.populate_run_workflow(root, saved.root)

    await workspace.prepare_run_workflow_space(
        "create",
        initial_state=initial_state,
        populate=populate,
    )
    workspace.close_run_workflow_space()
    interactions.llm.enqueue_tool(
        "request_run_workflow",
        {
            "workflow_id": saved.workflow_id,
            "action": "ask",
            "reason": "An unfinished Run already exists",
        },
        call_id="call-run-choice",
    )

    # Check 1: The domain choice crosses Invocation and offers only Resume or Restart.
    choice = await interactions.run(record.id, "Continue the report workflow.")
    assert choice.outcome.disposition is InvocationDisposition.AWAITING_FEEDBACK
    assert isinstance(choice.interaction, AwaitingWorkflowRunChoice)
    option_ids = {
        option["id"]
        for question in choice.interaction.questions
        for option in question["options"]
    }
    assert option_ids == {"resume", "restart"}

    interactions.llm.enqueue_tool(
        "switch",
        {"mode": "normal", "reason": "Pause after reopening the retained Run."},
        call_id="call-pause-run",
    )
    interactions.llm.enqueue_text("I reopened the retained Workflow Run.")
    completed = await interactions.run(record.id, {
        "type": "choice_answer",
        "request_id": choice.interaction.request_id,
        "answers": [{"index": 0, "option_id": "resume"}],
    })

    # Check 2: Resume preserves generation identity and replaces the parked Turn.
    assert completed.outcome.disposition is InvocationDisposition.COMPLETED
    turns = await interactions.turns.list_conversation(USER_ID, record.id)
    assert len(turns) == 1
    assert turns[0].status is TurnStatus.COMPLETED
    assert turns[0].session_ordinal == 0
    result = _tool_result(turns[0], "request_run_workflow")
    assert (result["status"], result["action"]) == ("resolved", "resume")
    checkpoint = workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.generation == "retained-generation"
