"""Verify cognitive workers own permission policy and shared routing validation."""

import pytest
from bridgic.amphibious import StepToolCall, think_unit
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent.cognitive.state import CallVerdict, RoundPermission
from src.amphi_agent.tools import switch_tool
from tests._support.sandbox import IsolatedPaths
from tests.agent.core.test_action_boundary import _call, _context, _invoke, _ota


@pytest.mark.parametrize("stage", ["main", "clarify"])
async def test_current_worker_extends_permissions_after_shared_legality(test_sandbox: IsolatedPaths, stage: str) -> None:
    """The selected template extends the shared policy without admitting hidden or denied calls."""
    events: list[tuple[str, BaseThink, AmphiAgent, list[str]]] = []
    execution_modes: list[str | None] = []
    inherited_verdicts: list[CallVerdict] = []
    executions: list[str] = []

    async def visible_action(value: str) -> str:
        executions.append(value)
        return value

    class CustomThink(BaseThink):
        permission_mode_override = "full"

        async def legality_check(
            self,
            ota_context: AmphiOTAContext,
            context: AmphiContext,
            calls: list[StepToolCall],
            verdicts: list[CallVerdict],
            agent: AmphiAgent,
        ) -> list[CallVerdict]:
            events.append(("legality", self, agent, [call.call_id for call in calls]))
            return await super().legality_check(ota_context, context, calls, verdicts, agent)

        async def permission_check(
            self,
            ota_context: AmphiOTAContext,
            context: AmphiContext,
            calls: list[StepToolCall],
            agent: AmphiAgent,
            *,
            execution_mode: str | None = None,
            additional_mount_roots: list[str] | None = None,
        ) -> list[CallVerdict]:
            events.append(("permission", self, agent, [call.call_id for call in calls]))
            execution_modes.append(execution_mode)
            verdicts = await super().permission_check(
                ota_context,
                context,
                calls,
                agent,
                execution_mode=execution_mode,
                additional_mount_roots=additional_mount_roots,
            )
            inherited_verdicts.extend(verdicts)
            return [
                verdict.model_copy(update={"verdict": "deny", "reason": "Denied by the custom stage."})
                if verdict.id == "deny-visible" else verdict
                for verdict in verdicts
            ]

    class CustomAgent(AmphiAgent):
        main = think_unit(CustomThink())
        clarify = think_unit(CustomThink())

    calls = [
        _call("hidden", "hidden_action", value="hidden"),
        _call("allow-visible", "visible_action", value="allowed"),
        _call("deny-visible", "visible_action", value="denied"),
    ]
    ota_context = _ota(calls, [FunctionToolSpec.from_raw(visible_action)])
    ota_context.ota_record[-1].permission = RoundPermission(reviewed=False)
    ota_context.transition_think(NormalStageState() if stage == "main" else BuildStageState(stage=stage))
    context = _context(test_sandbox.sessions / f"policy-dispatch-{stage}")
    context.execution_mode = "request"
    agent = CustomAgent()
    worker = getattr(agent, stage)._worker_template

    admitted = await _invoke(agent.before_action(ota_context, context))

    assert events == [
        ("legality", worker, agent, [call.call_id for call in calls]),
        ("permission", worker, agent, ["allow-visible", "deny-visible"]),
    ]
    assert execution_modes == ["full"]
    assert [verdict.id for verdict in inherited_verdicts] == ["allow-visible", "deny-visible"]
    assert [verdict.arguments for verdict in inherited_verdicts] == [{"value": "allowed"}, {"value": "denied"}]
    assert [verdict.verdict for verdict in inherited_verdicts] == ["allow", "allow"]
    assert admitted.tool_calls == [calls[1]]
    gate = ota_context.ota_record[-1].permission
    assert gate.execution_mode == "full"
    assert gate.reviewed is False
    assert [verdict.id for verdict in gate.verdicts] == [call.call_id for call in calls]
    assert [verdict.verdict for verdict in gate.verdicts] == ["deny", "allow", "deny"]
    assert "not available" in gate.verdicts[0].reason
    assert gate.verdicts[2].reason == "Denied by the custom stage."
    assert ota_context.interaction_status is None

    ota_context.think_result = admitted
    result = await agent.action_tool_call(ota_context, context)

    assert executions == ["allowed"]
    results = {step.tool_id: step for step in result.results}
    assert set(results) == {call.call_id for call in calls}
    assert results["allow-visible"].success is True
    assert results["allow-visible"].tool_result == "allowed"
    assert results["hidden"].success is False
    assert "not available" in results["hidden"].error
    assert results["deny-visible"].success is False
    assert results["deny-visible"].error == "Denied by the custom stage."


@pytest.mark.parametrize(("case", "target"), [
    ("registered", "generate"),
    ("unknown", "unregistered-stage"),
    ("different-mode", "ppt_plan"),
    ("removed-from-instance", "generate"),
    ("missing-descriptor", "generate"),
])
async def test_shared_switch_validation_uses_the_active_agent_registry(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch, case: str, target: str) -> None:
    """Base policy admits only targets registered and bound on the current Agent."""
    class CustomAgent(AmphiAgent):
        clarify = think_unit(BaseThink())

    agent = CustomAgent()
    sibling = CustomAgent()
    if case == "removed-from-instance":
        agent.thinking_modes["build"] = tuple(stage for stage in agent.thinking_modes["build"] if stage != target)
        assert target in sibling.thinking_modes["build"]
    elif case == "missing-descriptor":
        monkeypatch.setattr(CustomAgent, target, None)

    call = _call("switch-target", "switch", stage=target, reason="Continue the staged task.")
    ota_context = _ota([call], [switch_tool])
    ota_context.transition_think(BuildStageState(stage="clarify"))
    context = _context(test_sandbox.sessions / f"switch-policy-{case}")
    worker = agent._current_think_worker(ota_context, context)
    verdicts = ota_context.ota_record[-1].permission.verdicts

    resolved = await worker.legality_check(ota_context, context, [call], verdicts, agent)
    admitted = await _invoke(agent.before_action(ota_context, context))

    expected = "allow" if case == "registered" else "deny"
    assert [verdict.verdict for verdict in resolved] == [expected]
    assert [verdict.model_dump() for verdict in ota_context.ota_record[-1].permission.verdicts] == [
        verdict.model_dump() for verdict in resolved
    ]
    assert admitted.tool_calls == ([call] if case == "registered" else [])
    if case != "registered":
        assert f"target stage `{target}` is not registered for mode `build`" in resolved[0].reason

    if case == "removed-from-instance":
        sibling_ota = _ota([call], [switch_tool])
        sibling_ota.transition_think(BuildStageState(stage="clarify"))
        sibling_admitted = await _invoke(sibling.before_action(sibling_ota, context))
        assert sibling_admitted.tool_calls == [call]
