"""Runtime rendering helpers for prompt templates."""

from datetime import datetime
from typing import Collection

from ...amphi_service.i18n import backend_i18n
from .main import PERSONA
from .shared import (
    _MAIN_TOOL_NAMES_PLACEHOLDER,
    _STAGE_TOOL_NAMES_PLACEHOLDER,
    _SUB_AGENT_GUIDANCE,
    _SUB_AGENT_GUIDANCE_PLACEHOLDER,
    _SUB_AGENT_TOOL_NAMES,
    _UI_LANGUAGE_NAMES,
    _UI_LANGUAGE_PLACEHOLDER,
)


def time_in_local_tz() -> str:
    """Return the local date and time at minute precision with its UTC offset."""
    now = datetime.now().astimezone()
    offset = now.utcoffset()
    total_minutes = int(offset.total_seconds() / 60) if offset is not None else 0
    sign = "+" if total_minutes >= 0 else "-"
    hours, minutes = divmod(abs(total_minutes), 60)
    return f"{now:%Y-%m-%d %H:%M} (UTC{sign}{hours:02d}:{minutes:02d})"


def _format_tool_names(names: Collection[str]) -> str:
    return ", ".join(f"`{name}`" for name in names) or "(none)"


def _sub_agent_guidance(tool_names: Collection[str]) -> str:
    """Render only the delegation guidance supported by the visible tools."""
    visible = _SUB_AGENT_TOOL_NAMES & set(tool_names)
    if not visible:
        return ""
    guidance = _SUB_AGENT_GUIDANCE.strip()
    if "start_subagent" not in visible:
        guidance = "\n".join(
            line for line in guidance.splitlines()
            if "`start_subagent`" not in line
        )
    return guidance


def _ui_language() -> str:
    """The client's stated UI language, as the language rule's last-resort fallback.

    Read at render time rather than at import: the locale is request-scoped, so a
    module-level constant would freeze whichever connection happened to arrive first.
    """
    return _UI_LANGUAGE_NAMES[backend_i18n.current_locale()]


def render_main_persona(tool_names: Collection[str], *, template: str = PERSONA) -> str:
    """Render Main or Child guidance for the current ToolSurface and locale."""
    guidance = _sub_agent_guidance(tool_names)
    return (
        template.replace(_MAIN_TOOL_NAMES_PLACEHOLDER, _format_tool_names(tool_names))
        .replace(_SUB_AGENT_GUIDANCE_PLACEHOLDER, guidance)
        .replace(_UI_LANGUAGE_PLACEHOLDER, _ui_language())
    )


def render_stage_persona(tool_names: Collection[str], *, template: str) -> str:
    """Render a special-mode persona with its exact current ToolSurface."""
    guidance = _sub_agent_guidance(tool_names)
    return (
        template.replace(_STAGE_TOOL_NAMES_PLACEHOLDER, _format_tool_names(tool_names))
        .replace(_SUB_AGENT_GUIDANCE_PLACEHOLDER, guidance)
        .replace(_UI_LANGUAGE_PLACEHOLDER, _ui_language())
    )
