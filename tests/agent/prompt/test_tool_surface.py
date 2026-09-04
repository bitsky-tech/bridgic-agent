import json
import re
from copy import deepcopy
from typing import Any

import pytest
from bridgic.amphibious import OTARecord
from bridgic.core.model.types import Message

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, MainThink, Session, SkillLibrary
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent._cognitive import (
    SubAgentThink,
)
from src.amphi_agent._state import PresentationStageState
from src.amphi_agent.cognitive import (
    ClarifyThink,
    ExploreThink,
    GenerateThink,
    PresentationBriefThink,
    PresentationComposeThink,
    PresentationPlanThink,
    PresentationReviewThink,
    VerifyThink,
    WorkflowRunThink,
    WorkflowThink,
)
from src.amphi_agent.tools import (
    BROWSER_ADVANCED_TOOL_NAMES,
    SKILLS_ADVANCED_TOOL_NAMES,
    WORKSPACE_ADVANCED_TOOL_NAMES,
)
from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_store import SessionRecord, SkillRepository


USER_ID = "local"
SESSION_ID = "session-tools"
POWERPOINT_TOOL_NAMES = {
    "view_ppt",
    "get_ppt_page",
    "update_ppt_design",
    "edit_ppt_page",
    "insert_ppt_element",
    "remove_ppt_element",
    "insert_ppt_page",
    "remove_ppt_page",
    "move_ppt_page",
    "goto_ppt_page",
}


class _RecordingLlm:
    def __init__(self) -> None:
        self.messages: list[Message] = []
        self.tools: list[Any] = []

    async def stream_turn(
        self,
        messages: list[Message],
        tools: list[Any] | None,
        *,
        publish: Any,
        extra_body: dict[str, Any] | None = None,
    ) -> StreamResult:
        self.messages = deepcopy(messages)
        self.tools = deepcopy(tools or [])
        return StreamResult(tool_calls=[], content="Done")


def _context(*, skills: SkillLibrary | None = None, child: bool = False) -> AmphiContext:
    record = SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root="/sessions/session-tools",
        parent_session_id="root-session" if child else None,
    )
    return AmphiContext(session=Session(record, []), skills=skills)


def _prompt_tool_names(system: str) -> tuple[str, ...]:
    marker = "The tools currently available in this cognitive loop are: "
    rendered = system.split(marker, maxsplit=1)[1].split(". Call them directly.", maxsplit=1)[0]
    return tuple(re.findall(r"`([^`]+)`", rendered))


async def test_llm_tool_surface() -> None:
    """Final model boundary:

    {
      "prompt_tool_names": "same ordered names",
      "ota_tool_specs": "same ordered names",
      "llm_tool_schemas": "same complete ordered schemas"
    }

    Checks:
    1. The Persona advertises exactly the ToolSurface selected for this round.
    2. The Turn records the same ordered Tool specs used to render the Persona.
    3. The LLM receives complete schemas for exactly those ToolSpecs, in the same order.
    """

    llm = _RecordingLlm()
    ota_context = AmphiOTAContext(
        user_input="Inspect the workspace",
        ota_record=[OTARecord()],
    )

    await MainThink(llm).thinking(ota_context, _context())
    prompt_names = _prompt_tool_names(llm.messages[0].content)
    recorded_names = tuple(spec.tool_name for spec in ota_context.tools)
    expected_schemas = [spec.to_tool().model_dump() for spec in ota_context.tools]
    actual_schemas = [tool.model_dump() for tool in llm.tools]

    # Check 1: The Persona advertises exactly the ToolSurface selected for this round.
    assert prompt_names == recorded_names

    # Check 2: The Turn records the same ordered Tool specs used to render the Persona.
    assert recorded_names
    assert len(recorded_names) == len(set(recorded_names))

    # Check 3: The LLM receives complete schemas for exactly those ToolSpecs, in the same order.
    assert actual_schemas == expected_schemas


