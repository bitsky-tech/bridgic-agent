"""Completed human decisions remain meaningful across stage-owned history views."""

import json
from copy import deepcopy
from typing import Any
from unittest.mock import AsyncMock

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, LlmProvider, MainThink, Session
from src.amphi_agent.cognitive import ExploreThink, GenerateThink, VerifyThink
from src.amphi_agent.cognitive.build.base import BuildThink
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent.cognitive.presentation.base import PresentationThink
from src.amphi_agent.cognitive.presentation.state import PresentationStageState
from src.amphi_agent.cognitive.workflow.base import WorkflowRunThink
from src.amphi_agent.cognitive.workflow.state import WorkflowStageState
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive.test_compaction import SummaryLlm


CHOICE_PROMPT = "Choose storage that preserves progress across restarts."
CHOICE_QUESTION = "Where should the workflow store its progress?"
CHOICE_OPTIONS = [
    {"label": "Use SQLite", "description": "Store progress in a local database."},
    {"label": "Use JSON files", "description": "Keep a portable progress file."},
]
CHOICE_RESPONSE = "the second option"


def _choice_record(mode: str = "build", stage: str = "explore", *, response: Any = CHOICE_RESPONSE, success: bool = True, error: str | None = None) -> OTARecord:
    return OTARecord(
        think_scope={"mode": mode, "stage": stage, "session_history": "stage_scoped_v2"},
        think_result={"step_content": "PRIVATE SOURCE REASONING", "tool_calls": []},
        action_result=ActionResult(results=[ActionStepResult(
            tool_id="choice-call", tool_name="request_human_choice",
            tool_arguments={"prompt": CHOICE_PROMPT, "questions": json.dumps([{
                "question": CHOICE_QUESTION, "options": CHOICE_OPTIONS,
            }])},
            tool_result=response, success=success, error=error,
        )]),
    )


def _switch_record(mode: str, stage: str, reason: str, *, target_mode: str = "build", target_stage: str | None = "generate") -> OTARecord:
    return OTARecord(
        think_scope={"mode": mode, "stage": stage, "session_history": "stage_scoped_v2"},
        think_result={"step_content": "PRIVATE SWITCH REASONING", "tool_calls": []},
        action_result=ActionResult(results=[ActionStepResult(
            tool_id=f"switch-{stage}", tool_name="switch",
            tool_arguments={"mode": target_mode, "stage": target_stage, "reason": reason},
            tool_result={"mode": target_mode, "stage": target_stage, "reason": reason},
        )]),
    )


def _assert_choice(text: str) -> None:
    for expected in (CHOICE_PROMPT, CHOICE_QUESTION, CHOICE_RESPONSE):
        assert expected in text
    for option in CHOICE_OPTIONS:
        assert option["label"] in text
        assert option["description"] in text


