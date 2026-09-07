"""Cognitive worker for the presentation brief stage."""

from ...prompts.presentation.brief import PRESENTATION_BRIEF_PERSONA

from ..registry import cognitive_stage
from .base import PresentationThink


@cognitive_stage(mode="presentation", stage="ppt_brief", order=10)
class PresentationBriefThink(PresentationThink):
    """Establish the deck's communication contract before planning slides."""

    persona = PRESENTATION_BRIEF_PERSONA
    allowed_tools = PresentationThink.allowed_tools - {"report_presentation_step"}
