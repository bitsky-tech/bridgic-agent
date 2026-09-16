from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Any
from unittest.mock import AsyncMock

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Message, Role

from src.amphi_agent._invocation import AgentInvocation, InvocationNotFoundError
from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._skills import SkillLibrary
from src.amphi_agent._workspace import RunWorkflowSpace, Workspace
from src.amphi_agent._workflow_run import WorkflowRunLibrary
from src.amphi_agent.cognitive.state import AgentState, AwaitingFeedback, AwaitingSubAgent, SubAgentCall
from src.amphi_agent.runtime._environment import AppCommandEnvironmentSnapshot, app_command_environment
from src.amphi_agent.tools import BROWSER_ADVANCED_TOOL_NAMES, SKILLS_ADVANCED_TOOL_NAMES, WORKSPACE_ADVANCED_TOOL_NAMES
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_service.runtime._system_events import SystemEventBroker
from src.amphi_store import (
    SessionMountRepository,
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SessionTurnRecord,
    SessionTurnRepository,
    SubAgentMode,
    TurnStatus,
    UserInput,
    WorkflowRepository,
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
            context_usage={
                "model_id": agent_model,
                "input_tokens": 2,
                "output_tokens": 1,
            },
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
        context_usage={"input_tokens": 1, "output_tokens": 1},
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
        context_usage={"input_tokens": 1, "output_tokens": 1},
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


async def test_get_prompt_reads_only_the_selected_history_prefix(agent_store: None, test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Preview hydrates real resources without initialization, execution or persistence."""
    session = SessionRecord(
        id="prompt-session", user_id="local", workspace_root=str(test_sandbox.sessions / "prompt-session"),
    )
    await SessionRepository().save(session)
    turns = SessionTurnRepository()
    records = []
    for ordinal in range(3):
        record = SessionTurnRecord(
            id=f"prompt-turn-{ordinal}", user_id="local", session_id=session.id,
            session_ordinal=ordinal, user_input=UserInput(text=f"question-{ordinal}"),
            status=TurnStatus.COMPLETED,
            ota_records=[
                {
                    "think_scope": {"mode": "normal", "stage": "main"},
                    "think_result": {"step_content": f"answer-{ordinal}-{index}"},
                    "observation_result": f"observation-{ordinal}-{index}",
                }
                for index in range(3)
            ],
            agent_state={"think": {"mode": "normal", "stage": "main"}},
            browser_tool_loaded=ordinal > 0,
        )
        async with turns._session() as db:
            db.add(record)
            await db.commit()
        records.append(record)
    before = [item.model_dump(mode="json") for item in await turns.list_conversation("local", session.id)]

    prepare = AsyncMock(side_effect=AssertionError("Preview initialized the workspace"))
    sync = AsyncMock(side_effect=AssertionError("Preview synchronized Skills"))
    run = AsyncMock(side_effect=AssertionError("Preview ran the Agent"))
    llms = AsyncMock()
    real_assembly = AmphiAgent.get_prompt
    monkeypatch.setattr(Workspace, "prepare_workspace", prepare)
    monkeypatch.setattr(SkillLibrary, "sync_builtins", sync)
    monkeypatch.setattr(AmphiAgent, "arun", run)

    async def assemble(self, context: AmphiContext, ota: AmphiOTAContext):
        assert (ota.think_status.mode, ota.think_status.stage) == ("normal", "main")
        assert [item.id for item in context.session.get_all()] == ["prompt-turn-0"]
        assert ota.user_input.input == "question-1"
        assert len(ota.ota_record) == 2
        assert ota.ota_record[0].think_result["step_content"] == "answer-1-0"
        assert ota.ota_record[1].think_result is None
        assert ota.ota_record[1].action_result is None
        assert ota.ota_record[1].observation_result is None
        assert ota.browser_tool_loaded is True
        assert ota.state.context_compaction is None
        return {"messages": [{"role": "user", "content": "assembled"}], "tools": [], "extraBody": None}

    monkeypatch.setattr(AmphiAgent, "get_prompt", assemble)
    invocation = AgentInvocation(llms, SessionEventBroker(), SystemEventBroker())
    try:
        response = await invocation.get_prompt(session.id, records[1].id, 1, mode="normal", stage="main")
        assert response["sessionId"] == session.id
        item = response["item"]
        assert item["availability"] == "assembled"
        assert item["roundIndex"] == 1
        assert item["turnOrdinal"] == 1
        assert item["request"]["modelId"] == "invocation-model"
        assert item["request"]["messages"][0]["content"] == "assembled"
        monkeypatch.setattr(AmphiAgent, "get_prompt", real_assembly)
        actual = await invocation.get_prompt(session.id, records[1].id, 1, mode="normal", stage="main")
        request = actual["item"]["request"]
        text = "\n".join(Message.model_validate(item).content for item in request["messages"])
        assert "question-0" in text and "question-1" in text and "answer-1-0" in text
        assert "question-2" not in text and "answer-1-1" not in text and "answer-1-2" not in text
        assert "observation-1-1" not in text
        assert request["tools"] and request["worker"] == "MainThink"
        prepare.assert_not_awaited()
        sync.assert_not_awaited()
        run.assert_not_awaited()
        llms.resolve.assert_not_awaited()
        assert not Path(session.workspace_root).exists()
        after = [item.model_dump(mode="json") for item in await turns.list_conversation("local", session.id)]
        assert after == before
    finally:
        await invocation.shutdown()


@pytest.mark.parametrize("legacy_snapshot", [False, True], ids=["think-scope", "split-snapshot"])
async def test_get_prompt_restores_round_summaries_tools_and_clock(agent_store, test_sandbox, legacy_snapshot) -> None:
    """DB round snapshots prevent final Turn summaries and tool flags from leaking backward."""
    session = SessionRecord(id="round-snapshots", user_id="local", workspace_root=str(test_sandbox.sessions / "round-snapshots"))
    await SessionRepository().save(session)

    def snapshot(summary=None, loaded=False):
        state = {"think": {"mode": "normal", "stage": "main"}}
        if summary is not None:
            state["context_compaction"] = {
                "session": {"normal": {"main": {"session_summary": "EARLIER_SESSION_SUMMARY", "session_through_ordinal": 0}}},
                "turn": {"normal": {"main": {
                    "turn_summary": summary, "turn_through_round": 2,
                    "turn_covered_rounds": [1, 2], "turn_covered_raw_rounds": [1, 2],
                }}},
            }
        return {
            "state": state, "browser_tool_loaded": loaded, "workspace_tools_loaded": loaded,
            "skills_tool_loaded": loaded, "prompt_time": "2026-09-15 08:12 (UTC+08:00)",
        }

    turn = SessionTurnRecord(
        id="snapshot-turn", user_id="local", session_id=session.id, session_ordinal=1,
        status=TurnStatus.COMPLETED, user_input=UserInput(text="ORIGINAL_INPUT"),
        browser_tool_loaded=True, workspace_tools_loaded=True, skills_tool_loaded=True,
        agent_state=snapshot("FUTURE_SUMMARY_CONTAINS_ROUND_3_AND_4", True)["state"],
        ota_records=[{
            "think_scope": {"mode": "normal", "stage": "main"},
            "prompt_context": snapshot("EARLIER_ROUND_SUMMARY" if index >= 2 else None, index >= 2),
            "think_result": {"step_content": f"ROUND_{index + 1}_OUTPUT"},
        } for index in range(4)],
    )
    if not legacy_snapshot:
        for record in turn.ota_records:
            snapshot = record.pop("prompt_context")
            state = snapshot.pop("state")
            record["think_scope"] = {**state.pop("think"), **state, **snapshot}
    turns = SessionTurnRepository()
    async with turns._session() as db:
        db.add(SessionTurnRecord(
            id="previous-turn", user_id="local", session_id=session.id, session_ordinal=0,
            status=TurnStatus.COMPLETED, user_input=UserInput(text="PREVIOUS_INPUT"),
            ota_records=[{"think_scope": {"mode": "normal", "stage": "main"}, "think_result": {"step_content": "PREVIOUS_RESPONSE"}}],
        ))
        db.add(turn)
        await db.commit()
    before = (await turns.get("local", turn.id)).model_dump(mode="json")
    invocation = AgentInvocation(AsyncMock(), SessionEventBroker(), SystemEventBroker())
    try:
        advanced = BROWSER_ADVANCED_TOOL_NAMES | WORKSPACE_ADVANCED_TOOL_NAMES | SKILLS_ADVANCED_TOOL_NAMES
        for index in range(3):
            request = (await invocation.get_prompt(session.id, turn.id, index, mode="normal", stage="main"))["item"]["request"]
            text = "\n".join(Message.model_validate(item).content for item in request["messages"])
            names = {tool["name"] for tool in request["tools"]}
            assert "2026-09-15 08:12 (UTC+08:00)" in text and "ORIGINAL_INPUT" in text
            assert "FUTURE_SUMMARY" not in text
            assert "ROUND_3_OUTPUT" not in text and "ROUND_4_OUTPUT" not in text
            if index < 2:
                assert names.isdisjoint(advanced)
                assert "EARLIER_ROUND_SUMMARY" not in text and "EARLIER_SESSION_SUMMARY" not in text
                assert "PREVIOUS_RESPONSE" in text
                assert ("ROUND_1_OUTPUT" in text) is (index == 1)
                assert "ROUND_2_OUTPUT" not in text
            else:
                assert advanced <= names
                assert "EARLIER_ROUND_SUMMARY" in text and "EARLIER_SESSION_SUMMARY" in text
                assert "PREVIOUS_RESPONSE" not in text and "ROUND_1_OUTPUT" not in text and "ROUND_2_OUTPUT" not in text
        assert (await turns.get("local", turn.id)).model_dump(mode="json") == before
    finally:
        await invocation.shutdown()


async def test_get_prompt_rejects_cross_session_turn_and_invalid_round(agent_store: None, test_sandbox: IsolatedPaths) -> None:
    """A Session-scoped preview cannot use another Session's Turn or wrong stage."""
    sessions = SessionRepository()
    for name in ("first", "second"):
        await sessions.save(SessionRecord(
            id=name, user_id="local", workspace_root=str(test_sandbox.sessions / name),
        ))
    turn = SessionTurnRecord(
        id="owned-turn", user_id="local", session_id="first", session_ordinal=0,
        user_input=UserInput(text="question"), status=TurnStatus.COMPLETED,
        ota_records=[{"think_scope": {"mode": "normal", "stage": "main"}}],
    )
    async with SessionTurnRepository()._session() as db:
        db.add(turn)
        await db.commit()
    invocation = AgentInvocation(AsyncMock(), SessionEventBroker(), SystemEventBroker())
    try:
        with pytest.raises(InvocationNotFoundError):
            await invocation.get_prompt("second", turn.id, 0, mode="normal", stage="main")
        for index in (-1, 1):
            with pytest.raises(ValueError, match="roundIndex"):
                await invocation.get_prompt("first", turn.id, index, mode="normal", stage="main")
        with pytest.raises(ValueError, match="mode and stage"):
            await invocation.get_prompt("first", turn.id, 0, mode="presentation", stage="ppt_brief")
    finally:
        await invocation.shutdown()


@pytest.mark.parametrize("current_run", ["advanced", "different", "absent"])
@pytest.mark.parametrize("finished", [False, True])
@pytest.mark.parametrize("entry_in_previous_turn", [False, True])
@pytest.mark.parametrize("snapshot_format", ["none", "split", "think_scope"])
async def test_get_prompt_assembles_workflow_from_records_independently_of_live_run(
    agent_store, test_sandbox, monkeypatch, current_run, finished, entry_in_previous_turn, snapshot_format,
) -> None:
    """Earlier steps and completed Turns remain inspectable without touching a live Run."""
    session = SessionRecord(
        id="workflow-prompt", user_id="local", workspace_root=str(test_sandbox.sessions / "workflow-prompt"),
    )
    await SessionRepository().save(session)
    source = test_sandbox.root / "saved-workflow"
    (source / "workflow").mkdir(parents=True)
    (source / "workflow/WORKFLOW.md").write_text(
        "---\nname: recorded-workflow\ndescription: Inspect recorded steps\n---\n"
        "# Collect\nFIRST_STEP_INSTRUCTION\n# Publish\nSECOND_STEP_INSTRUCTION\n",
        encoding="utf-8",
    )
    await WorkflowRepository().create(
        "local", workflow_id="recorded-workflow", name="Recorded workflow",
        description=None, domain=None, workflow_dir=str(source),
    )
    saved_think = {"mode": "normal", "stage": "main"} if finished else {
        "mode": "run_workflow", "stage": "execute", "workflow_id": "recorded-workflow",
        "generation": "recorded-generation", "step_index": 1,
    }
    turn = SessionTurnRecord(
        id="workflow-turn", user_id="local", session_id=session.id, session_ordinal=1,
        user_input=UserInput(text="CONTINUE_WORKFLOW_INPUT" if entry_in_previous_turn else "ORIGINAL_WORKFLOW_INPUT"),
        status=TurnStatus.COMPLETED if finished else TurnStatus.AWAITING_HUMAN,
        agent_state={"think": saved_think},
        ota_records=[
            {
                "think_scope": {"mode": "normal", "stage": "main"},
                "action_result": {"results": [{
                    "tool_id": "enter-workflow", "tool_name": "request_run_workflow",
                    "tool_arguments": {"workflow_id": "recorded-workflow"}, "success": True,
                    "tool_result": {"workflow_id": "recorded-workflow", "status": "started"},
                }]},
            },
            {
                "think_scope": {"mode": "run_workflow", "stage": "execute", "step_index": 0},
                "think_result": {"step_content": "SELECTED_ROUND_OUTPUT"},
            },
            {
                "think_scope": {"mode": "run_workflow", "stage": "execute", "step_index": 1},
                "think_result": {"step_content": "LATER_ROUND_OUTPUT"},
            },
            {
                "think_scope": {"mode": "normal", "stage": "main"},
                "action_result": {"results": [{
                    "tool_id": "later-entry", "tool_name": "request_run_workflow", "success": True,
                    "tool_result": {"workflow_id": "later-workflow", "status": "started"},
                }]},
            },
        ],
    )
    if snapshot_format != "none":
        for index in (1, 2):
            turn.ota_records[index]["prompt_context"] = {
                "state": {"think": {
                    "mode": "run_workflow", "stage": "execute", "workflow_id": "recorded-workflow",
                    "generation": "recorded-generation", "step_index": index - 1,
                }},
                "browser_tool_loaded": False, "workspace_tools_loaded": False, "skills_tool_loaded": False,
                "prompt_time": "2026-09-15 08:12 (UTC+08:00)",
            }
            if snapshot_format == "think_scope":
                snapshot = turn.ota_records[index].pop("prompt_context")
                state = snapshot.pop("state")
                turn.ota_records[index]["think_scope"] = {**state.pop("think"), **state, **snapshot}
    async with SessionTurnRepository()._session() as db:
        if entry_in_previous_turn:
            db.add(SessionTurnRecord(
                id="workflow-entry-turn", user_id="local", session_id=session.id, session_ordinal=0,
                user_input=UserInput(text="ORIGINAL_WORKFLOW_INPUT"), status=TurnStatus.COMPLETED,
                ota_records=[turn.ota_records[0]],
            ))
            turn.ota_records = [{"think_scope": {"mode": "run_workflow", "stage": "execute", "step_index": 0}}, *turn.ota_records[1:]]
        db.add(turn)
        await db.commit()
    workspace = Workspace(session.id, Path(session.workspace_root))
    if current_run != "absent":
        await workspace.prepare_run_workflow_space("create", initial_state={
            "workflow_id": "recorded-workflow" if current_run == "advanced" else "different-workflow",
            "generation": "recorded-generation" if current_run == "advanced" else "different-generation",
            "workflow_name": "CURRENT_RUN", "workflow_input": UserInput(text="CURRENT_RUN_INPUT"),
            "step_index": 1,
        })
    before_files = {path: path.read_bytes() for path in Path(session.workspace_root).rglob("*") if path.is_file()}
    stored = await SessionTurnRepository().get("local", turn.id)
    before_turn = stored.model_dump(mode="json")

    def reject_live_run(*args, **kwargs):
        raise AssertionError("Prompt inspection accessed the live Run")

    monkeypatch.setattr(RunWorkflowSpace, "checkpoint", reject_live_run)
    monkeypatch.setattr(WorkflowRunLibrary, "open_run_workflow", reject_live_run)
    monkeypatch.setattr(AmphiAgent, "arun", AsyncMock(side_effect=AssertionError("Prompt inspection ran the Agent")))
    invocation = AgentInvocation(AsyncMock(), SessionEventBroker(), SystemEventBroker())
    try:
        response = await invocation.get_prompt(session.id, turn.id, 1, mode="run_workflow", stage="execute")
        request = response["item"]["request"]
        assert request["worker"] == "WorkflowThink"
        text = "\n".join(Message.model_validate(item).content for item in request["messages"])
        assert "Workflow id: `recorded-workflow`" in text
        assert "Original Workflow input: ORIGINAL_WORKFLOW_INPUT" in text
        assert "Current section: 1. Collect" in text and "FIRST_STEP_INSTRUCTION" in text
        assert "SECOND_STEP_INSTRUCTION" not in text
        assert "SELECTED_ROUND_OUTPUT" not in text and "LATER_ROUND_OUTPUT" not in text
        assert "CURRENT_RUN_INPUT" not in text and "later-workflow" not in text
        second = await invocation.get_prompt(session.id, turn.id, 2, mode="run_workflow", stage="execute")
        text = "\n".join(Message.model_validate(item).content for item in second["item"]["request"]["messages"])
        assert "Current section: 2. Publish" in text and "SECOND_STEP_INSTRUCTION" in text
        assert "SELECTED_ROUND_OUTPUT" in text and "LATER_ROUND_OUTPUT" not in text
        assert {path: path.read_bytes() for path in Path(session.workspace_root).rglob("*") if path.is_file()} == before_files
        stored = await SessionTurnRepository().get("local", turn.id)
        assert stored.model_dump(mode="json") == before_turn
    finally:
        await invocation.shutdown()


@pytest.mark.parametrize("recorded_step", [None, 0, 1, 2])
@pytest.mark.parametrize("selection_status", ["idle", "selected", "skipped"])
async def test_get_prompt_uses_recorded_step_without_changing_round_history(agent_store, test_sandbox, recorded_step, selection_status) -> None:
    """Use the recorded cursor, retaining the Turn fallback only for legacy rounds."""
    session = SessionRecord(
        id="plan-prompt", user_id="local", workspace_root=str(test_sandbox.sessions / "plan-prompt"),
    )
    await SessionRepository().save(session)
    turn = SessionTurnRecord(
        id="plan-turn", user_id="local", session_id=session.id, session_ordinal=0,
        user_input=UserInput(text="Create a science deck"), status=TurnStatus.AWAITING_HUMAN,
        agent_state={"think": {
            "mode": "presentation", "stage": "ppt_plan", "goal": "Science deck",
            "step_index": 2, "outline_confirmed": True,
            "template_selection_status": selection_status,
        }},
        ota_records=[
            {
                "think_scope": {
                    "mode": "presentation", "stage": "ppt_plan",
                    **({"step_index": recorded_step} if recorded_step is not None else {}),
                },
                "think_result": {"step_content": content},
            }
            for content in ("Earlier round content", "Selected round output", "Later round content")
        ],
        browser_tool_loaded=True,
    )
    async with SessionTurnRepository()._session() as db:
        db.add(turn)
        await db.commit()
    stored = await SessionTurnRepository().get("local", turn.id)
    before = stored.model_dump(mode="json")
    invocation = AgentInvocation(AsyncMock(), SessionEventBroker(), SystemEventBroker())
    try:
        result = await invocation.get_prompt(session.id, turn.id, 1, mode="presentation", stage="ppt_plan")
        assert result["item"]["roundIndex"] == 1
        request = result["item"]["request"]
        system = Message.model_validate(request["messages"][0]).content
        assert "Goal: Science deck" not in system
        expected_step = recorded_step if recorded_step is not None else 2
        step_id = ("collect_evidence", "map_slides", "design_visual_direction")[expected_step]
        assert f"Current step id: {step_id}" in system
        for name in ("ppt_rag", "request_presentation_template_confirm"):
            assert (name in {tool["name"] for tool in request["tools"]}) is (expected_step == 2)
        messages = "\n".join(Message.model_validate(message).content for message in request["messages"])
        assert "Earlier round content" in messages
        assert "Selected round output" not in messages
        assert "Later round content" not in messages
        stored = await SessionTurnRepository().get("local", turn.id)
        assert stored.model_dump(mode="json") == before
    finally:
        await invocation.shutdown()


async def test_presentation_prompt_uses_only_artifacts_before_the_selected_round(agent_store, test_sandbox) -> None:
    """Later confirmations and final business state cannot leak into an earlier prompt."""
    from src.amphi_agent.cognitive.presentation.shared import write_artifact

    session = SessionRecord(id="artifact-prompt", user_id="local", workspace_root=str(test_sandbox.sessions / "artifact-prompt"))
    await SessionRepository().save(session)
    context = AmphiContext(workspace=Workspace(session.id, Path(session.workspace_root)))
    original = write_artifact(context, "outline", {"chapters": [{"title": "FIRST_CONFIRMED_OUTLINE"}]})
    revised = write_artifact(context, "outline", {"chapters": [{"title": "LATER_CONFIRMED_OUTLINE"}]})
    template = write_artifact(context, "template", {"selected_template": {"title": "LATER_TEMPLATE"}})
    (context.workspace.work_dir / ".ppt/plan.md").write_text("FUTURE_MUTABLE_PLAN", encoding="utf-8")
    original_bytes = (context.workspace.work_dir / original).read_bytes()

    def confirmation(name: str, artifact: str, id_key: str) -> dict:
        return {
            "think_scope": {"mode": "presentation", "stage": "ppt_plan", "step_index": 1},
            "action_result": {"results": [{
                "tool_id": artifact, "tool_name": name, "tool_arguments": {},
                "tool_result": {id_key: artifact, "artifact": artifact, "status": "selected" if id_key == "template_selection_id" else "confirmed"},
            }]},
        }

    turn = SessionTurnRecord(
        id="artifact-turn", session_id=session.id, user_id="local", session_ordinal=0,
        user_input=UserInput(text="Create a deck"), status=TurnStatus.COMPLETED,
        agent_state={"think": {"mode": "presentation", "stage": "ppt_plan", "step_index": 3,
            "goal": "FINAL_STATE_GOAL", "outline": [{"id": "final", "title": "FINAL_STATE_OUTLINE"}],
            "selected_template": {"title": "FINAL_STATE_TEMPLATE"}, "outline_confirmed": True,
        }},
        ota_records=[
            confirmation("request_presentation_outline_confirm", original, "outline_confirmation_id"),
            {"think_scope": {"mode": "presentation", "stage": "ppt_plan", "step_index": 2}},
            confirmation("request_presentation_outline_confirm", revised, "outline_confirmation_id"),
            confirmation("request_presentation_template_confirm", template, "template_selection_id"),
            {"think_scope": {"mode": "presentation", "stage": "ppt_plan", "step_index": 2}},
        ],
    )
    async with SessionTurnRepository()._session() as db:
        db.add(turn)
        await db.commit()
    invocation = AgentInvocation(AsyncMock(), SessionEventBroker(), SystemEventBroker())
    try:
        for index in (0, 1, 4):
            response = await invocation.get_prompt(session.id, turn.id, index, mode="presentation", stage="ppt_plan")
            system = Message.model_validate(response["item"]["request"]["messages"][0]).content
            assert ("FIRST_CONFIRMED_OUTLINE" in system) is (index == 1)
            assert ("LATER_CONFIRMED_OUTLINE" in system) is (index == 4)
            assert ("LATER_TEMPLATE" in system) is (index == 4)
            assert "FINAL_STATE_" not in system
            assert "FUTURE_MUTABLE_PLAN" not in system
        assert original != revised
        assert (context.workspace.work_dir / original).read_bytes() == original_bytes
    finally:
        await invocation.shutdown()
