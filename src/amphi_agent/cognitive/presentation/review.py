"""Cognitive worker for the presentation review stage."""

from ...prompts.presentation.review import PRESENTATION_REVIEW_PERSONA

from .base import PresentationThink


class PresentationReviewThink(PresentationThink):
    """Inspect and revise the deck before returning control to Main."""

    persona = PRESENTATION_REVIEW_PERSONA
