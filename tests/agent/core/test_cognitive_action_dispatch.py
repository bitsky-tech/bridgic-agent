import json
from pathlib import Path

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord, StepToolCall, think_unit
from bridgic.amphibious._type import ThinkResult
from bridgic.core.agentic.tool_specs import FunctionToolSpec, ToolSpec

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session
from src.amphi_agent._state import AwaitingFeedback, AwaitingPermission, AwaitingSubAgent, BuildStageState, CallVerdict, RoundPermission
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.build.base import BuildThink
from src.amphi_agent.tools._subagent import run_subagent
from src.amphi_agent.tools._request_human import request_human_choice
from src.amphi_store import SessionRecord
from tests._support.sandbox import IsolatedPaths


def _context(root: Path, session_id: str = "cognitive-actions") -> AmphiContext:
    record = SessionRecord(id=session_id, user_id="local", workspace_root=str(root))
    return AmphiContext(session=Session(record, []), execution_mode="full")


async def test_custom_worker_receives_only_successful_results(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """The result handler processes successful results while failed steps retain their errors."""
    events: list[tuple[str, str]] = []

    class CustomThink(BaseThink):
        async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: AmphiAgent) -> None:
            await super().handle_action_result(ota_context, context, agent)
            for step in ota_context.action_result.results:
                if step.success and step.tool_name == "custom_action":
                    events.append(("handle", step.tool_id))
                    step.tool_result = {"handled": step.tool_result}

    class CustomAgent(AmphiAgent):
        main = think_unit(CustomThink())

    result = ActionResult(results=[
        ActionStepResult(tool_id="allowed", tool_name="custom_action", tool_arguments={}, tool_result="complete"),
        ActionStepResult(tool_id="failed", tool_name="custom_action", tool_arguments={}, tool_result=None, success=False, error="Execution failed."),
    ])

    async def execute_tool_calls(ota_context: AmphiOTAContext, context: AmphiContext) -> ActionResult:
        return result

    agent = CustomAgent()
    monkeypatch.setattr(agent, "_execute_tool_calls", execute_tool_calls)
    context = _context(test_sandbox.sessions / "cognitive-actions")
    ota_context = AmphiOTAContext(ota_record=[OTARecord()])

    ota_context.action_result = await agent.action_tool_call(ota_context, context)
    async for _ in agent.after_action(ota_context, context):
        pass

    assert events == [("handle", "allowed")]
    assert result.results[0].tool_result == {"handled": "complete"}
    assert result.results[1].success is False
    assert result.results[1].error == "Execution failed."
    assert result.results[1].tool_result is None


async def test_action_result_batch_keeps_its_original_worker(test_sandbox: IsolatedPaths) -> None:
    """A state transition cannot hand the remaining results to the next stage's worker."""
    handled: list[str] = []

    class OwnerThink(BaseThink):
        async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: AmphiAgent) -> None:
            await super().handle_action_result(ota_context, context, agent)
            for step in ota_context.action_result.results:
                if step.success and step.tool_name == "custom_action":
                    handled.append(step.tool_id)
                    if step.tool_id == "advance":
                        ota_context.transition_think(BuildStageState(stage="clarify"))
                    step.tool_result = {"owner": "original", "value": step.tool_result}

    class NextThink(BaseThink):
        async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: AmphiAgent) -> None:
            await super().handle_action_result(ota_context, context, agent)
            raise AssertionError("The next stage cannot consume the previous worker's results.")

    class CustomAgent(AmphiAgent):
        main = think_unit(OwnerThink())
        clarify = think_unit(NextThink())

    result = ActionResult(results=[
        ActionStepResult(tool_id="advance", tool_name="custom_action", tool_arguments={}, tool_result="stage ready"),
        ActionStepResult(tool_id="retain", tool_name="custom_action", tool_arguments={}, tool_result="source evidence"),
    ])
    ota_context = AmphiOTAContext(ota_record=[OTARecord(action_result=result)])
    context = _context(test_sandbox.sessions / "cognitive-actions")
    agent = CustomAgent()

    async for _ in agent.after_action(ota_context, context):
        pass

    assert handled == ["advance", "retain"]
    assert ota_context.think_status == BuildStageState(stage="clarify")
    assert isinstance(agent._current_think_worker(ota_context, context), NextThink)
    assert result.results[1].tool_result == {"owner": "original", "value": "source evidence"}


