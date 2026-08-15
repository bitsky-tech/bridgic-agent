from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.amphibious._type import StepToolCall, ThinkResult, ToolArgument
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from src.amphi_agent._agent import AmphiAgent, TOOL_RESULT_INLINE_CHAR_LIMIT
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._state import RoundPermission
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools._bash import bash_tool, current_execution_mode, current_tool_call_id


async def test_tool_dispatch_binds_each_concurrent_call_id() -> None:
    async def capture(label: str) -> str:
        await asyncio.sleep(0)
        return f"{label}:{current_tool_call_id.get()}"

    ota_context = AmphiOTAContext(user_input="x")
    ota_context.tools = [FunctionToolSpec.from_raw(capture)]
    ota_context.think_result = ThinkResult(step_content="", tool_calls=[
        StepToolCall(
            call_id="call-a",
            tool="capture",
            tool_arguments=[ToolArgument(name="label", value="a")],
        ),
        StepToolCall(
            call_id="call-b",
            tool="capture",
            tool_arguments=[ToolArgument(name="label", value="b")],
        ),
    ])

    result = await AmphiAgent()._execute_tool_calls(ota_context)

    assert [(step.tool_id, step.tool_result) for step in result.results] == [
        ("call-a", "a:call-a"),
        ("call-b", "b:call-b"),
    ]


async def test_bash_dispatch_binds_the_round_execution_mode() -> None:
    """Each concurrent Bash worker receives the admitted Round's effective mode."""
    seen: list[tuple[str, str | None, str | None]] = []

    async def bash(command: str) -> str:
        seen.append((command, current_tool_call_id.get(), current_execution_mode.get()))
        await asyncio.sleep(0)
        if command == "fail":
            raise RuntimeError("bash failed")
        return "ok"

    ota_context = AmphiOTAContext(user_input="x")
    ota_context.tools = [FunctionToolSpec.from_raw(bash)]
    decision = ThinkResult(step_content="", tool_calls=[
        StepToolCall(
            call_id="call-ok",
            tool="bash",
            tool_arguments=[ToolArgument(name="command", value="succeed")],
        ),
        StepToolCall(
            call_id="call-fail",
            tool="bash",
            tool_arguments=[ToolArgument(name="command", value="fail")],
        ),
    ])
    ota_context.ota_record = [OTARecord(
        think_result=decision,
        permission=RoundPermission(execution_mode="full"),
    )]
    context = AmphiContext(execution_mode="request")

    result = await AmphiAgent()._execute_tool_calls(ota_context, context)

    assert set(seen) == {
        ("succeed", "call-ok", "full"),
        ("fail", "call-fail", "full"),
    }
    by_id = {step.tool_id: step for step in result.results}
    assert by_id["call-ok"].success is True
    assert by_id["call-ok"].tool_result == "ok"
    assert by_id["call-fail"].success is False
    assert by_id["call-fail"].error == "bash failed"


async def test_tool_dispatch_rejects_duplicate_call_ids_without_side_effects() -> None:
    executed: list[str] = []

    async def capture(label: str) -> str:
        executed.append(label)
        return label

    ota_context = AmphiOTAContext(user_input="x")
    ota_context.tools = [FunctionToolSpec.from_raw(capture)]
    ota_context.think_result = ThinkResult(step_content="", tool_calls=[
        StepToolCall(
            call_id="call-duplicate",
            tool="capture",
            tool_arguments=[ToolArgument(name="label", value="a")],
        ),
        StepToolCall(
            call_id="call-duplicate",
            tool="capture",
            tool_arguments=[ToolArgument(name="label", value="b")],
        ),
    ])

    result = await AmphiAgent()._execute_tool_calls(ota_context)

    assert executed == []
    assert len(result.results) == 2
    assert len({step.tool_id for step in result.results}) == 2
    assert all(step.success is False for step in result.results)
    assert all("duplicate call id" in step.error for step in result.results)


