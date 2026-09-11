"""Verify ThinkUnit results reach cognitive policy without changing loop boundaries."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from bridgic.amphibious import OTARecord, RETURN, ThinkUnit, think_unit

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive.normal.main import MainThink
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent.cognitive.state import AwaitingFeedback, AwaitingSubAgent, InStage, SubAgentCall, ThinkUnitOutcome
from src.amphi_agent.cognitive.workflow.base import WorkflowRunThink
from src.amphi_agent.cognitive.workflow.state import WorkflowStageState
from tests.agent.core.test_orchestration import _Harness, orchestration as orchestration_fixture


orchestration = orchestration_fixture


async def test_current_worker_handles_its_unit_result(orchestration: _Harness) -> None:
    """A custom worker can finish its unit through the same descriptor used for routing."""
    calls: list[tuple[BaseThink, InStage, str | None, AmphiAgent]] = []

    class CustomThink(BaseThink):
        async def handle_think_unit_result(
            self,
            ota_context: AmphiOTAContext,
            context: AmphiContext,
            previous_status: InStage,
            result: str | None,
            agent: AmphiAgent,
        ) -> ThinkUnitOutcome:
            await super().handle_think_unit_result(ota_context, context, previous_status, result, agent)
            calls.append((self, previous_status, result, agent))
            return ThinkUnitOutcome(finished=True)

    class CustomAgent(AmphiAgent):
        main = think_unit(CustomThink())

    agent = CustomAgent()
    ota_context = AmphiOTAContext(ota_record=[OTARecord()], stream=SimpleNamespace(publish=lambda *_args, **_kwargs: None))
    flow = agent.on_agent(ota_context, orchestration.context)
    try:
        unit = await anext(flow)
        assert isinstance(unit, ThinkUnit)
        assert unit.name == "main"
        assert calls == []

        returned = await flow.asend("Custom stage completed.")

        assert isinstance(returned, RETURN)
        assert returned.value == "Custom stage completed."
        assert calls == [(agent.main._worker_template, NormalStageState(), returned.value, agent)]
    finally:
        await flow.aclose()


async def test_state_change_dispatches_target_before_accepting_an_answer(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Returning to Main on the last slot still runs Main and ignores the source stage's answer."""
    events: list[tuple[str, InStage]] = []
    calls: list[tuple[BaseThink, InStage, str | None, ThinkUnitOutcome]] = []

    class SourceThink(BaseThink):
        async def handle_think_unit_result(
            self,
            ota_context: AmphiOTAContext,
            context: AmphiContext,
            previous_status: InStage,
            result: str | None,
            agent: AmphiAgent,
        ) -> ThinkUnitOutcome:
            raise AssertionError("The source stage must not handle a transition to Main.")

    class TargetThink(MainThink):
        async def handle_think_unit_result(
            self,
            ota_context: AmphiOTAContext,
            context: AmphiContext,
            previous_status: InStage,
            result: str | None,
            agent: AmphiAgent,
        ) -> ThinkUnitOutcome:
            outcome = await super().handle_think_unit_result(ota_context, context, previous_status, result, agent)
            events.append(("handle", ota_context.think_status))
            calls.append((self, previous_status, result, outcome))
            return outcome

    class CustomAgent(AmphiAgent):
        main = think_unit(TargetThink())
        clarify = think_unit(SourceThink())

    agent = CustomAgent()
    monkeypatch.setattr("src.amphi_agent._agent.MAX_THINK_UNITS_PER_TURN", 1)
    monkeypatch.setattr(agent, "_publish_stage", lambda _ota, status: events.append(("publish", status)))
    source_status = BuildStageState(stage="clarify")
    ota_context = AmphiOTAContext(ota_record=[OTARecord()], stream=SimpleNamespace(publish=lambda *_args, **_kwargs: None))
    ota_context.transition_think(source_status)
    flow = agent.on_agent(ota_context, orchestration.context)
    try:
        assert (await anext(flow)).name == "clarify"
        ota_context.transition_think(NormalStageState())

        next_unit = await flow.asend("The source stage's final text.")

        assert isinstance(next_unit, ThinkUnit)
        assert next_unit.name == "main"
        assert events == [
            ("publish", source_status),
            ("publish", NormalStageState()),
            ("handle", NormalStageState()),
        ]
        worker, previous_status, result, outcome = calls[0]
        assert worker is agent.main._worker_template
        assert previous_status == source_status
        assert result == "The source stage's final text."
        assert outcome.finished is False
        assert outcome.minimum_budget == 1

        returned = await flow.asend("Main's user-visible answer.")

        assert isinstance(returned, RETURN)
        assert returned.value == "Main's user-visible answer."
        assert calls[1][0] is worker
        assert calls[1][1] == NormalStageState()
        assert calls[1][3].finished is True
    finally:
        await flow.aclose()