async def test_permission_resume_uses_the_same_worker_result_handler(test_sandbox: IsolatedPaths) -> None:
    """Approved calls use the live execution pipeline and its selected worker's result handler."""
    events: list[tuple[str, BaseThink]] = []
    executions: list[str] = []

    async def custom_action() -> str:
        executions.append("executed")
        return "raw result"

    tool = FunctionToolSpec.from_raw(custom_action)

    class CustomThink(BaseThink):
        def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> list[ToolSpec]:
            return [tool]

        async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: AmphiAgent) -> None:
            await super().handle_action_result(ota_context, context, agent)
            for step in ota_context.action_result.results:
                if step.success and step.tool_name == "custom_action":
                    events.append(("handle", self))
                    step.tool_result = {"handled": step.tool_result}

    class CustomAgent(AmphiAgent):
        main = think_unit(CustomThink())

    agent = CustomAgent()
    context = _context(test_sandbox.sessions / "cognitive-actions")
    call = StepToolCall(call_id="approved-call", tool="custom_action", tool_arguments=[])
    decision = ThinkResult(step_content="Perform the requested action.", tool_calls=[call])
    direct = AmphiOTAContext(
        user_input="Run the custom action.",
        tools=[tool],
        ota_record=[OTARecord(
            think_result=decision,
            permission=RoundPermission(
                execution_mode="full",
                reviewed=True,
                verdicts=[CallVerdict(id=call.call_id, tool=call.tool, arguments={}, verdict="allow")],
            ),
        )],
    )
    worker = agent._current_think_worker(direct, context)
    direct.action_result = await agent.action_tool_call(direct, context)
    async for _ in agent.after_action(direct, context):
        pass
    assert executions == ["executed"]
    assert events == [("handle", worker)]
    assert direct.action_result.results[0].tool_result == {"handled": "raw result"}

    events.clear()
    executions.clear()
    permission = {
        "calls": [call.model_dump()],
        "verdicts": ["ask"],
        "items": [{"call_index": 0, "tool": "custom_action", "arguments": {}}],
        "execution_mode": "full",
    }
    resumed = AmphiOTAContext(user_input={
        "type": "permission_answer",
        "answers": [{"call_index": 0, "decision": "allow"}],
    })
    resumed.transition_interaction(AwaitingPermission(request_id="approval", permission=permission))
    rounds = [OTARecord(think_result=decision).model_dump(mode="json")]

    await agent._resume_permission(resumed, context, permission, rounds, "Run the custom action.")

    assert executions == ["executed"]
    assert events == [("handle", worker)]
    assert resumed.action_result.results[0].success is True
    assert resumed.action_result.results[0].tool_result == direct.action_result.results[0].tool_result
    assert resumed.ota_record[-1].permission.reviewed is True
    assert resumed.interaction_status is None
    assert resumed.user_input == "Run the custom action."