@pytest.mark.parametrize(("worker_type", "stage", "label", "expects_report"), [
    (PresentationBriefThink, "ppt_brief", "Brief", False),
    (PresentationPlanThink, "ppt_plan", "Plan", True),
    (PresentationComposeThink, "ppt_compose", "Compose", True),
    (PresentationReviewThink, "ppt_review", "Review", True),
])
async def test_presentation_llm_tool_surface(worker_type: Any, stage: str, label: str, expects_report: bool) -> None:
    """Every presentation stage advertises and sends the same tools to the model."""
    llm = _RecordingLlm()
    ota_context = AmphiOTAContext(
        user_input="Create a presentation",
        ota_record=[OTARecord()],
    )
    ota_context.transition_think(PresentationStageState(stage=stage, goal="Create a presentation"))

    await worker_type(llm).thinking(ota_context, _context())

    marker = f"The tools currently available in {label} are: "
    prompt_names = tuple(re.findall(
        r"`([^`]+)`",
        llm.messages[0].content.split(marker, maxsplit=1)[1].split(". Call them directly.", maxsplit=1)[0],
    ))
    recorded_names = tuple(spec.tool_name for spec in ota_context.tools)
    expected_schemas = [spec.to_tool().model_dump() for spec in ota_context.tools]
    actual_schemas = [tool.model_dump() for tool in llm.tools]

    assert "switch" in prompt_names
    assert ("report_presentation_step" in prompt_names) is expects_report
    assert prompt_names == recorded_names
    assert actual_schemas == expected_schemas


def test_lazy_tools() -> None:
    """Final lazy ToolSurface expansion:

    {
      "browser_loaded": "+ browser advanced tools only",
      "workspace_loaded": "+ Workspace advanced tools only",
      "skills_loaded": "+ Skill management tools only"
    }

    Checks:
    1. The default surface withholds every advanced lazy group.
    2. Each load flag adds its own complete group without leaking another group.
    3. Disabling the flag restores the original default surface.
    """
    worker = MainThink()
    context = _context()
    ota_context = AmphiOTAContext(user_input="Inspect tools")
    baseline = set(worker.tool_surface(ota_context, context).names)

    # Check 1: The default surface withholds every advanced lazy group.
    advanced = (
        BROWSER_ADVANCED_TOOL_NAMES
        | WORKSPACE_ADVANCED_TOOL_NAMES
        | SKILLS_ADVANCED_TOOL_NAMES
    )
    assert baseline.isdisjoint(advanced)

    # Check 2: Each load flag adds its own complete group without leaking another group.
    cases = (
        ("browser_tool_loaded", BROWSER_ADVANCED_TOOL_NAMES),
        ("workspace_tools_loaded", WORKSPACE_ADVANCED_TOOL_NAMES),
        ("skills_tool_loaded", SKILLS_ADVANCED_TOOL_NAMES),
    )
    for flag, expected in cases:
        setattr(ota_context, flag, True)
        expanded = set(worker.tool_surface(ota_context, context).names)
        assert expanded - baseline == expected
        setattr(ota_context, flag, False)

    # Check 3: Disabling the flag restores the original default surface.
    assert set(worker.tool_surface(ota_context, context).names) == baseline


