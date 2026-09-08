"""Cognitive worker for the presentation plan stage."""

from ...prompts.presentation.plan import PRESENTATION_PLAN_PERSONA

from ..register import cognitive_stage
from .base import PresentationThink


@cognitive_stage(mode="presentation", stage="ppt_plan", order=20)
class PresentationPlanThink(PresentationThink):
    """Create the evidence, visual direction, chapters, and slide map."""

    persona = PRESENTATION_PLAN_PERSONA
