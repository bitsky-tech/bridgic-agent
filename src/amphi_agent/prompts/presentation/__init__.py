"""Stage prompts for presentation mode, preserving the existing public imports."""

from .brief import PRESENTATION_BRIEF_PERSONA
from .compose import PRESENTATION_COMPOSE_PERSONA
from .plan import PRESENTATION_PLAN_PERSONA
from .review import PRESENTATION_REVIEW_PERSONA

__all__ = [
    "PRESENTATION_BRIEF_PERSONA",
    "PRESENTATION_COMPOSE_PERSONA",
    "PRESENTATION_PLAN_PERSONA",
    "PRESENTATION_REVIEW_PERSONA",
]
