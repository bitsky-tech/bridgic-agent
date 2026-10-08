"""The agent loop executes valid siblings and repairs only failed calls."""

import json
from types import SimpleNamespace

import pytest
from bridgic.amphibious import OTARecord, think_unit
from bridgic.amphibious._type import ThinkResult
from bridgic.core.agentic.tool_specs import FunctionToolSpec
from bridgic.core.model.types import ToolCallBlock, ToolResultBlock

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, MainThink, Session
from src.amphi_agent.cognitive.state import AwaitingPermission, CallVerdict, RoundPermission
from src.amphi_agent.tools import request_human_choice_tool, switch_tool
from src.amphi_service.protocol.llms._streaming import StreamResult, parse_tool_calls
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths
from tests.agent.core.test_action_boundary import _call, _context, _invoke, _ota


@pytest.mark.parametrize("include_valid_sibling", [True, False])
async def test_failed_call_returns_to_model_without_stopping_or_repeating_success(test_sandbox: IsolatedPaths, include_valid_sibling: bool) -> None:
    executions = []
    requests = []
    events = []
    raw = '{"value":"' + "x" * 2000

    async def valid_tool(value: str) -> str:
        executions.append(("A", value))
        return "A succeeded"

    async def broken_tool(value: str = "dangerous default") -> str:
        executions.append(("B", value))
        return "B succeeded"

    specs = [FunctionToolSpec.from_raw(valid_tool), FunctionToolSpec.from_raw(broken_tool)]

    class TestThink(MainThink):
        def select_tools(self, ota_context, context):
            return specs

    class TestAgent(AmphiAgent):
        main = think_unit(TestThink())

    class Model:
        protocol = "openai"

        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            requests.append(messages)
            if len(requests) == 1:
                buffers = [{"name": "valid_tool", "call_id": "a", "arguments": '{"value":"ok"}'}] if include_valid_sibling else []
                # Omit B's id: the worker must assign a stable id before folding.
                buffers.append({"name": "broken_tool", "arguments": raw})
                return StreamResult(tool_calls=parse_tool_calls(buffers), content="Use tools")
            calls = [block for message in messages for block in message.blocks if isinstance(block, ToolCallBlock)]
            results = [block for message in messages for block in message.blocks if isinstance(block, ToolResultBlock)]
            assert [call.id for call in calls] == [result.id for result in results]
            if len(requests) == 2:
                assert len(results) == (2 if include_valid_sibling else 1)
                assert executions == ([("A", "ok")] if include_valid_sibling else [])
                assert "not executed" in results[-1].content
                assert json.dumps(raw) in results[-1].content
                assert calls[-1].arguments == {}
                return StreamResult(tool_calls=[{"name": "broken_tool", "call_id": "b-fixed", "arguments": {"value": "fixed"}}], content="Retry B only")
            assert len(requests) == 3
            assert results[-1].content == "B succeeded"
            return StreamResult(tool_calls=[], content="All done")

    record = SessionRecord(id="call-failures", user_id="local", workspace_root=str(test_sandbox.sessions / "call-failures"))
    context = AmphiContext(session=Session(record, []), execution_mode="full")
    ota = AmphiOTAContext(user_input="Run both tools", stream=SimpleNamespace(publish=lambda event, **data: events.append((event, data))))
    result = await TestAgent().arun(llm=Model(), context=context, ota_context=ota)
    assert result == "All done"
    assert executions == ([("A", "ok"), ("B", "fixed")] if include_valid_sibling else [("B", "fixed")])
    assert len(requests) == 3

    # Every live failure has its own call card, exactly once, before its result.
    live_calls = [data for event, data in events if event == "tool"]
    live_results = [data for event, data in events if event == "tool_result"]
    assert len(live_calls) == len(live_results) == (3 if include_valid_sibling else 2)
    assert {data["tool_id"] for data in live_calls} == {data["tool_id"] for data in live_results}
    failures = [data for data in live_results if not data["success"]]
    assert len(failures) == 1
    failure = failures[0]
    assert "not executed" in failure["error"]
    assert failure["duration_ms"] == 0
    assert [event for event, data in events if data.get("tool_id") == failure["tool_id"]] == ["tool", "tool_result"]

    # The failure and complete original text survive persisted Session history.
    saved = SessionTurnRecord(
        id="saved", user_id="local", session_id=record.id, session_ordinal=0,
        user_input=UserInput(text="Run both tools"), status=TurnStatus.COMPLETED,
        ota_records=[entry.model_dump(mode="json") for entry in ota.ota_record],
        agent_state=ota.state.model_dump(mode="json"),
    )
    history_context = AmphiContext(session=Session(record, [saved]), execution_mode="full")
    history = await MainThink().session_messages_block(AmphiOTAContext(user_input="Continue"), history_context)
    historical_results = [block for message in history for block in message.blocks if isinstance(block, ToolResultBlock)]
    assert len(historical_results) == (3 if include_valid_sibling else 2)
    assert any(json.dumps(raw) in block.content for block in historical_results)


