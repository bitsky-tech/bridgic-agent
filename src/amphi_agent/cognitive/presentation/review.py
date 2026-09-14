"""Cognitive worker for the presentation review stage."""

from ...prompts.presentation.review import PRESENTATION_REVIEW_PERSONA

from ..register import cognitive_stage
from .base import PresentationThink


@cognitive_stage(mode="presentation", stage="ppt_review", order=40)
class PresentationReviewThink(PresentationThink):
    """Inspect and revise the deck before returning control to Main."""

    persona = PRESENTATION_REVIEW_PERSONA
