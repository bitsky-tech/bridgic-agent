import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from bridgic.amphibious import OTARecord, StepToolCall
from bridgic.amphibious._type import ThinkResult
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._invocation import AgentInvocation, InvocationNotFoundError
from src.amphi_agent._tools import ToolLibrary
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.cognitive.state import RoundPermission
from src.amphi_agent.tools._bash import current_execution_mode, current_tool_call_id
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_service.runtime._system_events import SystemEventBroker
from src.amphi_store import SessionRecord, SessionRepository, SessionTurnRecord, SessionTurnRepository, TurnStatus, UserInput


async def test_tool_durations_survive_storage_and_distinguish_parallel_calls(agent_store, test_sandbox, monkeypatch):
    now = [0.0]
    monkeypatch.setattr("src.amphi_agent._agent.time", SimpleNamespace(monotonic=lambda: now[0]))

    async def duration_probe(kind: str):
        await asyncio.sleep(0)
        now[0] += 1 if kind == "fast" else 2
        if kind == "failed":
            raise RuntimeError("Tool failed")
        return kind

    spec = FunctionToolSpec.from_raw(duration_probe)
    calls = [
        StepToolCall(call_id=kind, tool="duration_probe", tool_arguments=[{"name": "kind", "value": kind}])
        for kind in ("fast", "failed")
    ]
    calls.append(StepToolCall(call_id="unavailable", tool="unavailable", tool_arguments=[]))
    record = OTARecord(
        think_result=ThinkResult(step_content="", tool_calls=calls),
        permission=RoundPermission(execution_mode="full"),
    )
    stream = Mock()
    ota = AmphiOTAContext(tools=[spec], ota_record=[record], stream=stream)
    agent = AmphiAgent()
    run_tool = agent._execute_tool_call
    fast_finished = asyncio.Event()

    async def ordered_finish(call, tool_spec, execution_mode):
        if call.id == "failed":
            await fast_finished.wait()
        result = await run_tool(call, tool_spec, execution_mode)
        if call.id == "fast":
            fast_finished.set()
        return result

    monkeypatch.setattr(agent, "_execute_tool_call", ordered_finish)
    ota.action_result = await agent.action_tool_call(ota, AmphiContext())
    assert [step.success for step in ota.action_result.results] == [True, False, False]
    values = AgentInvocation._ota_context_values(ota)
    saved = values["ota_records"][0]
    assert saved["tool_durations_ms"] == {"fast": 1000, "failed": 3000}
    assert saved["act_duration_ms"] == 3000
    published = [call.kwargs for call in stream.publish.call_args_list if call.args == ("tool_result",)]
    assert [(item["tool_id"], item["duration_ms"]) for item in published] == [
        ("fast", 1000), ("failed", 3000), ("unavailable", 0),
    ]

    session = SessionRecord(id="timing", user_id="local", workspace_root=str(test_sandbox.sessions / "timing"))
    await SessionRepository().save(session)
    turn = SessionTurnRecord(
        id="timed-turn", session_id=session.id, user_id="local", session_ordinal=0,
        user_input=UserInput(text="Run tools"), status=TurnStatus.COMPLETED, **values,
    )
    turns = SessionTurnRepository()
    async with turns._session() as db:
        db.add(turn)
        await db.commit()
    reloaded = await turns.get("local", turn.id)
    restored = AmphiOTAContext.model_validate(reloaded.ota_context_dump())
    assert restored.ota_record[0].tool_durations_ms == {"fast": 1000, "failed": 3000}


async def test_debug_tool_preserves_json_arguments_and_binds_context(monkeypatch):
    context = AmphiContext(execution_mode="full")
    agent = AmphiAgent()
    previous_context, previous_ota = AmphiContext(), AmphiOTAContext()
    agent._current_context, agent._current_ota_context = previous_context, previous_ota
    outer_agent = current_agent.get(None)

    async def probe(count: int, enabled: bool, options: dict, items: list, optional: str = None):
        assert current_agent.get() is agent
        assert agent.ctx is context
        assert agent._current_ota_context is not previous_ota
        assert current_execution_mode.get() == "full"
        assert current_tool_call_id.get()
        return {"count": count, "enabled": enabled, "options": options, "items": items, "optional": optional}

    spec = FunctionToolSpec.from_raw(probe)
    monkeypatch.setattr(ToolLibrary, "select", lambda self, names: [spec])
    result = await agent.execute_tool(context, "probe", {
        "count": "3", "enabled": False, "options": {"nested": True}, "items": [1, None], "optional": None,
    })
    assert result.success, result.error
    assert result.tool_result == {"count": 3, "enabled": False, "options": {"nested": True}, "items": [1, None], "optional": None}
    assert agent.ctx is previous_context and agent._current_ota_context is previous_ota
    assert current_agent.get(None) is outer_agent
    assert current_tool_call_id.get(None) is None
    assert current_execution_mode.get(None) is None