@pytest.mark.parametrize("parked_kind", ["interaction", "subagents"])
async def test_parked_unit_skips_result_policy(orchestration: _Harness, parked_kind: str) -> None:
    """A parked ThinkUnit returns its pending work before consulting the result handler."""
    class CustomThink(BaseThink):
        async def handle_think_unit_result(
            self,
            ota_context: AmphiOTAContext,
            context: AmphiContext,
            previous_status: InStage,
            result: str | None,
            agent: AmphiAgent,
        ) -> ThinkUnitOutcome:
            raise AssertionError("Parked work must bypass ThinkUnit result policy.")

    class CustomAgent(AmphiAgent):
        main = think_unit(CustomThink())

    ota_context = AmphiOTAContext(ota_record=[OTARecord()], stream=SimpleNamespace(publish=lambda *_args, **_kwargs: None))
    flow = CustomAgent().on_agent(ota_context, orchestration.context)
    try:
        assert (await anext(flow)).name == "main"
        if parked_kind == "interaction":
            pending = AwaitingFeedback(request_id="unit-feedback", questions=[{"question": "Continue?"}])
            ota_context.transition_interaction(pending)
        else:
            pending = AwaitingSubAgent(calls=[SubAgentCall(
                tool_call_id="unit-child", goal="Inspect the source", session_id="unit-child-session",
            )])
            ota_context.transition_subagents(pending)

        returned = await flow.asend("This text must not finish the parked turn.")

        assert isinstance(returned, RETURN)
        assert returned.value is pending
    finally:
        await flow.aclose()


@pytest.mark.parametrize("entering", [False, True], ids=["already-running", "enter-from-main"])
async def test_workflow_budget_expands_only_on_entry(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch, entering: bool) -> None:
    """Workflow cursor changes publish progress without replenishing the unit budget."""
    remaining_requests: list[WorkflowStageState] = []
    progress: list[tuple[int, str]] = []

    def remaining_units(status: WorkflowStageState, context: AmphiContext) -> int:
        remaining_requests.append(status)
        return 2

    def publish_progress(ota_context: AmphiOTAContext, context: AmphiContext, status: WorkflowStageState, value: str) -> None:
        progress.append((status.step_index, value))

    monkeypatch.setattr("src.amphi_agent._agent.MAX_THINK_UNITS_PER_TURN", 1)
    monkeypatch.setattr(WorkflowRunThink, "_workflow_remaining_units", staticmethod(remaining_units))
    monkeypatch.setattr(WorkflowRunThink, "_publish_workflow_progress", staticmethod(publish_progress))
    agent = orchestration.agent
    initialize = AsyncMock()
    monkeypatch.setattr(agent, "init_state", initialize)
    initial_workflow = WorkflowStageState(workflow_id="unit-workflow", generation="unit-generation")
    ota_context = AmphiOTAContext(ota_record=[OTARecord()], stream=SimpleNamespace(publish=lambda *_args, **_kwargs: None))
    if not entering:
        ota_context.transition_think(initial_workflow)
    flow = agent.on_agent(ota_context, orchestration.context)
    try:
        unit = await anext(flow)
        assert unit.name == ("main" if entering else "execute")
        if entering:
            ota_context.transition_think(initial_workflow)
            assert unit.until(ota_context) is True
            unit = await flow.asend("Start the saved Workflow.")
            assert isinstance(unit, ThinkUnit)
            assert unit.name == "execute"

        count = 3 if entering else 1
        for step_index in range(1, count + 1):
            assert unit.until(ota_context) is False
            ota_context.transition_think(initial_workflow.model_copy(update={"step_index": step_index}))
            assert unit.until(ota_context) is True
            text = f"Workflow section {step_index} completed."
            unit = await flow.asend(text)
            if step_index < count:
                assert isinstance(unit, ThinkUnit)
                assert unit.name == "execute"

        assert isinstance(unit, RETURN)
        assert unit.value == text
        assert isinstance(ota_context.think_status, WorkflowStageState)
        assert ota_context.think_status.step_index == count
        assert remaining_requests == ([initial_workflow] if entering else [])
        assert progress == [(step_index, "running") for step_index in range(count + 1)]
        initialize.assert_awaited_once_with(ota_context, orchestration.context)
    finally:
        await flow.aclose()
