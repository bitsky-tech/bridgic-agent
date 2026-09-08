"""Verify Agent-owned stage binding, dispatch, and instance configuration."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from bridgic.amphibious import AmphibiousAutoma, Context, OTAContext, RETURN, ThinkUnit, ThinkUnitDescriptor, think_unit
from bridgic.core.model.types import Message, Role

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session, cognitive
from src.amphi_agent._state import NormalStageState
from src.amphi_agent.cognitive import get_cognitive_stages
from src.amphi_agent.cognitive import register as registration
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.register import cognitive_stage
from src.amphi_service.protocol.llms._streaming import StreamResult
from tests.agent.cognitive._harness import legality_reason, tool_call


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch):
    registry = {}
    existing_names = set(vars(AmphiAgent))
    monkeypatch.setattr(registration, "_registry", registry)
    yield registry
    for name, value in list(vars(AmphiAgent).items()):
        if name not in existing_names and isinstance(value, ThinkUnitDescriptor):
            delattr(AmphiAgent, name)


def test_existing_workers_keep_their_bindings_and_mode_order() -> None:
    agent = AmphiAgent(max_rounds=7)
    expected = {
        "main": cognitive.MainThink,
        "subagent": cognitive.SubAgentThink,
        "clarify": cognitive.ClarifyThink,
        "explore": cognitive.ExploreThink,
        "generate": cognitive.GenerateThink,
        "verify": cognitive.VerifyThink,
        "ppt_brief": cognitive.PresentationBriefThink,
        "ppt_plan": cognitive.PresentationPlanThink,
        "ppt_compose": cognitive.PresentationComposeThink,
        "ppt_review": cognitive.PresentationReviewThink,
        "execute": cognitive.WorkflowThink,
    }
    units = {name: value for name, value in vars(AmphiAgent).items() if isinstance(value, ThinkUnitDescriptor)}
    assert list(units) == [stage.stage for stage in get_cognitive_stages()]
    for name, worker_type in expected.items():
        assert type(units[name]._worker_template) is worker_type
        assert units[name]._max_attempts == 200
    expected_modes = {
        "build": ("clarify", "explore", "generate", "verify"),
        "normal": ("main", "subagent"),
        "presentation": ("ppt_brief", "ppt_plan", "ppt_compose", "ppt_review"),
        "run_workflow": ("execute",),
    }
    assert agent._max_rounds == 7
    assert agent.thinking_modes == expected_modes
    agent.thinking_modes["build"] = ()
    assert AmphiAgent().thinking_modes == expected_modes


def test_normal_workers_register_and_reuse_their_templates() -> None:
    normal = [stage for stage in get_cognitive_stages() if stage.mode == "normal"]
    assert [(stage.stage, stage.order, stage.worker_class) for stage in normal] == [
        ("main", 10, cognitive.MainThink),
        ("subagent", 20, cognitive.SubAgentThink),
    ]
    first = AmphiAgent(max_rounds=7)
    second = AmphiAgent(max_rounds=11)
    for name in ("main", "subagent"):
        assert getattr(first, name) is getattr(second, name)
        assert getattr(first, name)._worker_template is getattr(second, name)._worker_template
    assert (first._max_rounds, second._max_rounds) == (7, 11)


def test_normal_registration_preserves_explicit_subclass_overrides() -> None:
    class MainOverride(cognitive.MainThink):
        pass

    class SubAgentOverride(cognitive.SubAgentThink):
        pass

    class CustomAgent(AmphiAgent):
        main = think_unit(MainOverride(), max_attempts=3)
        subagent = think_unit(SubAgentOverride(), max_attempts=5)

    child = CustomAgent()
    parent = AmphiAgent()
    assert type(child.main._worker_template) is MainOverride
    assert type(child.subagent._worker_template) is SubAgentOverride
    assert type(parent.main._worker_template) is cognitive.MainThink
    assert type(parent.subagent._worker_template) is cognitive.SubAgentThink
    assert child.main._max_attempts == 3
    assert child.subagent._max_attempts == 5


@pytest.mark.parametrize("is_child", [False, True])
async def test_registered_normal_workers_keep_session_routing_and_prompts(is_child: bool) -> None:
    session = Session()
    if is_child:
        session.parent_session_id = "parent-session"
    context = AmphiContext(session=session)
    ota_context = AmphiOTAContext(user_input="Describe the available capabilities.")
    agent = AmphiAgent()
    unit_name = "subagent" if is_child else "main"
    worker = agent._current_think_worker(ota_context, context)
    assert agent._current_think_unit_name(ota_context, context) == unit_name
    assert worker is getattr(agent, unit_name)._worker_template
    assert ota_context.think_status == NormalStageState()

    messages = await worker.assemble_messages(ota_context, context)
    names = {tool.tool_name for tool in ota_context.tools}
    assert {"read_file", "request_human_choice", "web_search"} <= names
    assert "switch" not in names
    if is_child:
        assert not {"request_build", "request_presentation", "run_subagent", "start_subagent"} & names
        assert worker.persona == cognitive.SubAgentThink.persona
        assert "This Session is a Child Agent" in messages[0].content
    else:
        assert {"request_build", "request_presentation", "run_subagent", "start_subagent"} <= names
        assert worker.persona == cognitive.MainThink.persona
        assert "a general-purpose agent" in messages[0].content
    assert messages[0].role == Role.SYSTEM
    assert messages[-1].role == Role.USER
    assert "Describe the available capabilities." in messages[-1].content


def test_registry_only_provides_ordered_definitions(registry) -> None:
    calls = []

    class FirstThink(BaseThink):
        def __init__(self):
            calls.append("created")
            super().__init__()

    cognitive_stage(mode="demo", stage="second", order=20)(BaseThink)
    cognitive_stage(mode="demo", stage="tied", order=10)(BaseThink)
    assert cognitive_stage(mode="demo", stage="first", order=10)(FirstThink) is FirstThink
    stages = get_cognitive_stages()
    assert [stage.stage for stage in stages] == ["first", "tied", "second"]
    assert stages[0].worker_class is FirstThink
    assert calls == []
    assert not hasattr(AmphiAgent, "first")

    agent = AmphiAgent()
    assert calls == ["created"]
    assert agent.thinking_modes == {"demo": ("first", "tied", "second")}
    assert type(AmphiAgent.first._worker_template) is FirstThink


def test_agent_instances_own_separate_writable_modes(registry) -> None:
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(BaseThink)
    first = AmphiAgent()
    second = AmphiAgent()
    assert vars(first)["thinking_modes"] is first.thinking_modes
    first.thinking_modes["demo"] = ()
    assert second.thinking_modes == {"demo": ("custom_stage",)}
    first.thinking_modes = {"local": ("stage",)}
    assert first.thinking_modes == {"local": ("stage",)}
    assert second.thinking_modes == {"demo": ("custom_stage",)}


def test_duplicate_stage_name_does_not_replace_the_first_worker(registry) -> None:
    class FirstThink(BaseThink):
        pass

    cognitive_stage(mode="demo", stage="first", order=10)(FirstThink)
    with pytest.raises(ValueError, match="already registered"):
        cognitive_stage(mode="another_mode", stage="first", order=20)(BaseThink)
    agent = AmphiAgent()
    assert agent.thinking_modes == {"demo": ("first",)}
    assert type(AmphiAgent.first._worker_template) is FirstThink


@pytest.mark.parametrize("name", ["on_agent", "thinking_modes", "name"])
def test_existing_attributes_are_not_overwritten(registry, name: str) -> None:
    cognitive_stage(mode="demo", stage="first", order=10)(BaseThink)
    cognitive_stage(mode="demo", stage=name, order=20)(BaseThink)
    with pytest.raises(ValueError, match="overwrite an Agent attribute"):
        AmphiAgent()
    assert not hasattr(AmphiAgent, "first")


def test_subclass_cannot_mask_a_base_attribute_collision(registry, monkeypatch: pytest.MonkeyPatch) -> None:
    existing = object()
    monkeypatch.setattr(AmphiAgent, "custom_stage", existing, raising=False)
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(BaseThink)

    class ChildAgent(AmphiAgent):
        custom_stage = think_unit(BaseThink())

    with pytest.raises(ValueError, match="overwrite an Agent attribute"):
        ChildAgent()
    assert AmphiAgent.custom_stage is existing


def test_constructor_failure_does_not_partially_bind_stages(registry) -> None:
    class BrokenThink(BaseThink):
        def __init__(self):
            raise RuntimeError("broken worker constructor")

    cognitive_stage(mode="demo", stage="first", order=10)(BaseThink)
    cognitive_stage(mode="demo", stage="broken", order=20)(BrokenThink)
    with pytest.raises(RuntimeError, match="broken worker constructor"):
        AmphiAgent()
    assert not hasattr(AmphiAgent, "first")
    assert not hasattr(AmphiAgent, "broken")


def test_later_instances_reuse_worker_templates(registry) -> None:
    calls = []

    @cognitive_stage(mode="demo", stage="custom_stage", order=10)
    class CustomThink(BaseThink):
        def __init__(self):
            calls.append("created")
            super().__init__()

    first = AmphiAgent(max_rounds=7)
    descriptor = first.custom_stage
    second = AmphiAgent(max_rounds=11)
    assert calls == ["created"]
    assert second.custom_stage is descriptor
    assert (first._max_rounds, second._max_rounds) == (7, 11)
    assert descriptor._max_attempts == 200


def test_subclass_created_first_inherits_shared_templates(registry) -> None:
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(BaseThink)

    class ChildAgent(AmphiAgent):
        pass

    child = ChildAgent()
    parent = AmphiAgent()
    assert "custom_stage" not in vars(ChildAgent)
    assert child.custom_stage is parent.custom_stage
    assert ChildAgent._ota_context_class is AmphiAgent._ota_context_class
    assert ChildAgent._context_class is AmphiAgent._context_class
    child.thinking_modes["demo"] = ()
    assert parent.thinking_modes == {"demo": ("custom_stage",)}


def test_explicit_subclass_worker_override_is_preserved(registry) -> None:
    class OverrideThink(BaseThink):
        pass

    cognitive_stage(mode="demo", stage="custom_stage", order=10)(BaseThink)

    class ChildAgent(AmphiAgent):
        custom_stage = think_unit(OverrideThink(), max_attempts=3)

    child = ChildAgent()
    parent = AmphiAgent()
    assert type(child.custom_stage._worker_template) is OverrideThink
    assert type(parent.custom_stage._worker_template) is BaseThink
    assert child.custom_stage._max_attempts == 3


async def test_agent_owned_descriptors_run_with_fresh_workers(registry) -> None:
    @cognitive_stage(mode="custom", stage="custom_stage", order=10)
    class CustomThink(BaseThink):
        async def thinking(self, ota_context, context):
            self.calls = getattr(self, "calls", 0) + 1
            return str(self.calls)

    agent = AmphiAgent()

    class RuntimeProbe(AmphibiousAutoma[OTAContext, Context]):
        custom_stage = agent.custom_stage

        async def on_agent(self, ota_context, context):
            first = yield ThinkUnit("custom_stage")
            second = yield ThinkUnit("custom_stage")
            yield RETURN(first + second)

    assert await RuntimeProbe().arun(llm=object(), user_input="run") == "11"
    assert not hasattr(agent.custom_stage._worker_template, "calls")


async def test_registered_base_worker_runs_shared_thinking_without_main_policy(registry) -> None:
    @cognitive_stage(mode="custom", stage="custom_stage", order=10)
    class CustomThink(BaseThink):
        async def assemble_messages(self, ota_context: AmphiOTAContext, context: AmphiContext) -> list[Message]:
            ota_context.tools = self.select_tools(ota_context, context)
            return [
                Message.from_text("Follow the custom workflow.", role=Role.SYSTEM),
                await self.current_user_message(ota_context, context),
            ]

    agent = AmphiAgent()
    ota_context = AmphiOTAContext(user_input="Run the custom workflow")
    context = AmphiContext()
    call = tool_call("edit_workflow", workflow_id="missing-workflow")
    assert await legality_reason(CustomThink(), call, ota_context, context) is None
    assert await legality_reason(cognitive.MainThink(), call, ota_context, context) is not None
    llm = SimpleNamespace(stream_turn=AsyncMock(return_value=StreamResult(
        tool_calls=[],
        content="Custom workflow completed",
        usage=SimpleNamespace(input_tokens=13, output_tokens=4),
    )))

    class RuntimeProbe(AmphibiousAutoma[AmphiOTAContext, AmphiContext]):
        custom_stage = agent.custom_stage

        async def on_agent(self, ota_context, context):
            result = yield ThinkUnit("custom_stage")
            yield RETURN(result)

    result = await RuntimeProbe().arun(llm=llm, ota_context=ota_context, context=context)

    assert result == "Custom workflow completed"
    llm.stream_turn.assert_awaited_once()
    messages, tools = llm.stream_turn.call_args.args
    assert messages[0].content == "Follow the custom workflow."
    assert tools is None
    assert ota_context.context_usage.input_tokens == 13
    assert ota_context.context_usage.output_tokens == 4


async def test_on_agent_round_limit_overrides_descriptor_default_per_instance(registry, monkeypatch: pytest.MonkeyPatch) -> None:
    cognitive_stage(mode="custom", stage="custom_stage", order=10)(BaseThink)
    agents = [AmphiAgent(max_rounds=7), AmphiAgent(max_rounds=11)]
    body = AsyncMock(return_value="done")
    monkeypatch.setattr(AmphiAgent, "init_state", AsyncMock())
    monkeypatch.setattr(AmphiAgent, "_current_think_unit_name", lambda *args: "custom_stage")
    monkeypatch.setattr(AmphiAgent, "_publish_stage", lambda *args: None)
    monkeypatch.setattr(AmphiAgent, "_run_think_unit_body", body)

    for agent in agents:
        ota_context = SimpleNamespace(think_status=object(), interaction_status=None)
        flow = agent.on_agent(ota_context, None)
        try:
            item = await anext(flow)
            assert item.name == "custom_stage"
            assert await agent._run_think_unit(item) == "done"
            assert body.call_args.kwargs["max_attempts"] == agent._max_rounds
        finally:
            await flow.aclose()
    await agents[0]._run_think_unit(ThinkUnit("custom_stage"))
    assert body.call_args.kwargs["max_attempts"] == 200


def test_reading_registry_does_not_import_business_packages(registry, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = tmp_path / "unregistered_business"
    package.mkdir()
    (package / "__init__.py").write_text("raise RuntimeError('this package must not be imported by registry access')\n")
    monkeypatch.setattr(cognitive, "__path__", [str(tmp_path)])
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(BaseThink)
    assert AmphiAgent().thinking_modes == {"demo": ("custom_stage",)}
