"""Cognitive worker for the presentation plan stage."""

from ...prompts.presentation.plan import PRESENTATION_PLAN_PERSONA

from .base import PresentationThink


class PresentationPlanThink(PresentationThink):
    """Create the evidence, visual direction, chapters, and slide map."""

    persona = PRESENTATION_PLAN_PERSONA
