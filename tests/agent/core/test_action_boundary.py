import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.amphibious import OTARecord, StepToolCall, ToolArgument
from bridgic.amphibious._type import ThinkResult
from bridgic.core.agentic.tool_specs import FunctionToolSpec, ToolSpec

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session
from src.amphi_agent._error import AgentEmptyAnswerError
from src.amphi_agent._state import CallVerdict, RoundPermission
from src.amphi_agent.security import Permission
from src.amphi_agent.tools import request_human_choice_tool, run_subagent_tool
from src.amphi_store import SessionRecord
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
SESSION_ID = "session-action-boundary"


def _context(root: Path) -> AmphiContext:
    record = SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root=str(root),
    )
    return AmphiContext(session=Session(record, []))


def _call(call_id: str, tool: str, **arguments: Any) -> StepToolCall:
    return StepToolCall(
        call_id=call_id,
        tool=tool,
        tool_arguments=[
            ToolArgument(name=name, value=value)
            for name, value in arguments.items()
        ],
    )


def _ota(calls: list[StepToolCall], tools: list[ToolSpec]) -> AmphiOTAContext:
    record = OTARecord(think_result=ThinkResult(step_content="Use the requested tools", tool_calls=calls))
    record.permission = RoundPermission(
        execution_mode="auto",
        reviewed=True,
        verdicts=[
            CallVerdict(
                id=call.call_id or f"missing-{index}",
                tool=call.tool,
                arguments={argument.name: argument.value for argument in call.tool_arguments},
                verdict=Permission.ALLOW.value,
            )
            for index, call in enumerate(calls)
        ],
    )
    return AmphiOTAContext(
        user_input="Exercise the action boundary",
        ota_record=[record],
        tools=tools,
    )


async def _invoke(hook: AsyncIterator[Any]) -> Any:
    returned = None
    async for instruction in hook:
        assert returned is None
        returned = instruction.value
    return returned


async def test_unavailable_calls(test_sandbox: IsolatedPaths) -> None:
    """Final action results:

    {
      "hidden_tool": {"executed": false, "error": "not available"},
      "visible_without_id": {"executed": false, "error": "call id is missing"}
    }

    Checks:
    1. A model call outside the current ToolSurface is removed before execution.
    2. A visible call without a provider identity never reaches its executor.
    3. Both rejected calls become explicit failed results for the next model round.
    """
    def missing_id_call(tool: str, **arguments: Any) -> StepToolCall:
        return StepToolCall.model_construct(
            call_id="",
            tool=tool,
            tool_arguments=[
                ToolArgument(name=name, value=value)
                for name, value in arguments.items()
            ],
        )

    executions: list[str] = []

    async def visible_tool(value: str) -> str:
        executions.append(value)
        return value

    calls = [
        _call("call-hidden", "hidden_tool", value="secret"),
        missing_id_call("visible_tool", value="visible"),
    ]
    ota_context = _ota(calls, [FunctionToolSpec.from_raw(visible_tool)])
    context = _context(test_sandbox.sessions / SESSION_ID)
    agent = AmphiAgent()

    admitted = await _invoke(agent.before_action(ota_context, context))

    # Check 1: A model call outside the current ToolSurface is removed before execution.
    assert [call.tool for call in admitted.tool_calls] == ["visible_tool"]
    gate = ota_context.ota_record[-1].permission
    assert gate.verdicts[0].verdict == Permission.DENY.value
    assert "not available" in (gate.verdicts[0].reason or "")

    ota_context.think_result = admitted
    result = await agent.action_tool_call(ota_context, context)

    # Check 2: A visible call without a provider identity never reaches its executor.
    assert executions == []
    missing = next(step for step in result.results if step.tool_name == "visible_tool")
    assert missing.success is False
    assert "call id is missing" in (missing.error or "")

    # Check 3: Both rejected calls become explicit failed results for the next model round.
    hidden = next(step for step in result.results if step.tool_name == "hidden_tool")
    assert hidden.success is False
    assert "not available" in (hidden.error or "")


async def test_duplicate_ids(test_sandbox: IsolatedPaths) -> None:
    """Final admitted batch:

    {
      "tool_calls": [],
      "failed_results": ["call duplicate rejected", "call duplicate rejected"]
    }

    Checks:
    1. Repeated provider call ids reject the entire model batch before execution.
    2. Every rejected call receives its own failed-result identity and duplicate reason.
    """
    executions: list[str] = []

    async def ordinary_tool(value: str) -> str:
        executions.append(value)
        return value

    calls = [
        _call("call-duplicate", "ordinary_tool", value="first"),
        _call("call-duplicate", "ordinary_tool", value="second"),
    ]
    ota_context = _ota(calls, [FunctionToolSpec.from_raw(ordinary_tool)])
    context = _context(test_sandbox.sessions / SESSION_ID)
    agent = AmphiAgent()

    admitted = await _invoke(agent.before_action(ota_context, context))

    # Check 1: Repeated provider call ids reject the entire model batch before execution.
    assert admitted.tool_calls == []
    assert executions == []

    ota_context.think_result = admitted
    await _invoke(agent.after_action(ota_context, context))
    results = ota_context.action_result.results

    # Check 2: Every rejected call receives its own failed-result identity and duplicate reason.
    assert len(results) == 2
    assert len({step.tool_id for step in results}) == 2
    assert all(step.success is False for step in results)
    assert all("duplicate call id" in (step.error or "") for step in results)