async def test_duplicate_call_ids_are_rejected_before_permission_review(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_permission_check(*_args, **_kwargs):
        pytest.fail("duplicate tool identities must be rejected before permission review")

    agent = AmphiAgent()
    monkeypatch.setattr(agent, "permission_check", fail_permission_check)
    ota_context = AmphiOTAContext(user_input="x")
    ota_context.open_record()
    ota_context.think_result = ThinkResult(step_content="", tool_calls=[
        StepToolCall(
            call_id="call-duplicate",
            tool="capture",
            tool_arguments=[ToolArgument(name="label", value="a")],
        ),
        StepToolCall(
            call_id="call-duplicate",
            tool="capture",
            tool_arguments=[ToolArgument(name="label", value="b")],
        ),
    ])
    context = AmphiContext(workspace=Workspace("session", session_root=tmp_path))

    gate = agent.before_action(ota_context, context)
    rejected = (await gate.asend(None)).value
    await gate.aclose()
    assert rejected.tool_calls == []

    async for _ in agent.after_action(ota_context, context):
        pass
    assert ota_context.action_result is not None
    assert len(ota_context.action_result.results) == 2
    assert len({step.tool_id for step in ota_context.action_result.results}) == 2


async def test_tool_dispatch_returns_failed_results_for_unavailable_calls() -> None:
    async def capture(label: str) -> str:
        return label

    ota_context = AmphiOTAContext(user_input="x")
    ota_context.tools = [FunctionToolSpec.from_raw(capture)]
    ota_context.think_result = ThinkResult(step_content="", tool_calls=[
        StepToolCall(
            call_id="call-missing",
            tool="run_subagent",
            tool_arguments=[ToolArgument(name="goal", value="nested task")],
        ),
        StepToolCall(
            call_id="call-capture",
            tool="capture",
            tool_arguments=[ToolArgument(name="label", value="done")],
        ),
    ])

    result = await AmphiAgent()._execute_tool_calls(ota_context)

    assert [step.tool_id for step in result.results] == ["call-missing", "call-capture"]
    assert result.results[0].success is False
    assert result.results[0].tool_name == "run_subagent"
    assert "not available in this Session's current ToolSurface" in result.results[0].error
    assert result.results[1].success is True
    assert result.results[1].tool_result == "done"


async def test_action_tool_call_spills_large_tool_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session")
    context = AmphiContext(workspace=workspace)
    large_output = "x" * (TOOL_RESULT_INLINE_CHAR_LIMIT + 1)
    action_result = ActionResult(results=[
        ActionStepResult(
            tool_id="call_large",
            tool_name="bash/shell",
            tool_arguments={},
            tool_result=large_output,
            success=True,
        ),
        ActionStepResult(
            tool_id="call_small",
            tool_name="read_file",
            tool_arguments={},
            tool_result="small",
            success=True,
        ),
    ])

    async def fake_action_tool_call(self, ota_context, context=None):
        return action_result

    monkeypatch.setattr(AmphiAgent, "_execute_tool_calls", fake_action_tool_call)

    ota_context = AmphiOTAContext(user_input="x")
    ota_context.think_result = ThinkResult(step_content="", tool_calls=[])

    result = await AmphiAgent().action_tool_call(ota_context, context)

    saved_files = list(workspace.tool_result_dir.glob("*/*.txt"))
    assert len(saved_files) == 1
    saved_path = saved_files[0]
    assert saved_path.parent.name
    assert saved_path.name.startswith("bash_shell_")
    assert saved_path.read_text(encoding="utf-8") == large_output

    replacement = result.results[0].tool_result
    assert "Tool result exceeded inline limit and was written to file." in replacement
    assert str(saved_path) in replacement
    assert f"Bytes: {len(large_output.encode('utf-8'))}" in replacement
    assert f"Inline limit: {TOOL_RESULT_INLINE_CHAR_LIMIT} characters." in replacement
    assert result.results[1].tool_result == "small"


async def test_action_tool_call_spills_large_tool_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session")
    context = AmphiContext(workspace=workspace)
    large_error = "e" * (TOOL_RESULT_INLINE_CHAR_LIMIT + 1)
    action_result = ActionResult(results=[
        ActionStepResult(
            tool_id="call_failed",
            tool_name="bash",
            tool_arguments={},
            tool_result=None,
            success=False,
            error=large_error,
        ),
        ActionStepResult(
            tool_id="call_boundary",
            tool_name="bash",
            tool_arguments={},
            tool_result=None,
            success=False,
            error="b" * TOOL_RESULT_INLINE_CHAR_LIMIT,
        ),
    ])

    async def fake_action_tool_call(self, ota_context, context=None):
        return action_result

    monkeypatch.setattr(AmphiAgent, "_execute_tool_calls", fake_action_tool_call)

    ota_context = AmphiOTAContext(user_input="x")
    ota_context.think_result = ThinkResult(step_content="", tool_calls=[])

    result = await AmphiAgent().action_tool_call(ota_context, context)

    saved_files = list(workspace.tool_result_dir.glob("*/*.txt"))
    assert len(saved_files) == 1
    saved_path = saved_files[0]
    assert saved_path.read_text(encoding="utf-8") == large_error
    assert result.results[0].tool_result is None
    assert "Tool result exceeded inline limit and was written to file." in result.results[0].error
    assert str(saved_path) in result.results[0].error
    assert f"Bytes: {len(large_error.encode('utf-8'))}" in result.results[0].error
    assert result.results[1].error == "b" * TOOL_RESULT_INLINE_CHAR_LIMIT


async def test_bash_output_above_legacy_limit_is_spilled_without_data_loss(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session")
    await workspace.prepare_workspace()

    async def static_bash_env(*, timeout_seconds: float) -> dict[str, str]:
        assert timeout_seconds > 0
        return workspace.env

    monkeypatch.setattr(workspace.environment, "bash_env", static_bash_env)
    context = AmphiContext(workspace=workspace)
    output_size = 30_050
    ota_context = AmphiOTAContext(user_input="x")
    ota_context.tools = [bash_tool]
    ota_context.think_result = ThinkResult(step_content="", tool_calls=[
        StepToolCall(
            call_id="call_large_bash",
            tool="bash",
            tool_arguments=[
                ToolArgument(name="command", value=f"printf 'x%.0s' $(seq 1 {output_size})"),
                ToolArgument(name="cwd", value=str(tmp_path)),
            ],
        ),
    ])

    token = current_agent.set(SimpleNamespace(ctx=context))
    try:
        result = await AmphiAgent().action_tool_call(ota_context, context)
    finally:
        current_agent.reset(token)

    saved_files = list(workspace.tool_result_dir.glob("*/*.txt"))
    assert len(saved_files) == 1
    saved_output = saved_files[0].read_text(encoding="utf-8")
    assert saved_output == "x" * output_size
    assert "[truncated" not in saved_output
    assert "Tool result exceeded inline limit and was written to file." in result.results[0].tool_result