async def test_debug_tool_restores_binding_after_cancellation(monkeypatch):
    agent = AmphiAgent()
    outer_agent = current_agent.get(None)
    monkeypatch.setattr(agent, "_execute_tool_call", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        await agent.execute_tool(AmphiContext(), "read_file", {"file_path": "unused"})
    assert current_agent.get(None) is outer_agent
    assert agent.ctx is None and agent._current_ota_context is None


async def test_debug_execution_uses_current_workspace_without_turn_replay(agent_store, test_sandbox, monkeypatch):
    session = SessionRecord(id="tool-debug", user_id="local", workspace_root=str(test_sandbox.sessions / "tool-debug"))
    await SessionRepository().save(session)
    session = await SessionRepository().load(session.id, "local")
    turns = SessionTurnRepository()
    original = SessionTurnRecord(
        id="historical", session_id=session.id, user_id="local", session_ordinal=0,
        status=TurnStatus.COMPLETED, user_input=UserInput(text="old request"),
        ota_records=[{"think_result": {"step_content": "historical response"}}],
    )
    async with turns._session() as db:
        db.add(original)
        await db.commit()
    original = await turns.get("local", original.id)
    workspace = Workspace(session.id, session_root=Path(session.workspace_root))
    workspace.work_dir.mkdir(parents=True)
    source = workspace.work_dir / "example.txt"
    source.write_text("current contents")
    llms = AsyncMock()
    invocation = AgentInvocation(llms, SessionEventBroker(), SystemEventBroker())
    prepare = AsyncMock(side_effect=AssertionError("Debug must not initialize a workspace"))
    run = AsyncMock(side_effect=AssertionError("Debug must not run a Turn"))
    monkeypatch.setattr(Workspace, "prepare_workspace", prepare)
    monkeypatch.setattr(AmphiAgent, "arun", run)
    monkeypatch.setattr(invocation._turns, "list_conversation", AsyncMock(side_effect=AssertionError("No history needed")))
    try:
        response = await invocation.execute_tool(session.id, "read_file", {"file_path": "example.txt", "limit": "1"})
        assert response["sessionId"] == session.id
        assert response["durationMs"] >= 0
        assert response["result"]["success"], response
        assert "current contents" in response["result"]["tool_result"]
        assert response["result"]["tool_arguments"]["limit"] == 1
        source.write_text("changed after the first test")
        second = await invocation.execute_tool(session.id, "read_file", {"file_path": "example.txt"})
        assert "changed after the first test" in second["result"]["tool_result"]
        assert second["result"]["tool_id"] != response["result"]["tool_id"]
        failed = await invocation.execute_tool(session.id, "read_file", {"file_path": "missing.txt"})
        assert failed["result"]["success"] is False
        assert failed["result"]["error"]
        request = await invocation.execute_tool(session.id, "request_presentation", {"goal": "Test deck"})
        assert request["result"]["tool_result"] == {"goal": "Test deck"}
        assert (await turns.get("local", original.id)).model_dump() == original.model_dump()
        assert len(await turns.list_conversation("local", session.id)) == 1
        assert (await SessionRepository().load(session.id, "local")).model_dump() == session.model_dump()
        llms.resolve.assert_not_awaited()
        prepare.assert_not_awaited()
        run.assert_not_awaited()
    finally:
        await invocation.shutdown()


async def test_debug_execution_does_not_recreate_missing_resources(agent_store, test_sandbox):
    session = SessionRecord(id="missing-workspace", user_id="local", workspace_root=str(test_sandbox.sessions / "missing-workspace"))
    await SessionRepository().save(session)
    invocation = AgentInvocation(AsyncMock(), SessionEventBroker(), SystemEventBroker())
    try:
        result = await invocation.execute_tool(session.id, "read_file", {"file_path": "example.txt"})
        assert result["result"]["success"] is False
        assert "Workspace directory is unavailable" in result["result"]["error"]
        assert not Path(session.workspace_root).exists()
        with pytest.raises(ValueError, match="Unknown tool"):
            await invocation.execute_tool(session.id, "removed_tool", {})
        with pytest.raises(InvocationNotFoundError):
            await invocation.execute_tool("missing-session", "read_file", {})
    finally:
        await invocation.shutdown()