@pytest.mark.parametrize("control_tool", [switch_tool, request_human_choice_tool])
async def test_invalid_control_call_does_not_block_valid_sibling(test_sandbox: IsolatedPaths, control_tool) -> None:
    executions = []
    events = []

    async def ordinary_tool() -> str:
        executions.append("A")
        return "Done"

    ota = _ota([_call("a", "ordinary_tool"), _call("b", control_tool.tool_name)], [FunctionToolSpec.from_raw(ordinary_tool), control_tool])
    ota.stream = SimpleNamespace(publish=lambda event, **data: events.append((event, data)))
    ota.ota_record[-1].tool_call_errors = {"b": {"error": "Invalid tool argument JSON; not executed", "raw_arguments": '{"stage":'}}
    # Round-trip the metadata as a parked or restored round would do.
    ota.ota_record[-1] = OTARecord.model_validate_json(ota.ota_record[-1].model_dump_json())
    ota.think_result = ThinkResult.model_validate(ota.think_result)
    context = _context(test_sandbox.sessions / "invalid-control")
    agent = AmphiAgent()
    ota.think_result = await _invoke(agent.before_action(ota, context))
    assert [call.call_id for call in ota.think_result.tool_calls] == ["a"]
    result = await agent.action_tool_call(ota, context)
    assert executions == ["A"]
    assert [(step.tool_id, step.success) for step in result.results] == [("a", True), ("b", False)]
    assert [event for event, data in events if data.get("tool_id") == "b"] == []
    ota.action_result = result
    await _invoke(agent.after_action(ota, context))
    assert [event for event, data in events if data.get("tool_id") == "b"] == []
    messages = MainThink._tool_round_messages(ota._current_record(), "control")
    failures = [block for message in messages for block in message.blocks if isinstance(block, ToolResultBlock) and block.id == "b"]
    assert len(failures) == 1
    assert "Invalid tool argument JSON" in failures[0].content
    assert json.dumps('{"stage":') in failures[0].content
    assert all(event in ("tool", "tool_result") for event, _ in events)


async def test_executor_cannot_run_parse_placeholder_even_without_admission(test_sandbox: IsolatedPaths) -> None:
    executions = []

    async def default_tool(value: str = "default") -> str:
        executions.append(value)
        return value

    ota = _ota([_call("bad", "default_tool")], [FunctionToolSpec.from_raw(default_tool)])
    ota.ota_record[-1].tool_call_errors = {"bad": {"error": "Invalid tool argument JSON; not executed", "raw_arguments": ""}}
    result = await AmphiAgent()._execute_tool_calls(ota, _context(test_sandbox.sessions / "defensive-executor"))
    assert not executions
    assert result.results[0].success is False
    assert "Invalid tool argument JSON" in result.results[0].error


async def test_approval_resume_never_approves_or_executes_a_parse_failure(test_sandbox: IsolatedPaths) -> None:
    executions = []
    classified = []
    events = []
    stream = SimpleNamespace(publish=lambda event, **data: events.append((event, data)))

    async def permitted_tool() -> str:
        executions.append("A")
        return "Approved A succeeded"

    async def malformed_tool(value: str = "default") -> str:
        executions.append("B")
        return value

    specs = [FunctionToolSpec.from_raw(permitted_tool), FunctionToolSpec.from_raw(malformed_tool)]

    class TestThink(MainThink):
        def select_tools(self, ota_context, context):
            return specs

        async def _check_action_permissions(self, ota_context, context, calls, agent, *, execution_mode=None):
            classified.extend(call.call_id for call in calls)
            return [CallVerdict(id=call.call_id, tool=call.tool, arguments={}, verdict="ask") for call in calls]

    class TestAgent(AmphiAgent):
        main = think_unit(TestThink())

    # Put B first to verify permission card indices remain aligned to the full batch.
    ota = _ota([_call("bad", "malformed_tool"), _call("good", "permitted_tool")], specs)
    ota.stream = stream
    ota.ota_record[-1].permission = RoundPermission(reviewed=False)
    ota.ota_record[-1].tool_call_errors = {"bad": {"error": "Invalid tool argument JSON; not executed", "raw_arguments": '{"value":'}}
    context = _context(test_sandbox.sessions / "parse-failure-approval")
    agent = TestAgent()
    decision = await _invoke(agent.before_action(ota, context))
    assert decision.tool_calls == []
    assert isinstance(ota.interaction_status, AwaitingPermission)
    assert classified == ["good"]
    permission = ota.interaction_status.permission
    assert permission["verdicts"] == ["deny", "ask"]
    assert [item["call_index"] for item in permission["items"]] == [1]
    assert not executions
    await _invoke(agent.after_action(ota, context))
    assert not any(event in ("tool", "tool_result") for event, _ in events)

    resumed = AmphiOTAContext(user_input={"type": "permission_answer", "answers": [{"call_index": 1, "decision": "allow"}]}, stream=stream)
    resumed.transition_interaction(ota.interaction_status)
    rounds = json.loads(json.dumps([record.model_dump(mode="json") for record in ota.ota_record]))
    await agent._resume_permission(resumed, context, permission, rounds, "Run both tools")
    assert executions == ["A"]
    assert classified == ["good"]
    results = {step.tool_id: step for step in resumed.action_result.results}
    assert results["good"].success is True
    assert results["bad"].success is False
    assert "Invalid tool argument JSON" in results["bad"].error
    assert resumed.ota_record[-1].tool_call_errors["bad"]["raw_arguments"] == '{"value":'
    for tool_id in ("bad", "good"):
        assert [event for event, data in events if data.get("tool_id") == tool_id] == ["tool", "tool_result"]