@pytest.fixture
def handoff_context(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> AmphiContext:
    monkeypatch.setattr(BuildThink, "sync_build_space", AsyncMock())
    record = SessionRecord(
        id="switch-handoff", user_id="local",
        workspace_root=str(test_sandbox.sessions / "switch-handoff"),
    )
    return AmphiContext(
        session=Session(record, []),
        llm_provider=LlmProvider(model_id="handoff-model", model_limits={"input": 200_000}),
    )


async def test_build_switch_preserves_choice_context_in_live_and_persisted_prompts(handoff_context: AmphiContext) -> None:
    """Generate receives the chosen option's meaning without Explore's private trace or unrelated tasks."""
    unrelated = SessionTurnRecord(
        id="earlier-task", user_id="local", session_id=handoff_context.session.id, session_ordinal=0,
        user_input=UserInput(text="An unrelated completed task"), status=TurnStatus.COMPLETED,
        ota_records=[_choice_record(response="EARLIER TERMINAL TASK RESPONSE").model_dump(mode="json")],
        agent_state={"think": {"mode": "build", "stage": "explore"}},
    )
    handoff_context.session._turns = [unrelated]
    records = [
        _choice_record("normal", "main", response="DIFFERENT MODE RESPONSE"),
        _choice_record(),
        _switch_record("build", "explore", "Implement the approved storage plan."),
    ]
    ota = AmphiOTAContext(user_input="Build the workflow", state={"think": BuildStageState(stage="explore")}, ota_record=records)
    choice_before = deepcopy(ota.ota_record[1].model_dump(mode="json"))

    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())

    assert ota.think_status == BuildStageState(stage="generate")
    reason = ota.action_result.results[0].tool_result["reason"]
    _assert_choice(reason)
    assert "Implement the approved storage plan." in reason
    assert "EARLIER TERMINAL TASK RESPONSE" not in reason
    assert "DIFFERENT MODE RESPONSE" not in reason
    assert ota.ota_record[-1].observation_result == f"[stage handoff] `build/explore` → `build/generate`\n{reason}"
    assert ota.ota_record[1].model_dump(mode="json") == choice_before
    messages = await GenerateThink().assemble_messages(ota, handoff_context)
    live_text = "\n".join(str(message.content) for message in messages)
    _assert_choice(live_text)
    assert "PRIVATE SOURCE REASONING" not in live_text
    assert "PRIVATE SWITCH REASONING" not in live_text

    persisted = SessionTurnRecord.model_validate_json(SessionTurnRecord(
        id="completed-handoff", user_id="local", session_id=handoff_context.session.id, session_ordinal=1,
        user_input=UserInput(text=ota.user_input), status=TurnStatus.COMPLETED,
        ota_records=[record.model_dump(mode="json") for record in ota.ota_record],
        agent_state=ota.state.model_dump(mode="json"),
    ).model_dump_json())
    # The SQLAlchemy storage decoder restores this enum when loading a Turn.
    persisted.status = TurnStatus(persisted.status)
    handoff_context.session._turns = [unrelated, persisted]
    restored = AmphiOTAContext(user_input="Continue the implementation")
    await AmphiAgent().init_state(restored, handoff_context)
    assert restored.think_status == BuildStageState(stage="generate")
    replay = await GenerateThink().assemble_messages(restored, handoff_context)
    replay_text = "\n".join(str(message.content) for message in replay)
    _assert_choice(replay_text)
    assert "PRIVATE SOURCE REASONING" not in replay_text
    assert "DIFFERENT MODE RESPONSE" not in replay_text
    assert "EARLIER TERMINAL TASK RESPONSE" not in replay_text


@pytest.mark.parametrize("response,success,error", [
    (None, True, None),
    ("", True, None),
    ([{"question": "UNANSWERED PENDING QUESTION"}], True, None),
    ("FAILED CHOICE RESPONSE", False, None),
    ("FAILED CHOICE RESPONSE", True, "The interaction failed"),
])
async def test_switch_excludes_unfinished_and_failed_interactions(handoff_context: AmphiContext, response: Any, success: bool, error: str | None) -> None:
    """A pending question or failed interaction never becomes a completed user decision."""
    reason = "Continue with the existing implementation plan."
    ota = AmphiOTAContext(user_input="Build the workflow", state={"think": BuildStageState(stage="explore")}, ota_record=[
        _choice_record(response=response, success=success, error=error),
        _switch_record("build", "explore", reason),
    ])

    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())

    assert ota.action_result.results[0].tool_result["reason"] == reason
    assert ota.ota_record[-1].observation_result == f"[stage handoff] `build/explore` → `build/generate`\n{reason}"
    messages = await GenerateThink().assemble_messages(ota, handoff_context)
    text = "\n".join(str(message.content) for message in messages)
    assert CHOICE_QUESTION not in text
    assert "FAILED CHOICE RESPONSE" not in text
    assert "UNANSWERED PENDING QUESTION" not in text


async def test_compacted_choice_survives_two_stage_handoffs(handoff_context: AmphiContext) -> None:
    """Compaction changes the source prompt view while its durable confirmed choice still reaches Verify."""
    records = [_choice_record()]
    for index in range(6):
        records.append(OTARecord(
            think_scope={"mode": "build", "stage": "explore", "session_history": "stage_scoped_v2"},
            think_result={"step_content": f"Explore work {index}: " + "implementation detail " * 200, "tool_calls": []},
        ))
    ota = AmphiOTAContext(user_input="Build the workflow", state={"think": BuildStageState(stage="explore")}, ota_record=records)
    llm = SummaryLlm("Earlier Explore work was summarized without the exact storage selection.")
    source = ExploreThink(llm)
    messages = await source.assemble_messages(ota, handoff_context)
    tools = [spec.to_tool() for spec in ota.tools]
    await source.compact_messages(messages, tools, ota, handoff_context, target=1)
    assert llm.calls
    assert 1 in ota.state.context_compaction.turn["build"]["explore"].turn_covered_rounds

    ota.ota_record.append(_switch_record("build", "explore", "Implement the approved plan."))
    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())
    _assert_choice(ota.action_result.results[0].tool_result["reason"])
    ota.ota_record.append(_switch_record("build", "generate", "Verify the generated implementation.", target_stage="verify"))
    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())

    assert ota.think_status == BuildStageState(stage="verify")
    reason = ota.action_result.results[0].tool_result["reason"]
    _assert_choice(reason)
    assert reason.count(CHOICE_RESPONSE) == 1
    assert ota.ota_record[-1].observation_result == f"[stage handoff] `build/generate` → `build/verify`\n{reason}"
    messages = await VerifyThink().assemble_messages(ota, handoff_context)
    text = "\n".join(str(message.content) for message in messages)
    _assert_choice(text)
    assert "PRIVATE SOURCE REASONING" not in text


