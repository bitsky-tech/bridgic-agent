from __future__ import annotations

import os
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pytest

from src.amphi_agent import AgentInvocation, InvocationDisposition, InvocationTraceLimitError
from src.amphi_agent._state import AgentState, AwaitingFeedback, AwaitingSubAgent, SubAgentCall
from src.amphi_agent.runtime._environment import AppCommandEnvironmentSnapshot, app_command_environment
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_service.runtime._system_events import SystemEventBroker
from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SessionTurnRepository,
    SubAgentMode,
    TurnStatus,
    UserInput,
)
from tests._support.sandbox import IsolatedPaths
from tests.service.flows._scripted_llm import ScriptedLlm


USER_ID = "local"


async def test_cancel_parked_tree(agent_store: None, agent_model: str, test_sandbox: IsolatedPaths) -> None:
    """Final persisted tree:

    {
      "sessions": {"parent": "completed", "child": "completed"},
      "turns": {"parent": "cancelled", "child": "cancelled"},
      "waiting_state": null,
      "second_cancel": false
    }

    Checks:
    1. A parked parent and human-waiting Child exist only in durable storage.
    2. Public cancellation replaces both nonterminal tails with terminal cancellation.
    3. Session identities remain, projections complete, and a retry is idempotent.
    """
    sessions = SessionRepository()
    turns = SessionTurnRepository()
    parent = SessionRecord(
        id="parent",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "parent"),
        status=SessionStatus.FINISH,
        last_used_model=agent_model,
    )
    await sessions.save(parent)
    child = await sessions.create_child(
        USER_ID,
        parent_session_id=parent.id,
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BLOCKING,
        session_id="child",
        title="Choose a direction",
    )
    child_call = SubAgentCall(
        tool_call_id="call-child",
        goal="Choose a direction",
        session_id=child.id,
    )
    parent_turn = await turns.append_result(
        USER_ID,
        session_id=parent.id,
        expected_tail_id=None,
        user_input=UserInput(text="Delegate the decision."),
        ota_records=[{"observation_result": "Waiting for the Child."}],
        agent_state=AgentState(
            subagents=AwaitingSubAgent(calls=[child_call]),
        ).model_dump(mode="json"),
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_SUBAGENTS,
        final_answer=None,
        error=None,
        context_usage={
            "model_id": agent_model,
            "input_tokens": 2,
            "output_tokens": 1,
        },
        model=agent_model,
    )
    child_turn = await turns.append_result(
        USER_ID,
        session_id=child.id,
        expected_tail_id=None,
        user_input=UserInput(text="Ask before continuing."),
        ota_records=[{"observation_result": "Waiting for the user."}],
        agent_state=AgentState(
            interaction=AwaitingFeedback(
                prompt="Choose how to continue.",
                questions=[{"question": "Continue?"}],
                request_id="request-child",
            ),
        ).model_dump(mode="json"),
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_HUMAN,
        final_answer=None,
        error=None,
        context_usage={
            "model_id": agent_model,
            "input_tokens": 3,
            "output_tokens": 1,
        },
        model=agent_model,
    )
    await sessions.update_turn_projection(
        child.id,
        USER_ID,
        status=SessionStatus.AWAITING,
        model=agent_model,
        last_answer="",
    )
    invocation = AgentInvocation(
        object(),
        SessionEventBroker(),
        SystemEventBroker(),
        session_repository=sessions,
        turn_repository=turns,
    )
    try:
        # Check 1: Neither durable waiting Turn depends on a live process task.
        assert invocation.has_running_tasks() is False
        assert [record.id for record in await sessions.list_tree(USER_ID, parent.id)] == [
            parent.id,
            child.id,
        ]

        changed = await invocation.cancel(parent.id)
        cancelled_parent = await turns.latest(parent.id, USER_ID)
        cancelled_child = await turns.latest(child.id, USER_ID)

        # Check 2: Both logical Turns become terminal and discard their waiting state.
        assert changed is True
        assert cancelled_parent is not None
        assert cancelled_child is not None
        assert cancelled_parent.id != parent_turn.id
        assert cancelled_child.id != child_turn.id
        assert cancelled_parent.status is TurnStatus.CANCELLED
        assert cancelled_child.status is TurnStatus.CANCELLED
        assert cancelled_parent.error == "Agent execution cancelled by user"
        assert cancelled_child.error == "Agent execution cancelled by user"
        assert cancelled_parent.agent_state["subagents"] is None
        assert cancelled_child.agent_state["interaction"] is None
        assert [turn.session_ordinal for turn in await turns.list_conversation(USER_ID, parent.id)] == [0]
        assert [turn.session_ordinal for turn in await turns.list_conversation(USER_ID, child.id)] == [0]

        # Check 3: Cancellation retains the tree and a repeated request changes nothing.
        assert (await sessions.load_by_id(parent.id)).status is SessionStatus.COMPLETED
        assert (await sessions.load_by_id(child.id)).status is SessionStatus.COMPLETED
        assert await invocation.cancel(parent.id) is False
        assert len(await turns.list_conversation(USER_ID, parent.id)) == 1
        assert len(await turns.list_conversation(USER_ID, child.id)) == 1
    finally:
        await invocation.shutdown()


