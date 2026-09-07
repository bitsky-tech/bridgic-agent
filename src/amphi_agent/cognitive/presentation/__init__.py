"""Dedicated cognitive pipeline for planning, composing, and reviewing presentations."""

from .base import PresentationThink
from .brief import PresentationBriefThink
from .compose import PresentationComposeThink
from .plan import PresentationPlanThink
from .review import PresentationReviewThink
from .shared import (
    PRESENTATION_STAGE_ARTIFACTS,
    PRESENTATION_STAGE_ORDER,
    PRESENTATION_STAGE_STEPS,
    PresentationStep,
)

__all__ = [
    "PRESENTATION_STAGE_ARTIFACTS",
    "PRESENTATION_STAGE_ORDER",
    "PRESENTATION_STAGE_STEPS",
    "PresentationBriefThink",
    "PresentationComposeThink",
    "PresentationPlanThink",
    "PresentationReviewThink",
    "PresentationStep",
    "PresentationThink",
]
