from types import SimpleNamespace
from typing import Any, cast

import pytest
from bridgic.amphibious import OTARecord
from pydantic import ValidationError

from src.amphi_agent import AmphiOTAContext
from src.amphi_agent._state import (
    AgentState,
    AwaitingBuildConfirm,
    AwaitingSubAgent,
    BuildStageState,
    SubAgentCall,
    WorkflowStageState,
)


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