@pytest.mark.parametrize("tool_name,status,reply", [
    ("request_human_task_confirm", "confirmed", "The user confirmed the task definition."),
    ("request_human_task_confirm", "revision_requested", "Keep the progress file portable across machines."),
    ("request_human_task_confirm", "pending", ""),
    ("request_human_workflow_confirm", "cancelled", "The user cancelled publication to continue editing."),
    ("request_human_workflow_confirm", "not_answered", "Use a different name before publishing this workflow."),
    ("request_human_workflow_confirm", "pending", ""),
])
async def test_build_switch_carries_resolved_confirmation_only(handoff_context: AmphiContext, tool_name: str, status: str, reply: str) -> None:
    """Completed Build confirmations survive the next switch; pending cards do not become decisions."""
    confirmation = OTARecord(
        think_scope={"mode": "build", "stage": "clarify" if "task" in tool_name else "verify", "session_history": "stage_scoped_v2"},
        action_result=ActionResult(results=[ActionStepResult(
            tool_id="confirmation", tool_name=tool_name, tool_arguments={},
            tool_result={"request_id": "confirmation-1", "status": status, "message": reply},
        )]),
    )
    original_reason = "Continue refining the implementation."
    ota = AmphiOTAContext(user_input="Continue the workflow", state={"think": BuildStageState(stage="explore")}, ota_record=[
        confirmation, _switch_record("build", "explore", original_reason),
    ])

    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())

    reason = ota.action_result.results[0].tool_result["reason"]
    assert ota.ota_record[-1].observation_result == f"[stage handoff] `build/explore` → `build/generate`\n{reason}"
    messages = await GenerateThink().assemble_messages(ota, handoff_context)
    text = "\n".join(str(message.content) for message in messages)
    if status == "pending":
        assert reason == original_reason
        assert "[user interaction outcomes;" not in text
    else:
        assert tool_name in reason
        assert reply in reason
        assert reply in text


@pytest.mark.parametrize("workflow_id,generation,included", [
    ("workflow-a", "generation-a", True),
    ("workflow-b", "generation-a", False),
    ("workflow-a", "generation-b", False),
])
async def test_workflow_exit_reads_only_its_continuing_terminal_turn(handoff_context: AmphiContext, workflow_id: str, generation: str, included: bool) -> None:
    """A resumed workflow keeps completed replies only from its own continuing execution."""
    previous = WorkflowStageState(workflow_id=workflow_id, generation=generation)
    handoff_context.session._turns = [SessionTurnRecord(
        id="previous-execution", user_id="local", session_id=handoff_context.session.id, session_ordinal=0,
        user_input=UserInput(text="Run the workflow"), status=TurnStatus.COMPLETED,
        ota_records=[_choice_record(previous.mode, previous.stage).model_dump(mode="json")],
        agent_state={"think": previous.model_dump(mode="json")},
    )]
    status = WorkflowStageState(workflow_id="workflow-a", generation="generation-a")
    original_reason = "Pause this workflow and report progress."
    ota = AmphiOTAContext(user_input="Pause", state={"think": status}, ota_record=[
        _switch_record(status.mode, status.stage, original_reason, target_mode="normal", target_stage=None),
    ])

    await WorkflowRunThink().handle_action_result(ota, handoff_context, AmphiAgent())

    reason = ota.action_result.results[0].tool_result["reason"]
    if included:
        _assert_choice(reason)
    else:
        assert reason == original_reason