def test_mode_tools() -> None:
    """Final mode-specific ToolSurfaces:

    {
      "main": ["delegation", "no switch"],
      "child": ["no delegation", "no root controls"],
      "build": ["switch", "stage completion control"],
      "presentation": ["switch", "no PowerPoint tools", "no mode-entry controls"],
      "workflow": ["switch", "report_workflow_step", "no mode-entry controls"]
    }

    Checks:
    1. Main and Child expose their distinct root and delegated capabilities.
    2. Build stages expose only the control actions owned by each stage.
    3. Presentation stages retain their process controls without exposing dormant PowerPoint tools.
    4. Workflow stages expose reporting and exit controls without mode-entry controls.
    5. Every mode can execute the common interaction, Browser-load, and Skill-read guidance.
    """
    context = _context()
    ota_context = AmphiOTAContext(user_input="Inspect mode tools")

    def names(worker: MainThink) -> set[str]:
        return {spec.tool_name for spec in worker.select_tools(ota_context, context)}

    main = names(MainThink())
    child = names(SubAgentThink())
    clarify = names(ClarifyThink())
    explore = names(ExploreThink())
    generate = names(GenerateThink())
    verify = names(VerifyThink())
    ppt_brief = names(PresentationBriefThink())
    ppt_plan = names(PresentationPlanThink())
    ppt_compose = names(PresentationComposeThink())
    ppt_review = names(PresentationReviewThink())
    execute = names(WorkflowThink())
    surfaces = (main, child, clarify, explore, generate, verify, execute)

    # Check 1: Main and Child expose their distinct root and delegated capabilities.
    assert {"run_subagent", "start_subagent"} <= main
    assert "request_presentation" in main
    assert "ppt_rag" not in main
    assert "report_presentation_step" not in main
    assert "switch" not in main
    assert {"run_subagent", "start_subagent", "request_build"}.isdisjoint(child)
    assert "request_human_choice" in child

    # Check 2: Build stages expose only the control actions owned by each stage.
    assert "switch" in clarify & explore & generate & verify
    assert "request_human_task_confirm" in clarify
    assert "request_human_workflow_confirm" in verify
    assert all("request_accept_rule" not in surface for surface in surfaces)
    assert "request_human_task_confirm" not in explore | generate | verify
    assert "request_human_workflow_confirm" not in clarify | explore | generate

    # Check 3: Presentation stages expose process controls without the dormant deck bridge.
    presentation_surfaces = (ppt_brief, ppt_plan, ppt_compose, ppt_review)
    for surface in presentation_surfaces:
        assert "switch" in surface
        assert "run_subagent" in surface
        assert "start_subagent" not in surface
        assert surface.isdisjoint(POWERPOINT_TOOL_NAMES)
        assert "ppt_rag" not in surface
        assert {"request_build", "request_presentation", "request_run_workflow"}.isdisjoint(surface)
    assert "report_presentation_step" not in ppt_brief
    assert all("report_presentation_step" in surface for surface in (ppt_plan, ppt_compose, ppt_review))

    # Check 4: Workflow execution exposes reporting and exit controls without mode-entry controls.
    assert {"switch", "report_workflow_step"} <= execute
    assert "report_presentation_step" not in execute
    assert {"request_build", "request_presentation", "edit_workflow", "help"}.isdisjoint(execute)

    # Check 5: Every mode can execute the common interaction, Browser-load, and Skill-read guidance.
    common = {"request_human_choice", "load_browser_tools", "view_skill"}
    for surface in (*surfaces, *presentation_surfaces):
        assert common <= surface
    for surface in (*surfaces, *presentation_surfaces):
        assert surface.isdisjoint(POWERPOINT_TOOL_NAMES)


def test_ppt_rag_is_visible_only_for_confirmed_visual_direction() -> None:
    """Template retrieval appears only when Plan has a confirmed page-role inventory."""
    context = _context()
    before = AmphiOTAContext(user_input="Choose a template")
    before.transition_think(PresentationStageState(stage="ppt_plan", step_index=2, goal="Research deck"))
    after = AmphiOTAContext(user_input="Choose a template")
    after.transition_think(PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        goal="Research deck",
        outline_confirmed=True,
    ))
    pending = AmphiOTAContext(user_input="Choose a template")
    pending.transition_think(PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        goal="Research deck",
        outline_confirmed=True,
        template_selection_status="pending",
    ))

    before_tools = {tool.tool_name for tool in PresentationPlanThink().select_tools(before, context)}
    after_tools = {tool.tool_name for tool in PresentationPlanThink().select_tools(after, context)}
    pending_tools = {tool.tool_name for tool in PresentationPlanThink().select_tools(pending, context)}
    assert "ppt_rag" not in before_tools
    assert "ppt_rag" in after_tools
    assert "ppt_rag" not in pending_tools


async def test_powerpoint_bridge_is_dormant_and_bridgic_skill_is_absent(prompt_store: None) -> None:
    assert TOOL_LIBRARY.select(POWERPOINT_TOOL_NAMES) == []
    assert "bridgic-ppt" not in SkillLibrary.builtin_names()
    assert "pptx" in SkillLibrary.builtin_names()

    await SkillRepository().ensure_builtin(
        USER_ID,
        name="bridgic-ppt",
        description="Legacy built-in PowerPoint authoring skill",
        skill_dir="/legacy/bridgic-ppt",
        source="local",
        source_uri="builtin://bridgic-ppt",
    )

    skills = await SkillLibrary(USER_ID).load()
    assert "bridgic-ppt" not in skills.data()
    assert await SkillRepository().get_by_name(USER_ID, "bridgic-ppt") is None


