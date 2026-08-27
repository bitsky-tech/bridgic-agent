import json
from typing import Any, Dict, List, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

def _get_powerpoint() -> Any:
    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None) if agent is not None else None
    powerpoint = getattr(context, "powerpoint", None) if context is not None else None
    if powerpoint is None:
        raise RuntimeError("PowerPoint tools require an active Session PowerPoint")
    return powerpoint


def _format(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


async def powerpoint_list() -> str:
    """List the PowerPoint documents currently open as tabs in this Session.

    Returns document ids, titles, slide counts, the active document, and each
    document's selected slide id. Call this before editing an existing deck.
    """
    return _format(await _get_powerpoint().list_presentations())


async def powerpoint_snapshot(document_id: Optional[str] = None) -> str:
    """Read the current structured PowerPoint state without using the visual DOM.

    Parameters
    ----------
    document_id : str, optional
        One id returned by ``powerpoint_list``. Omit to read every open PPT tab.
    """
    return _format(await _get_powerpoint().snapshot(document_id))


async def powerpoint_apply(operations: List[Dict[str, Any]]) -> str:
    """Atomically apply a batch of structured operations to this Session's PPT tabs.

    Supported operation ``type`` values are: ``create_document``,
    ``select_document``, ``rename_document``, ``close_document``,
    ``set_page_size``, ``update_master``, ``add_slide``, ``select_slide``,
    ``update_slide``, ``delete_slide``, ``set_transition``, ``add_comment``,
    ``add_element``, ``update_element``, ``delete_element``, ``reorder_element``,
    ``add_animation``, and ``clear_animation``.

    Document, slide, and element ids come from ``powerpoint_snapshot``. Omitted
    ``document_id`` and ``slide_id`` target the active document and selected slide.
    ``add_element`` accepts ``element`` with a ``type`` and PowerPoint coordinates;
    text and shape defaults are filled when optional styling is omitted. If any
    operation is invalid, the whole batch is rejected without changing the deck.
    """
    return _format(await _get_powerpoint().apply(operations))


async def powerpoint_add_animation(
    element_id: str,
    effect: str,
    slide_id: Optional[str] = None,
    start: str = "onClick",
    duration: float = 0.5,
    delay: float = 0.0,
) -> str:
    """Add or replace an animation on one PowerPoint element.

    ``effect`` supports appear, fade, blinds, checkerboard, dissolve, flyIn,
    floatIn, split, wipeIn, zoomIn, zoom, fillColor, textColor, disappear, and
    blindsOut. ``start`` is onClick, withPrevious, or afterPrevious.
    """
    return _format(await _get_powerpoint().add_animation(
        element_id,
        effect,
        slide_id=slide_id,
        start=start,
        duration=duration,
        delay=delay,
    ))


powerpoint_tool_specs = [
    FunctionToolSpec.from_raw(tool)
    for tool in (
        powerpoint_list,
        powerpoint_snapshot,
        powerpoint_apply,
        powerpoint_add_animation,
    )
]

POWERPOINT_TOOL_NAMES = frozenset(spec.tool_name for spec in powerpoint_tool_specs)

__all__ = [
    "POWERPOINT_TOOL_NAMES",
    "powerpoint_add_animation",
    "powerpoint_apply",
    "powerpoint_list",
    "powerpoint_snapshot",
    "powerpoint_tool_specs",
]
