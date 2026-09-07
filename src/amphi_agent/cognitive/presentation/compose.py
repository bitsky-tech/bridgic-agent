"""Cognitive worker for the presentation compose stage."""

from ...prompts.presentation.compose import PRESENTATION_COMPOSE_PERSONA

from .base import PresentationThink


class PresentationComposeThink(PresentationThink):
    """Build the live deck from the approved production contract."""

    persona = PRESENTATION_COMPOSE_PERSONA