async def test_build_entry_includes_its_confirmation_and_stops_older_build_decisions(handoff_context: AmphiContext) -> None:
    """A cross-mode entry marks a new Build even if older records also belong to Build."""
    entry_reply = "The user confirmed replacing the previous Build with this new task."
    entry = OTARecord(
        think_scope={"mode": "normal", "stage": "main", "session_history": "stage_scoped_v2"},
        observation_result="[stage handoff] `normal/main` → `build/clarify`\nBuild a new portable workflow.",
        action_result=ActionResult(results=[ActionStepResult(
            tool_id="build-entry", tool_name="request_build", tool_arguments={"mode": "ask"},
            tool_result={"status": "confirmed", "mode": "ask", "message": entry_reply},
        )]),
    )
    ota = AmphiOTAContext(user_input="Build a new workflow", state={"think": BuildStageState(stage="explore")}, ota_record=[
        _choice_record(response="OLD BUILD DECISION"), entry, _choice_record(),
        _switch_record("build", "explore", "Implement the new task."),
    ])

    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())

    reason = ota.action_result.results[0].tool_result["reason"]
    _assert_choice(reason)
    assert entry_reply in reason
    assert "OLD BUILD DECISION" not in reason
    messages = await GenerateThink().assemble_messages(ota, handoff_context)
    text = "\n".join(str(message.content) for message in messages)
    assert entry_reply in text
    assert "OLD BUILD DECISION" not in text


async def test_switch_bounds_long_reply_without_losing_question_context(handoff_context: AmphiContext) -> None:
    """Large free-form replies retain their beginning, question, options, and a transcript pointer."""
    long_reply = CHOICE_RESPONSE + ". " + "x" * 200_000
    ota = AmphiOTAContext(user_input="Build the workflow", state={"think": BuildStageState(stage="explore")}, ota_record=[
        _choice_record(response=long_reply), _switch_record("build", "explore", "Implement the selected option."),
    ])

    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())

    reason = ota.action_result.results[0].tool_result["reason"]
    _assert_choice(reason)
    assert len(reason) < 2_000
    assert "truncated; see the Session transcript" in reason
    assert ota.ota_record[0].action_result.results[0].tool_result == long_reply
    assert ota.ota_record[-1].observation_result == f"[stage handoff] `build/explore` → `build/generate`\n{reason}"


async def test_switch_keeps_eight_latest_unique_outcomes_in_original_order(handoff_context: AmphiContext) -> None:
    """Duplicates do not consume the bounded history budget, and omitted older decisions are marked."""
    records = [_choice_record(response=f"DECISION-{index:02d}") for index in range(10)]
    records.append(_choice_record(response="DECISION-09"))
    ota = AmphiOTAContext(user_input="Build the workflow", state={"think": BuildStageState(stage="explore")}, ota_record=[
        *records, _switch_record("build", "explore", "Implement the latest decisions."),
    ])

    await BuildThink().handle_action_result(ota, handoff_context, AmphiAgent())

    reason = ota.action_result.results[0].tool_result["reason"]
    assert "DECISION-00" not in reason
    assert "DECISION-01" not in reason
    positions = []
    for index in range(2, 10):
        reply = f"DECISION-{index:02d}"
        assert reason.count(reply) == 1
        positions.append(reason.index(reply))
    assert positions == sorted(positions)
    assert "Additional details omitted; see the Session transcript." in reason


@pytest.mark.parametrize("mode", ["build", "presentation", "run_workflow"])
async def test_mode_exit_carries_completed_choice_to_main(handoff_context: AmphiContext, mode: str) -> None:
    """Every special mode enriches its existing exit reason before Main receives the handoff."""
    if mode == "build":
        status, worker = BuildStageState(stage="explore"), BuildThink()
    elif mode == "presentation":
        status, worker = PresentationStageState(stage="ppt_compose"), PresentationThink()
    else:
        status, worker = WorkflowStageState(workflow_id="workflow-a", generation="generation-a"), WorkflowRunThink()
    ota = AmphiOTAContext(user_input="Pause this task", state={"think": status}, ota_record=[
        _choice_record(mode, status.stage),
        _switch_record(mode, status.stage, "Pause and explain the selected approach.", target_mode="normal", target_stage=None),
    ])

    await worker.handle_action_result(ota, handoff_context, AmphiAgent())

    assert ota.think_status == NormalStageState()
    reason = ota.action_result.results[0].tool_result["reason"]
    _assert_choice(reason)
    assert f"Reason: {reason}" in ota.ota_record[-1].observation_result
    messages = await MainThink().assemble_messages(ota, handoff_context)
    text = "\n".join(str(message.content) for message in messages)
    _assert_choice(text)
    assert "PRIVATE SOURCE REASONING" not in text
