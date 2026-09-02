from src.amphi_agent import AmphiAgent, AmphiOTAContext
from src.amphi_agent._state import NormalStageState, PresentationStageState
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.cognitive import PresentationBriefThink
from src.amphi_agent.prompts.presentation import PRESENTATION_BRIEF_PERSONA


def test_presentation_pipeline_is_registered() -> None:
    """Every durable presentation stage resolves to one registered ThinkUnit."""
    agent = AmphiAgent()

    assert agent.thinking_modes["presentation"] == (
        "ppt_brief",
        "ppt_plan",
        "ppt_compose",
        "ppt_review",
    )
    assert all(getattr(agent, stage, None) is not None for stage in agent.thinking_modes["presentation"])
    assert "request_presentation" in {tool.tool_name for tool in TOOL_LIBRARY.all()}


def test_presentation_prompt_is_owned_by_prompt_package() -> None:
    """The ThinkUnit imports its persona instead of defining prompt text locally."""
    assert PresentationBriefThink.persona is PRESENTATION_BRIEF_PERSONA
    assert "__AMPHI_STAGE_TOOL_NAMES__" in PRESENTATION_BRIEF_PERSONA


def test_presentation_pipeline_switches_and_resumes() -> None:
    """Stage handoffs and cross-Turn restoration preserve the presentation mode."""
    agent = AmphiAgent()
    current = PresentationStageState(stage="ppt_brief")

    planned = agent._switch_status(current, "presentation", "ppt_plan")
    finished = agent._switch_status(planned, "normal", None)
    ota_context = AmphiOTAContext()
    agent._resume_think_stage(ota_context, {"mode": "presentation", "stage": "ppt_review"})

    assert planned == PresentationStageState(stage="ppt_plan")
    assert finished == NormalStageState()
    assert ota_context.think_status == PresentationStageState(stage="ppt_review")
