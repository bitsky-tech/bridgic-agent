"""Verify registered workers own initialization across fresh and resumed Turns."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord, StepToolCall, ThinkUnitDescriptor
from bridgic.amphibious._type import ThinkResult
from bridgic.core.agentic.tool_specs import FunctionToolSpec, ToolSpec

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session
from src.amphi_agent.cognitive.state import AwaitingFeedback, AwaitingPermission
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive import register as registration
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.register import cognitive_stage
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    existing_names = set(vars(AmphiAgent))
    monkeypatch.setattr(registration, "_registry", dict(registration._registry))
    yield
    for name, value in list(vars(AmphiAgent).items()):
        if name not in existing_names and isinstance(value, ThinkUnitDescriptor):
            delattr(AmphiAgent, name)


def _context(root: Path, turns: list[SessionTurnRecord]) -> AmphiContext:
    record = SessionRecord(id="cognitive-init", user_id="local", workspace_root=str(root))
    return AmphiContext(session=Session(record, turns), execution_mode="full")


def _turn(ota_context: AmphiOTAContext, status: TurnStatus, turn_id: str = "pending-turn") -> SessionTurnRecord:
    return SessionTurnRecord(
        id=turn_id,
        user_id="local",
        session_id="cognitive-init",
        session_ordinal=0,
        user_input=UserInput.from_runtime(ota_context.user_input),
        ota_records=[record.model_dump(mode="json") for record in ota_context.ota_record],
        agent_state=ota_context.state.model_dump(mode="json"),
        browser_tool_loaded=ota_context.browser_tool_loaded,
        workspace_tools_loaded=ota_context.workspace_tools_loaded,
        skills_tool_loaded=ota_context.skills_tool_loaded,
        context_usage=ota_context.context_usage.model_dump(mode="json"),
        status=status,
    )


@pytest.mark.parametrize("status", [None, TurnStatus.COMPLETED, TurnStatus.CANCELLED, TurnStatus.FAILED])
async def test_registered_stage_initializes_new_turn_and_terminal_cursor(test_sandbox: IsolatedPaths, registry, status: TurnStatus | None) -> None:
    """A registered stage can initialize itself without an Agent-specific resume branch."""
    initialized: list[SessionTurnRecord | None] = []

    @cognitive_stage(mode="build", stage="custom_init", order=100)
    class CustomThink(BaseThink):
        async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: SessionTurnRecord | None, agent: AmphiAgent) -> None:
            await super().init_state(ota_context, context, previous_turn, agent)
            assert ota_context.think_status == BuildStageState(stage="custom_init")
            assert ota_context.context_usage.input_tokens == 0
            assert ota_context.context_usage.output_tokens == 0
            initialized.append(previous_turn)
            ota_context.selected_skill_dirs = ["custom-stage-capability"]

    saved = AmphiOTAContext(user_input="Complete the staged task.")
    saved.transition_think(BuildStageState(stage="custom_init"))
    saved.context_usage.input_tokens = 120
    saved.context_usage.output_tokens = 40
    previous_turn = _turn(saved, status) if status is not None else None
    context = _context(test_sandbox.sessions / "cognitive-init", [previous_turn] if previous_turn else [])
    incoming = AmphiOTAContext(user_input="Continue with the next task.")
    if previous_turn is None:
        incoming.transition_think(BuildStageState(stage="custom_init"))

    agent = AmphiAgent()
    await agent.init_state(incoming, context)

    assert initialized == [previous_turn]
    assert initialized[0] is previous_turn
    assert incoming.selected_skill_dirs == ["custom-stage-capability"]
    assert incoming.user_input == "Continue with the next task."
    assert incoming.ota_record == []
    assert context.session.get_all() == ([previous_turn] if previous_turn else [])
    assert isinstance(agent._current_think_worker(incoming, context), CustomThink)


async def test_inherited_init_keeps_previous_turn_after_shared_feedback_resume(test_sandbox: IsolatedPaths, registry) -> None:
    """Consuming the pending Session tail cannot change the Turn seen by a child initializer."""
    initialized: list[tuple[str, SessionTurnRecord | None]] = []

    class ParentThink(BaseThink):
        async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: SessionTurnRecord | None, agent: AmphiAgent) -> None:
            await super().init_state(ota_context, context, previous_turn, agent)
            initialized.append(("parent", previous_turn))

    @cognitive_stage(mode="build", stage="custom_feedback", order=100)
    class ChildThink(ParentThink):
        async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: SessionTurnRecord | None, agent: AmphiAgent) -> None:
            await super().init_state(ota_context, context, previous_turn, agent)
            initialized.append(("child", previous_turn))
            assert context.session.get_all()[-1].id == "earlier-turn"
            assert previous_turn.id == "pending-turn"

    questions = [{
        "question": "Who will read this report?",
        "options": [{"id": "researchers", "label": "Researchers"}],
    }]
    saved = AmphiOTAContext(
        user_input="Write the requested report.",
        ota_record=[OTARecord(action_result=ActionResult(results=[ActionStepResult(
            tool_id="audience-question",
            tool_name="request_human_choice",
            tool_arguments={},
            tool_result=questions,
        )]))],
    )
    saved.transition_think(BuildStageState(stage="custom_feedback"))
    saved.transition_interaction(AwaitingFeedback(request_id="audience", questions=questions))
    previous_turn = _turn(saved, TurnStatus.AWAITING_HUMAN)
    earlier_turn = _turn(AmphiOTAContext(user_input="An earlier task."), TurnStatus.COMPLETED, "earlier-turn")
    context = _context(test_sandbox.sessions / "cognitive-init", [earlier_turn, previous_turn])
    incoming = AmphiOTAContext(user_input={
        "type": "choice_answer",
        "request_id": "audience",
        "answers": [{"index": 0, "option_id": "researchers"}],
    })

    await AmphiAgent().init_state(incoming, context)

    assert initialized == [("parent", previous_turn), ("child", previous_turn)]
    assert all(turn is previous_turn for _, turn in initialized)
    assert context.session.get_all() == [earlier_turn]
    assert UserInput.from_runtime(incoming.user_input) == previous_turn.user_input
    assert incoming.interaction_status is None
    assert incoming.ota_record[-1].action_result["results"][0]["tool_result"] == "Who will read this report?: Researchers"
    assert previous_turn.ota_records[-1]["action_result"]["results"][0]["tool_result"] == questions


async def test_permission_replay_initializes_capabilities_before_execution(test_sandbox: IsolatedPaths, registry) -> None:
    """An approval replay restores stage resources before selecting and executing its tools."""
    events: list[tuple[str, BaseThink | None]] = []

    async def custom_resume_action() -> str:
        events.append(("execute", None))
        return "restored capability used"

    tool = FunctionToolSpec.from_raw(custom_resume_action)

    @cognitive_stage(mode="build", stage="custom_approval", order=100)
    class CustomThink(BaseThink):
        async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: SessionTurnRecord | None, agent: AmphiAgent) -> None:
            await super().init_state(ota_context, context, previous_turn, agent)
            assert previous_turn is pending
            assert context.session.get_all()[-1] is pending
            assert ota_context.browser_tool_loaded is True
            assert ota_context.skills_tool_loaded is True
            assert ota_context.context_usage.input_tokens == 120
            assert ota_context.context_usage.output_tokens == 40
            events.append(("init", self))
            ota_context.workspace_tools_loaded = True

        def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> list[ToolSpec]:
            return [tool] if ota_context.workspace_tools_loaded else []

        async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: AmphiAgent) -> None:
            await super().handle_action_result(ota_context, context, agent)
            for step in ota_context.action_result.results:
                if step.success and step.tool_name == "custom_resume_action":
                    events.append(("handle", self))
                    step.tool_result = {"handled": step.tool_result}

    call = StepToolCall(call_id="approved-call", tool="custom_resume_action", tool_arguments=[])
    saved = AmphiOTAContext(
        user_input="Perform the staged action.",
        browser_tool_loaded=True,
        skills_tool_loaded=True,
        ota_record=[OTARecord(think_result=ThinkResult(step_content="Perform the action.", tool_calls=[call]))],
    )
    saved.transition_think(BuildStageState(stage="custom_approval"))
    saved.transition_interaction(AwaitingPermission(request_id="approval", permission={
        "calls": [call.model_dump()],
        "verdicts": ["ask"],
        "items": [{"call_index": 0, "tool": "custom_resume_action", "arguments": {}}],
        "execution_mode": "full",
    }))
    saved.context_usage.input_tokens = 120
    saved.context_usage.output_tokens = 40
    pending = _turn(saved, TurnStatus.AWAITING_PERMISSION)
    context = _context(test_sandbox.sessions / "cognitive-init", [pending])
    incoming = AmphiOTAContext(user_input={
        "type": "permission_answer",
        "request_id": "approval",
        "answers": [{"call_index": 0, "decision": "allow"}],
    })
    agent = AmphiAgent()

    await agent.init_state(incoming, context)

    worker = agent._current_think_worker(incoming, context)
    assert events == [("init", worker), ("execute", None), ("handle", worker)]
    assert incoming.action_result.results[0].success is True
    assert incoming.action_result.results[0].tool_result == {"handled": "restored capability used"}
    assert incoming.interaction_status is None
    assert incoming.ota_record[-1].permission.reviewed is True
    assert UserInput.from_runtime(incoming.user_input) == pending.user_input
    assert context.session.get_all() == []
