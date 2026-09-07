"""Cognitive worker for the presentation compose stage."""

from ...prompts.presentation.compose import PRESENTATION_COMPOSE_PERSONA

from ..registry import cognitive_stage
from .base import PresentationThink


@cognitive_stage(mode="presentation", stage="ppt_compose", order=30)
class PresentationComposeThink(PresentationThink):
    """Build the live deck from the approved production contract."""

    persona = PRESENTATION_COMPOSE_PERSONA
