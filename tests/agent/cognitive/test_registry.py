"""Verify Agent-owned stage binding, dispatch, and instance configuration."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from bridgic.amphibious import AmphibiousAutoma, Context, OTAContext, RETURN, ThinkUnit, ThinkUnitDescriptor, think_unit

from src.amphi_agent import AmphiAgent, cognitive
from src.amphi_agent.cognitive import get_cognitive_stages
from src.amphi_agent.cognitive import registry as registration
from src.amphi_agent.cognitive.base import MainThink
from src.amphi_agent.cognitive.registry import cognitive_stage


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
    assert list(units) == list(expected)
    for name, worker_type in expected.items():
        assert type(units[name]._worker_template) is worker_type
        assert units[name]._max_attempts == 200
    expected_modes = {
        "build": ("clarify", "explore", "generate", "verify"),
        "presentation": ("ppt_brief", "ppt_plan", "ppt_compose", "ppt_review"),
        "run_workflow": ("execute",),
    }
    assert agent._max_rounds == 7
    assert agent.thinking_modes == expected_modes
    agent.thinking_modes["build"] = ()
    assert AmphiAgent().thinking_modes == expected_modes


def test_registry_only_provides_ordered_definitions(registry) -> None:
    calls = []

    class FirstThink(MainThink):
        def __init__(self):
            calls.append("created")
            super().__init__()

    cognitive_stage(mode="demo", stage="second", order=20)(MainThink)
    cognitive_stage(mode="demo", stage="tied", order=10)(MainThink)
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
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(MainThink)
    first = AmphiAgent()
    second = AmphiAgent()
    assert vars(first)["thinking_modes"] is first.thinking_modes
    first.thinking_modes["demo"] = ()
    assert second.thinking_modes == {"demo": ("custom_stage",)}
    first.thinking_modes = {"local": ("stage",)}
    assert first.thinking_modes == {"local": ("stage",)}
    assert second.thinking_modes == {"demo": ("custom_stage",)}


def test_duplicate_stage_name_does_not_replace_the_first_worker(registry) -> None:
    class FirstThink(MainThink):
        pass

    cognitive_stage(mode="demo", stage="first", order=10)(FirstThink)
    with pytest.raises(ValueError, match="already registered"):
        cognitive_stage(mode="another_mode", stage="first", order=20)(MainThink)
    agent = AmphiAgent()
    assert agent.thinking_modes == {"demo": ("first",)}
    assert type(AmphiAgent.first._worker_template) is FirstThink


@pytest.mark.parametrize("name", ["on_agent", "thinking_modes", "name", "main", "subagent"])
def test_existing_attributes_are_not_overwritten(registry, name: str) -> None:
    cognitive_stage(mode="demo", stage="first", order=10)(MainThink)
    cognitive_stage(mode="demo", stage=name, order=20)(MainThink)
    with pytest.raises(ValueError, match="overwrite an Agent attribute"):
        AmphiAgent()
    assert not hasattr(AmphiAgent, "first")


def test_subclass_cannot_mask_a_base_attribute_collision(registry, monkeypatch: pytest.MonkeyPatch) -> None:
    existing = object()
    monkeypatch.setattr(AmphiAgent, "custom_stage", existing, raising=False)
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(MainThink)

    class ChildAgent(AmphiAgent):
        custom_stage = think_unit(MainThink())

    with pytest.raises(ValueError, match="overwrite an Agent attribute"):
        ChildAgent()
    assert AmphiAgent.custom_stage is existing


def test_constructor_failure_does_not_partially_bind_stages(registry) -> None:
    class BrokenThink(MainThink):
        def __init__(self):
            raise RuntimeError("broken worker constructor")

    cognitive_stage(mode="demo", stage="first", order=10)(MainThink)
    cognitive_stage(mode="demo", stage="broken", order=20)(BrokenThink)
    with pytest.raises(RuntimeError, match="broken worker constructor"):
        AmphiAgent()
    assert not hasattr(AmphiAgent, "first")
    assert not hasattr(AmphiAgent, "broken")


def test_later_instances_reuse_worker_templates(registry) -> None:
    calls = []

    @cognitive_stage(mode="demo", stage="custom_stage", order=10)
    class CustomThink(MainThink):
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
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(MainThink)

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
    class OverrideThink(MainThink):
        pass

    cognitive_stage(mode="demo", stage="custom_stage", order=10)(MainThink)

    class ChildAgent(AmphiAgent):
        custom_stage = think_unit(OverrideThink(), max_attempts=3)

    child = ChildAgent()
    parent = AmphiAgent()
    assert type(child.custom_stage._worker_template) is OverrideThink
    assert type(parent.custom_stage._worker_template) is MainThink
    assert child.custom_stage._max_attempts == 3


async def test_agent_owned_descriptors_run_with_fresh_workers(registry) -> None:
    @cognitive_stage(mode="custom", stage="custom_stage", order=10)
    class CustomThink(MainThink):
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


async def test_on_agent_round_limit_overrides_descriptor_default_per_instance(registry, monkeypatch: pytest.MonkeyPatch) -> None:
    cognitive_stage(mode="custom", stage="custom_stage", order=10)(MainThink)
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
    cognitive_stage(mode="demo", stage="custom_stage", order=10)(MainThink)
    assert AmphiAgent().thinking_modes == {"demo": ("custom_stage",)}