async def test_control_mix(test_sandbox: IsolatedPaths) -> None:
    """Final admitted batch:

    {
      "request_human_choice": "denied",
      "run_subagent": "denied",
      "executed": []
    }

    Checks:
    1. An exclusive human-control call cannot share a round with awaited delegation.
    2. The whole control-flow batch is returned as failed results without side effects.
    """
    calls = [
        _call(
            "call-choice",
            "request_human_choice",
            questions='[{"question":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]',
            prompt="Choose how to continue",
        ),
        _call("call-child", "run_subagent", goal="Inspect the isolated concern"),
    ]
    ota_context = _ota(calls, [request_human_choice_tool, run_subagent_tool])
    context = _context(test_sandbox.sessions / SESSION_ID)
    agent = AmphiAgent()

    admitted = await _invoke(agent.before_action(ota_context, context))
    gate = ota_context.ota_record[-1].permission

    # Check 1: An exclusive human-control call cannot share a round with awaited delegation.
    assert admitted.tool_calls == []
    assert [verdict.verdict for verdict in gate.verdicts] == ["deny", "deny"]
    assert all("only one exclusive control tool" in (verdict.reason or "") for verdict in gate.verdicts)

    ota_context.think_result = admitted
    await _invoke(agent.after_action(ota_context, context))

    # Check 2: The whole control-flow batch is returned as failed results without side effects.
    assert [step.tool_name for step in ota_context.action_result.results] == [
        "request_human_choice",
        "run_subagent",
    ]
    assert all(step.success is False for step in ota_context.action_result.results)
    assert ota_context.interaction_status is None
    assert ota_context.subagent_status is None


async def test_parallel_calls(test_sandbox: IsolatedPaths) -> None:
    """Final ordinary-tool results:

    {
      "call-first": {"result": "first:A", "position": 0},
      "call-second": {"result": "second:B", "position": 1}
    }

    Checks:
    1. Independent admitted calls begin concurrently instead of serially blocking one another.
    2. Results retain model call order and each call id remains paired with its own output.
    """
    started: list[str] = []
    all_started = asyncio.Event()

    async def first_tool(value: str) -> str:
        started.append("first")
        if len(started) == 2:
            all_started.set()
        await asyncio.wait_for(all_started.wait(), timeout=1)
        return f"first:{value}"

    async def second_tool(value: str) -> str:
        started.append("second")
        if len(started) == 2:
            all_started.set()
        await asyncio.wait_for(all_started.wait(), timeout=1)
        return f"second:{value}"

    calls = [
        _call("call-first", "first_tool", value="A"),
        _call("call-second", "second_tool", value="B"),
    ]
    tools = [
        FunctionToolSpec.from_raw(first_tool),
        FunctionToolSpec.from_raw(second_tool),
    ]
    ota_context = _ota(calls, tools)
    context = _context(test_sandbox.sessions / SESSION_ID)
    agent = AmphiAgent()

    admitted = await _invoke(agent.before_action(ota_context, context))
    ota_context.think_result = admitted
    result = await agent.action_tool_call(ota_context, context)

    # Check 1: Independent admitted calls begin concurrently instead of serially blocking one another.
    assert set(started) == {"first", "second"}

    # Check 2: Results retain model call order and each call id remains paired with its own output.
    assert [step.tool_id for step in result.results] == ["call-first", "call-second"]
    assert [step.tool_result for step in result.results] == ["first:A", "second:B"]
    assert all(step.success is True for step in result.results)


async def test_empty_answer(test_sandbox: IsolatedPaths) -> None:
    """Final empty-answer handling:

    {
      "empty_answer": "up to three continuations with recovery instructions",
      "next_visible_answer": "Delivered answer",
      "fourth_empty": "AgentEmptyAnswerError"
    }

    Checks:
    1. Three empty Main responses each dispatch another Main round with stronger guidance.
    2. A visible third continuation becomes the Turn result.
    3. A fourth consecutive empty response fails with the typed Agent exception.
    """
    context = _context(test_sandbox.sessions / SESSION_ID)
    agent = AmphiAgent()
    stream = SimpleNamespace(publish=lambda *_args, **_kwargs: None)
    ota_context = AmphiOTAContext(user_input="Provide a visible answer", stream=stream)
    loop = agent.on_agent(ota_context, context)
    first = await anext(loop)
    assert first.name == "main"
    for _attempt in range(3):
        ota_context.ota_record.append(OTARecord(
            think_result=ThinkResult(step_content="", tool_calls=[]),
        ))
        continuation = await loop.asend("")

        # Check 1: Every permitted empty answer gets a clear, action-bounded recovery round.
        assert continuation.name == "main"
        guidance = ota_context.ota_record[-1].observation_result
        assert "clear summary of the task outcome" in guidance
        assert "where the result can be found" in guidance
        assert "There is no need to call more tools" in guidance

    ota_context.ota_record.append(OTARecord(
        think_result=ThinkResult(step_content="Delivered answer", tool_calls=[]),
    ))
    returned = await loop.asend("Delivered answer")

    # Check 2: A visible answer is accepted after all three recovery rounds were available.
    assert returned.value == "Delivered answer"
    await loop.aclose()

    failing_agent = AmphiAgent()
    failing_ota = AmphiOTAContext(user_input="Do not return an empty answer", stream=stream)
    failing_loop = failing_agent.on_agent(failing_ota, context)
    await anext(failing_loop)
    for _attempt in range(3):
        failing_ota.ota_record.append(OTARecord(
            think_result=ThinkResult(step_content="", tool_calls=[]),
        ))
        await failing_loop.asend("")
    failing_ota.ota_record.append(OTARecord(
        think_result=ThinkResult(step_content="", tool_calls=[]),
    ))

    # Check 3: The fourth empty answer fails explicitly with its recognized Agent exception.
    with pytest.raises(AgentEmptyAnswerError, match="after 3 recovery attempts"):
        await failing_loop.asend("")