async def test_inherited_result_handlers_finish_before_empty_output_normalization(test_sandbox: IsolatedPaths) -> None:
    """Parent and child business handlers see raw empty results before the Agent fills remaining successes."""
    events: list[tuple[str, object]] = []

    class ParentThink(BaseThink):
        async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: AmphiAgent) -> None:
            await super().handle_action_result(ota_context, context, agent)
            for step in ota_context.action_result.results:
                if step.success and step.tool_name == "parent_action":
                    events.append(("parent", step.tool_result))
                    step.tool_result = {"value": "parent"}

    class ChildThink(ParentThink):
        async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: AmphiAgent) -> None:
            await super().handle_action_result(ota_context, context, agent)
            parent_result = next(
                step.tool_result
                for step in ota_context.action_result.results
                if step.success and step.tool_name == "parent_action"
            )
            for step in ota_context.action_result.results:
                if step.success and step.tool_name == "child_action":
                    events.append(("child", step.tool_result))
                    step.tool_result = {"value": f"{parent_result['value']}:child"}

    class CustomAgent(AmphiAgent):
        main = think_unit(ChildThink())

    result = ActionResult(results=[
        ActionStepResult(tool_id="parent", tool_name="parent_action", tool_arguments={}, tool_result=None),
        ActionStepResult(tool_id="child", tool_name="child_action", tool_arguments={}, tool_result=None),
        ActionStepResult(tool_id="null", tool_name="ordinary_action", tool_arguments={}, tool_result=None),
        ActionStepResult(tool_id="empty", tool_name="ordinary_action", tool_arguments={}, tool_result=""),
        ActionStepResult(tool_id="failed", tool_name="child_action", tool_arguments={}, tool_result=None, success=False, error="Execution failed."),
    ])
    ota_context = AmphiOTAContext(ota_record=[OTARecord(action_result=result)])
    context = _context(test_sandbox.sessions / "cognitive-actions")

    async for _ in CustomAgent().after_action(ota_context, context):
        pass

    assert events == [("parent", None), ("child", None)]
    assert result.results[0].tool_result == {"value": "parent"}
    assert result.results[1].tool_result == {"value": "parent:child"}
    assert [step.tool_result for step in result.results[2:4]] == [
        "(tool completed successfully with no output)",
        "(tool completed successfully with no output)",
    ]
    assert result.results[4].success is False
    assert result.results[4].error == "Execution failed."
    assert result.results[4].tool_result is None