async def test_trace_overflow(agent_store: None, agent_model: str, test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Session history:

    {
      "turn_0": {"status": "failed", "trace": [], "state": "normal"},
      "turn_1": {"status": "completed", "answer": "Recovered answer."}
    }

    Checks:
    1. An oversized successful model response fails explicitly after durable persistence.
    2. The failed Turn keeps only a minimal cognitive checkpoint and disables loaded surfaces.
    3. The next public Invocation completes, proving that the reduced checkpoint is recoverable.
    """
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
    trace_limit = 2 * 1024
    monkeypatch.setattr(AgentInvocation, "MAX_OTA_CONTEXT_BYTES", trace_limit)

    sessions = SessionRepository()
    turns = SessionTurnRepository()
    session = SessionRecord(
        id="trace-overflow",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "trace-overflow"),
        status=SessionStatus.FINISH,
        last_used_model=agent_model,
    )
    await sessions.save(session)
    llm = ScriptedLlm(model=agent_model)
    llm.enqueue_text(
        "X" * (trace_limit + 1024),
        input_tokens=3,
        output_tokens=4,
    )
    llm.enqueue_text("Recovered answer.", input_tokens=2, output_tokens=2)
    invocation = AgentInvocation(
        StaticLlms(llm),
        SessionEventBroker(),
        SystemEventBroker(),
        session_repository=sessions,
        turn_repository=turns,
    )
    try:
        first_task = await invocation.arun(session.id, "Return the oversized diagnostic.")

        # Check 1: Persistence rejects the oversized trace through the public task result.
        with pytest.raises(InvocationTraceLimitError, match="OTA context exceeded"):
            await first_task
        failed = await turns.latest(session.id, USER_ID)
        assert failed is not None
        assert failed.status is TurnStatus.FAILED
        assert failed.final_answer is None
        assert failed.error == "This task produced too much information to save completely. Break it into smaller tasks and try again."
        assert "OTA context exceeded" not in failed.error

        # Check 2: The fallback contains no oversized trace or stale dynamic tool surface.
        assert failed.ota_records == []
        assert set(failed.agent_state or {}) == {"think"}
        assert failed.agent_state["think"] == {"mode": "normal", "stage": "main"}
        assert failed.browser_tool_loaded is False
        assert failed.workspace_tools_loaded is False
        assert failed.skills_tool_loaded is False

        second_task = await invocation.arun(session.id, "Continue safely.")
        recovered = await second_task

        # Check 3: A normal follow-up appends after the minimal failed checkpoint.
        assert recovered.outcome.disposition is InvocationDisposition.COMPLETED
        assert recovered.outcome.answer == "Recovered answer."
        history = await turns.list_conversation(USER_ID, session.id)
        assert [turn.status for turn in history] == [TurnStatus.FAILED, TurnStatus.COMPLETED]
        assert history[1].final_answer == "Recovered answer."
        llm.assert_finished()
    finally:
        await invocation.shutdown()
