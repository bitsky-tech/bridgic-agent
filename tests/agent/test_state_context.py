from types import SimpleNamespace
from typing import Any, cast

import pytest
from bridgic.amphibious import OTARecord
from pydantic import ValidationError

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, ContextUsageSnapshot, Session
from src.amphi_agent._state import (
    AgentState,
    AwaitingBuildConfirm,
    AwaitingSubAgent,
    BuildStageState,
    ContextCompactionState,
    SubAgentCall,
    WorkflowStageState,
)
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput


def test_state_round_trip() -> None:
    """Final persisted Agent state:

    {
      "think": {"mode": "build", "stage": "clarify"},
      "interaction": {"build_confirm": true, "request_id": "request-1"},
      "subagents": [{"tool_call_id": "call-1", "session_id": "session-child"}]
    }

    Checks:
    1. A Build state without a saved Workflow omits workflow_id from durable JSON.
    2. Reloading the JSON restores each state dimension to its typed model.
    3. Context transitions can advance Think and independently clear parked work.
    """
    ota_context = AmphiOTAContext(user_input="Build a report")
    interaction = AwaitingBuildConfirm(
        request_id="request-1",
        goal="Build a report",
    )
    child = SubAgentCall(
        tool_call_id="call-1",
        goal="Research the report",
        session_id="session-child",
    )
    ota_context.transition_think(BuildStageState(stage="clarify"))
    ota_context.transition_interaction(interaction)
    ota_context.transition_subagents(AwaitingSubAgent(calls=[child]))

    # Check 1: An absent Workflow binding stays absent in persisted Build state.
    payload = ota_context.state.model_dump(mode="json")
    assert payload["think"] == {"mode": "build", "stage": "clarify"}

    # Check 2: Durable JSON rehydrates every independent state dimension.
    restored = AgentState.model_validate(payload)
    assert isinstance(restored.think, BuildStageState)
    assert isinstance(restored.interaction, AwaitingBuildConfirm)
    assert isinstance(restored.subagents, AwaitingSubAgent)
    assert restored.subagents.calls == [child]

    # Check 3: A Think transition does not retain interactions or Children once cleared.
    ota_context.transition_think(WorkflowStageState(workflow_id="workflow-1", generation="generation-1"))
    ota_context.transition_interaction(None)
    ota_context.transition_subagents(None)
    assert isinstance(ota_context.think_status, WorkflowStageState)
    assert ota_context.interaction_status is None
    assert ota_context.subagent_status is None


def test_context_usage_is_the_single_token_state() -> None:
    """OTA contexts always own one snapshot instead of parallel token fields."""
    ota_context = AmphiOTAContext()

    assert ota_context.context_usage == ContextUsageSnapshot()
    assert "input_tokens" not in AmphiOTAContext.model_fields
    assert "output_tokens" not in AmphiOTAContext.model_fields


def test_context_compaction_round_trip() -> None:
    """Session and current-Turn prompt projections survive AgentState persistence."""
    state = AgentState(context_compaction=ContextCompactionState(
        session_summary="Earlier Session work",
        session_through_ordinal=4,
        turn_summary="Earlier rounds in this Turn",
        turn_through_round=3,
    ))

    restored = AgentState.model_validate(state.model_dump(mode="json"))

    assert restored.context_compaction == state.context_compaction


async def test_new_turn_inherits_only_session_compaction() -> None:
    """A terminal tail carries Session projection forward and resets current-Turn projection."""
    persisted = ContextCompactionState(
        session_summary="Earlier Session work",
        session_through_ordinal=4,
        turn_summary="Earlier rounds in the completed Turn",
        turn_through_round=3,
    )
    session_record = SessionRecord(
        id="session-compaction",
        user_id="local",
        workspace_root="/sessions/session-compaction",
    )
    latest_turn = SessionTurnRecord(
        id="turn-compaction",
        user_id="local",
        session_id=session_record.id,
        session_ordinal=5,
        user_input=UserInput(text="Previous request"),
        ota_records=[],
        agent_state=AgentState(context_compaction=persisted).model_dump(mode="json"),
        status=TurnStatus.COMPLETED,
    )
    context = AmphiContext(session=Session(session_record, [latest_turn]))
    ota_context = AmphiOTAContext(user_input="New request")

    await AmphiAgent().init_state(ota_context, context)

    assert ota_context.state.context_compaction == ContextCompactionState(
        session_summary="Earlier Session work",
        session_through_ordinal=4,
    )


def test_child_identities() -> None:
    """Final Child batch validation:

    {
      "unique_calls": "accepted",
      "duplicate_tool_call_id": "rejected",
      "duplicate_session_id": "rejected"
    }

    Checks:
    1. Distinct Child calls form one valid pending batch.
    2. Reusing either runtime identity rejects the complete batch.
    """
    first = SubAgentCall(
        tool_call_id="call-1",
        goal="Research one",
        session_id="session-1",
    )
    second = SubAgentCall(
        tool_call_id="call-2",
        goal="Research two",
        session_id="session-2",
    )

    # Check 1: Independent calls retain their stable Tool and Session identities.
    pending = AwaitingSubAgent(calls=[first, second])
    assert pending.calls == [first, second]

    # Check 2: Either duplicated identity makes the parent wait state ambiguous.
    with pytest.raises(ValidationError, match="duplicate tool call ids"):
        AwaitingSubAgent(calls=[first, second.model_copy(update={"tool_call_id": "call-1"})])
    with pytest.raises(ValidationError, match="duplicate Session ids"):
        AwaitingSubAgent(calls=[first, second.model_copy(update={"session_id": "session-1"})])


def test_turn_summary() -> None:
    """Final fallback answers:

    {
      "live_round": "Live answer",
      "resumed_round": "Persisted answer",
      "empty_trace": "(no answer)"
    }

    Checks:
    1. A live round exposes its latest non-empty thought as the fallback answer.
    2. A persisted dictionary round produces the same fallback behavior after resume.
    3. A trace without an answer returns the explicit empty-result marker.
    """
    # Check 1: Live framework objects provide their final non-empty thought.
    live = AmphiOTAContext(ota_record=[
        OTARecord(think_result=SimpleNamespace(step_content="Live answer")),
    ])
    assert live.summary() == "Live answer"

    # Check 2: Resumed dictionary records skip a blank latest round and retain the prior answer.
    resumed = AmphiOTAContext()
    resumed.ota_record.extend(cast(list[Any], [
        {"think_result": {"step_content": "Persisted answer"}},
        {"think_result": {"step_content": ""}},
    ]))
    assert resumed.summary() == "Persisted answer"

    # Check 3: No usable thought has one stable, user-visible fallback.
    assert AmphiOTAContext().summary() == "(no answer)"