async def test_mode_tool_schemas(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final model surfaces:

    {
      "agent_bindings": "Main, Child, Build, and Workflow descriptors use their owned Personas",
      "personas": "exact runtime ToolSpec names",
      "llm_schemas": "same complete schemas generated from those ToolSpecs"
    }

    Checks:
    1. Each public Agent Think descriptor sends the Persona owned by its declared mode.
    2. Each assembled Persona renders the ToolSurface selected for that round exactly.
    3. The LLM receives the complete schemas generated from those ToolSpecs.
    4. The Workflow reporting schema describes only the current execution model.
    """
    def rendered_tool_names(system: str) -> tuple[str, ...]:
        if "The tools currently available in this cognitive loop are:" in system:
            return _prompt_tool_names(system)
        pattern = r"The tools currently available in [A-Za-z]+ are: (.*?)\. Call them directly\."
        match = re.search(pattern, system)
        assert match is not None
        return tuple(re.findall(r"`([^`]+)`", match.group(1)))

    async def context_blocks(_worker: Any, _ota_context: Any, _context: Any) -> list[str]:
        return []

    monkeypatch.setattr(WorkflowRunThink, "context_blocks", context_blocks)
    agent = AmphiAgent()

    cases = (
        ("main", {"mode": "normal", "stage": "main"}, False, "You are Bridgic Agent"),
        ("subagent", {"mode": "normal", "stage": "main"}, True, "This Session is a Child Agent"),
        ("clarify", {"mode": "build", "stage": "clarify"}, False, "# Current stage: clarify"),
        ("explore", {"mode": "build", "stage": "explore"}, False, "# Current stage: explore"),
        ("generate", {"mode": "build", "stage": "generate"}, False, "# Current stage: generate"),
        ("verify", {"mode": "build", "stage": "verify"}, False, "# Current stage: verify"),
        (
            "execute",
            {
                "mode": "run_workflow",
                "stage": "execute",
                "workflow_id": "workflow-a",
                "generation": "generation-a",
                "step_index": 0,
            },
            False,
            "# Current stage: Execute",
        ),
    )

    for unit_name, state, child, identity in cases:
        llm = _RecordingLlm()
        ota_context = AmphiOTAContext(
            user_input="Inspect stage tools",
            state={"think": state},
        )

        # Check 1: Each public Agent Think descriptor sends the Persona owned by its declared mode.
        unit = getattr(agent, unit_name)
        await unit.arun(llm=llm, ota_context=ota_context, context=_context(child=child), max_attempts=1)
        assert llm.messages
        assert llm.tools
        assert identity in llm.messages[0].content

        runtime_names = tuple(spec.tool_name for spec in ota_context.tools)
        prompt_names = rendered_tool_names(llm.messages[0].content)
        expected_schemas = [spec.to_tool().model_dump() for spec in ota_context.tools]
        actual_schemas = [tool.model_dump() for tool in llm.tools]

        # Check 2: Each assembled Persona renders the ToolSurface selected for that round exactly.
        assert prompt_names == runtime_names

        # Check 3: The LLM receives the complete schemas generated from those ToolSpecs.
        assert actual_schemas == expected_schemas

        # Check 4: Removed Workflow validation guidance does not leak through tool documentation.
        if unit_name == "execute":
            report_schema = next(
                schema for schema in actual_schemas if schema["name"] == "report_workflow_step"
            )
            assert "validation" not in json.dumps(report_schema).lower()


async def test_explore_skill(prompt_store: None) -> None:
    """Final Skill visibility:

    {
      "how-to_enabled": false,
      "main_context": "how-to omitted",
      "explore_context": "how-to exposed with its location"
    }

    Checks:
    1. A disabled built-in Skill is absent from normal Agent Context.
    2. Explore restores the product-owned how-to Skill for implementation discovery.
    3. Only Explore records the disabled Skill directory as model-visible.
    """
    skills = await SkillLibrary(USER_ID).load()
    how_to = await SkillRepository().get_by_name(USER_ID, "how-to")
    assert how_to is not None and how_to.id is not None
    await SkillRepository().set_enabled(USER_ID, how_to.id, False)
    skills = await SkillLibrary(USER_ID).load()
    context = _context(skills=skills)
    main_ota = AmphiOTAContext(user_input="Handle the request")
    explore_ota = AmphiOTAContext(
        user_input="Explore the implementation",
        state={"think": {"mode": "build", "stage": "explore"}},
    )

    main = await MainThink().assemble_messages(main_ota, context)
    explore = await ExploreThink().assemble_messages(explore_ota, context)

    # Check 1: A disabled built-in Skill is absent from normal Agent Context.
    assert "- how-to (location:" not in main[0].content

    # Check 2: Explore restores the product-owned how-to Skill for implementation discovery.
    assert "- how-to (location:" in explore[0].content
    assert json.dumps(how_to.skill_dir, ensure_ascii=False) in explore[0].content

    # Check 3: Only Explore records the disabled Skill directory as model-visible.
    assert how_to.skill_dir not in main_ota.selected_skill_dirs
    assert how_to.skill_dir in explore_ota.selected_skill_dirs
