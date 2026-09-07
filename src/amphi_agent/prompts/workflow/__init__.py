"""Stage prompts for workflow mode, preserving the existing public imports."""

from ..shared import AGENT_NAME
from .execute import WORKFLOW_PERSONA

__all__ = [
    "AGENT_NAME",
    "WORKFLOW_PERSONA",
]
