"""Compatibility facade for the agent's modular prompt templates."""

from typing import Collection

from ._prompts import render as _render
from ._prompts.build import (
    CLARIFY_PERSONA,
    EXPLORE_PERSONA,
    GENERATE_PERSONA,
    VERIFY_PERSONA,
)
from ._prompts.main import PERSONA, SUB_AGENT_PERSONA, SUB_AGENT_PROMPT
from ._prompts.shared import (
    AGENT_NAME,
    TURN_FAILED_MESSAGE,
    _SUB_AGENT_GUIDANCE as _SUB_AGENT_GUIDANCE,
)
from ._prompts.title import TITLE_PROMPT
from ._prompts.workflow import (
    WORKFLOW_PERSONA,
    WORKFLOW_VALIDATE_PERSONA,
)


def time_in_local_tz() -> str:
    """Return the local date and time at minute precision with its UTC offset."""
    return _render.time_in_local_tz()


def render_main_persona(tool_names: Collection[str], *, template: str = PERSONA) -> str:
    """Render Main or Child guidance for the current ToolSurface and locale."""
    return _render.render_main_persona(tool_names, template=template)


def render_stage_persona(tool_names: Collection[str], *, template: str) -> str:
    """Render special-mode guidance for the current ToolSurface and locale."""
    return _render.render_stage_persona(tool_names, template=template)


__all__ = [
    "AGENT_NAME",
    "CLARIFY_PERSONA",
    "EXPLORE_PERSONA",
    "GENERATE_PERSONA",
    "PERSONA",
    "SUB_AGENT_PERSONA",
    "TITLE_PROMPT",
    "TURN_FAILED_MESSAGE",
    "VERIFY_PERSONA",
    "WORKFLOW_PERSONA",
    "WORKFLOW_VALIDATE_PERSONA",
    "SUB_AGENT_PROMPT",
    "render_main_persona",
    "render_stage_persona",
    "time_in_local_tz",
]
