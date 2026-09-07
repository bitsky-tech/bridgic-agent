"""Cognitive worker for the presentation brief stage."""

from ...prompts.presentation.brief import PRESENTATION_BRIEF_PERSONA

from .base import PresentationThink


class PresentationBriefThink(PresentationThink):
    """Establish the deck's communication contract before planning slides."""

    persona = PRESENTATION_BRIEF_PERSONA
    allowed_tools = PresentationThink.allowed_tools - {"report_presentation_step"}