async def test_build_transition_failure_still_normalizes_executed_empty_results(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed Build handoff preserves its exception and finalizes earlier successful empty outputs."""
    signal = {"mode": None, "stage": "explore", "reason": None}
    result = ActionResult(results=[
        ActionStepResult(tool_id="completed", tool_name="bash", tool_arguments={}, tool_result=None),
        ActionStepResult(tool_id="failed", tool_name="bash", tool_arguments={}, tool_result=None, success=False, error="Command failed."),
        ActionStepResult(tool_id="advance", tool_name="switch", tool_arguments={}, tool_result=signal),
    ])
    ota_context = AmphiOTAContext(ota_record=[OTARecord(action_result=result)])
    ota_context.transition_think(BuildStageState(stage="clarify"))
    context = _context(test_sandbox.sessions / "cognitive-actions")
    agent = AmphiAgent()
    failure = OSError("Build workspace could not be synchronized.")

    async def fail_sync(current_ota: AmphiOTAContext, current_context: AmphiContext) -> None:
        assert current_ota is ota_context
        assert current_context is context
        assert current_ota.think_status == BuildStageState(stage="explore")
        assert result.results[0].tool_result is None
        raise failure

    monkeypatch.setattr(BuildThink, "sync_build_space", staticmethod(fail_sync))

    with pytest.raises(OSError) as raised:
        async for _ in agent.after_action(ota_context, context):
            pass

    assert raised.value is failure
    assert result.results[0].success is True
    assert result.results[0].tool_result == "(tool completed successfully with no output)"
    assert result.results[1].success is False
    assert result.results[1].error == "Command failed."
    assert result.results[1].tool_result is None
    assert result.results[2].success is True
    assert result.results[2].tool_result == signal


async def test_specialized_worker_inherits_human_feedback_handling(test_sandbox: IsolatedPaths) -> None:
    """A specialized worker receives common human interaction without duplicating the result loop."""
    class SpecialThink(BaseThink):
        persona = "Clarify the requested outcome."

    class CustomAgent(AmphiAgent):
        clarify = think_unit(SpecialThink())

    request = await request_human_choice(
        json.dumps([{
            "question": "Which audience should this report address?",
            "options": [{"label": "Researchers"}, {"label": "Students"}],
        }]),
        "The report needs an audience before its detail level can be chosen.",
    )
    step = ActionStepResult(
        tool_id="audience-choice",
        tool_name="request_human_choice",
        tool_arguments={},
        tool_result=request,
    )
    ota_context = AmphiOTAContext(ota_record=[OTARecord(action_result=ActionResult(results=[step]))])
    ota_context.transition_think(BuildStageState(stage="clarify"))
    context = _context(test_sandbox.sessions / "cognitive-actions")

    async for _ in CustomAgent().after_action(ota_context, context):
        pass

    interaction = ota_context.interaction_status
    assert isinstance(interaction, AwaitingFeedback)
    assert interaction.questions == request.questions
    assert interaction.prompt == request.prompt
    assert interaction.request_id and interaction.request_id.startswith("human_")
    assert step.tool_result == request.questions
    assert ota_context.think_status == BuildStageState(stage="clarify")
    assert ota_context.subagent_status is None


@pytest.mark.parametrize("worker_mode", [None, "auto"])
async def test_shared_worker_keeps_subagent_batches_local_to_each_round(test_sandbox: IsolatedPaths, worker_mode: str | None) -> None:
    """Shared templates isolate Child reservations and retain the admitting round's permission mode."""
    class SpecialThink(BaseThink):
        permission_mode_override = worker_mode

    class CustomAgent(AmphiAgent):
        clarify = think_unit(SpecialThink())

    async def action_round(calls: list[tuple[str, str, bool]], execution_mode: str | None) -> AmphiOTAContext:
        results = [
            ActionStepResult(
                tool_id=call_id,
                tool_name="run_subagent",
                tool_arguments={"goal": goal},
                tool_result=await run_subagent(goal),
                success=success,
                error=None if success else "Delegation failed.",
            )
            for call_id, goal, success in calls
        ]
        ota_context = AmphiOTAContext(ota_record=[OTARecord(
            action_result=ActionResult(results=results),
            permission=RoundPermission(execution_mode=execution_mode, reviewed=True),
        )])
        ota_context.transition_think(BuildStageState(stage="clarify"))
        return ota_context

    first_agent, second_agent = CustomAgent(), CustomAgent()
    first_context = _context(test_sandbox.sessions / "first-parent", "first-parent")
    second_context = _context(test_sandbox.sessions / "second-parent", "second-parent")
    first = await action_round([
        ("first-a", "Inspect the report's sources.", True),
        ("failed", "Inspect unavailable evidence.", False),
        ("first-b", "Inspect the report's structure.", True),
    ], "request")
    second = await action_round([("second-a", "Inspect the second report.", True)], None)
    assert first_agent._current_think_worker(first, first_context) is second_agent._current_think_worker(second, second_context)

    async for _ in first_agent.after_action(first, first_context):
        pass

    first_batch = first.subagent_status
    assert isinstance(first_batch, AwaitingSubAgent)
    assert [call.tool_call_id for call in first_batch.calls] == ["first-a", "first-b"]
    assert [call.goal for call in first_batch.calls] == [
        "Inspect the report's sources.",
        "Inspect the report's structure.",
    ]
    assert [call.execution_mode for call in first_batch.calls] == ["request", "request"]
    first_snapshot = first_batch.model_dump()
    failed_step = first.action_result.results[1]
    assert failed_step.success is False
    assert failed_step.error == "Delegation failed."
    assert failed_step.tool_result.goal == "Inspect unavailable evidence."

    async for _ in second_agent.after_action(second, second_context):
        pass

    second_batch = second.subagent_status
    assert isinstance(second_batch, AwaitingSubAgent)
    assert [call.tool_call_id for call in second_batch.calls] == ["second-a"]
    assert [call.goal for call in second_batch.calls] == ["Inspect the second report."]
    assert second_batch.calls[0].execution_mode == (worker_mode or "full")
    assert first_batch.model_dump() == first_snapshot
    assert len({call.session_id for call in [*first_batch.calls, *second_batch.calls]}) == 3
    assert first.interaction_status is None
    assert second.interaction_status is None
