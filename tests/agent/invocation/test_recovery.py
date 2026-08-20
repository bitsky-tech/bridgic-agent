from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Role

from src.amphi_agent._invocation import AgentInvocation
from src.amphi_agent._state import AgentState, AwaitingFeedback, AwaitingSubAgent, SubAgentCall
from src.amphi_agent.runtime._environment import AppCommandEnvironmentSnapshot, app_command_environment
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_service.runtime._system_events import SystemEventBroker
from src.amphi_store import (
    SessionMountRepository,
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


async def test_recover_parent(agent_store: None, agent_model: str, test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final recovered tree:

    {
      "parent": {
        "turns": 1,
        "status": "completed",
        "answer": "The recovered parent combined both results.",
        "resume_count": 1
      },
      "children": [
        {"status": "completed", "answer": "First child result."},
        {"status": "failed", "error": "Second child failed."}
      ]
    }

    Checks:
    1. SQLite contains one parked parent and the terminal Child batch left by an earlier process.
    2. A newly constructed Invocation resumes the parent with both durable Child outcomes.
    3. Concurrent and later recovery scans cannot resume the same parent twice.
    4. Recovery replaces the parked tail instead of creating a second logical Turn.
    """
    class StaticLlms:
        def __init__(self, llm: ScriptedLlm) -> None:
            self._llm = llm

        async def resolve(self, _user: Any, _model: str) -> ScriptedLlm:
            return self._llm

    async def append_turn(
        session_id: str,
        status: TurnStatus,
        *,
        user_input: str,
        ota_records: list[dict[str, Any]],
        agent_state: dict[str, Any],
        final_answer: str | None = None,
        error: str | None = None,
    ) -> None:
        await turns.append_result(
            USER_ID,
            session_id=session_id,
            expected_tail_id=None,
            user_input=UserInput(text=user_input),
            ota_records=ota_records,
            agent_state=agent_state,
            browser_tool_loaded=False,
            workspace_tools_loaded=False,
            skills_tool_loaded=False,
            status=status,
            final_answer=final_answer,
            error=error,
            input_tokens=2,
            output_tokens=1,
            model=agent_model,
            execution_mode="auto",
            max_rounds=8,
        )

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

    sessions = SessionRepository()
    turns = SessionTurnRepository()
    parent = SessionRecord(
        id="parent",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "parent"),
        title="Recovery parent",
        status=SessionStatus.FINISH,
        last_used_model=agent_model,
    )
    await sessions.save(parent)
    calls = [
        SubAgentCall(
            tool_call_id="call-first",
            goal="Complete the first task.",
            session_id="child-first",
            execution_mode="auto",
        ),
        SubAgentCall(
            tool_call_id="call-second",
            goal="Complete the second task.",
            session_id="child-second",
            execution_mode="auto",
        ),
    ]
    for call in calls:
        await sessions.create_child(
            USER_ID,
            parent_session_id=parent.id,
            parent_call_id=call.tool_call_id,
            subagent_mode=SubAgentMode.BLOCKING,
            session_id=call.session_id,
            title=call.goal,
        )
    held_trace = [OTARecord(
        think_result={"step_content": "Delegate both tasks.", "tool_calls": []},
        action_result=ActionResult(results=[
            ActionStepResult(
                tool_id=call.tool_call_id,
                tool_name="run_subagent",
                tool_arguments={"goal": call.goal},
                tool_result="",
            )
            for call in calls
        ]),
    ).model_dump(mode="json")]

    # Check 1: The database represents a process that stopped after both Children settled.
    await append_turn(
        parent.id,
        TurnStatus.AWAITING_SUBAGENTS,
        user_input="Delegate both tasks and combine their results.",
        ota_records=held_trace,
        agent_state=AgentState(
            subagents=AwaitingSubAgent(calls=calls),
        ).model_dump(mode="json"),
    )
    await append_turn(
        calls[0].session_id,
        TurnStatus.COMPLETED,
        user_input=calls[0].goal,
        ota_records=[],
        agent_state=AgentState().model_dump(mode="json"),
        final_answer="First child result.",
    )
    await append_turn(
        calls[1].session_id,
        TurnStatus.FAILED,
        user_input=calls[1].goal,
        ota_records=[],
        agent_state=AgentState().model_dump(mode="json"),
        error="Second child failed.",
    )

    llm = ScriptedLlm(model=agent_model)
    llm.enqueue_text(
        "The recovered parent combined both results.",
        input_tokens=4,
        output_tokens=3,
        match_last_role=Role.TOOL,
    )
    invocation = AgentInvocation(
        StaticLlms(llm),
        SessionEventBroker(),
        SystemEventBroker(),
        session_repository=sessions,
        turn_repository=turns,
    )
    try:
        # Check 2: The fresh process schedules a real parent continuation from durable data.
        await asyncio.gather(invocation.recover(), invocation.recover())
        async with asyncio.timeout(3):
            while invocation.is_running(parent.id):
                await asyncio.sleep(0.01)
        latest = await turns.latest(parent.id, USER_ID)
        assert latest is not None
        assert latest.status is TurnStatus.COMPLETED
        assert latest.final_answer == "The recovered parent combined both results."
        recovered_context = str(llm.turn_calls[0].messages)
        assert "First child result." in recovered_context
        assert "Second child failed." in recovered_context

        # Check 3: A later scan sees the completed tail and performs no duplicate model turn.
        await invocation.recover()
        await asyncio.sleep(0)
        assert len(llm.turn_calls) == 1

        # Check 4: The continuation replaces the parked row at the same logical ordinal.
        parent_turns = await turns.list_conversation(USER_ID, parent.id)
        assert len(parent_turns) == 1
        assert parent_turns[0].session_ordinal == 0
        llm.assert_finished()
    finally:
        await invocation.shutdown()


async def test_delete_parked_tree(agent_store: None, test_sandbox: IsolatedPaths) -> None:
    """Final persisted state:

    {
      "sessions": [],
      "turns": [],
      "mounts": [],
      "deleted_tree_size": 2
    }

    Checks:
    1. A root and parked Child exist only in SQLite, with no process-owned Agent task.
    2. Removing the root cancels and deletes every persisted Session in the tree.
    3. Every Turn and mount row owned by the deleted tree is removed as well.
    """
    sessions = SessionRepository()
    turns = SessionTurnRepository()
    mounts = SessionMountRepository()
    parent = SessionRecord(
        id="parent",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "parent"),
        status=SessionStatus.FINISH,
    )
    await sessions.save(parent)
    child = await sessions.create_child(
        USER_ID,
        parent_session_id=parent.id,
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BLOCKING,
        session_id="child",
        title="Waiting child",
    )
    parent_call = SubAgentCall(
        tool_call_id="call-child",
        goal="Waiting child",
        session_id=child.id,
    )
    parent_turn = await turns.append_result(
        USER_ID,
        session_id=parent.id,
        expected_tail_id=None,
        user_input=UserInput(text="Delegate one task."),
        ota_records=[{"observation_result": "Waiting for the Child."}],
        agent_state=AgentState(
            subagents=AwaitingSubAgent(calls=[parent_call]),
        ).model_dump(mode="json"),
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_SUBAGENTS,
        final_answer=None,
        error=None,
        input_tokens=1,
        output_tokens=1,
    )
    child_turn = await turns.append_result(
        USER_ID,
        session_id=child.id,
        expected_tail_id=None,
        user_input=UserInput(text="Wait for a decision."),
        ota_records=[],
        agent_state=AgentState(
            interaction=AwaitingFeedback(
                prompt="Choose a direction.",
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
        input_tokens=1,
        output_tokens=1,
    )
    parent_mount = await mounts.create(
        parent.id,
        USER_ID,
        name="parent-data",
        abs_path=str(test_sandbox.root / "parent-data"),
        kind="folder",
    )
    child_mount = await mounts.create(
        child.id,
        USER_ID,
        name="child-data",
        abs_path=str(test_sandbox.root / "child-data"),
        kind="folder",
    )
    invocation = AgentInvocation(object(), SessionEventBroker(), SystemEventBroker())
    try:
        # Check 1: This fresh Invocation owns no task for either durable parked Session.
        assert invocation.has_running_tasks() is False
        tree = await sessions.list_tree(USER_ID, parent.id)
        assert [record.id for record in tree] == [parent.id, child.id]

        # Check 2: Public tree removal handles parked Turns before deleting both Sessions.
        removed = await invocation.remove_session_tree(parent.id)
        assert removed == 2
        assert await sessions.load_by_id(parent.id) is None
        assert await sessions.load_by_id(child.id) is None

        # Check 3: Transcript and mount data cannot survive their deleted Session owners.
        assert await turns.get(USER_ID, parent_turn.id) is None
        assert await turns.get(USER_ID, child_turn.id) is None
        assert await mounts.resolve(parent.id, USER_ID, [parent_mount.id]) == {}
        assert await mounts.resolve(child.id, USER_ID, [child_mount.id]) == {}
    finally:
        await invocation.shutdown()
