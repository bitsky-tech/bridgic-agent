"""Entry and human-interaction requests for the presentation workflow."""

from typing import Any, Dict

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._request_human import RequestHumanRejection
from .progress import parse_presentation_step_data, PresentationToolRejection


class RequestPresentation:
    """A semantic request to enter the dedicated presentation pipeline."""

    def __init__(self, goal: str):
        self.goal = goal


async def request_presentation(goal: str) -> RequestPresentation:
    """Start creating or substantially rebuilding a PowerPoint presentation.

    Use this when the user asks to create or substantially rebuild a deck.
    Answer ordinary one-off questions about slides directly. Creation begins
    by clarifying the communication goal, then planning, composing, and
    reviewing the deck.

    Parameters
    ----------
    goal : str
        Concise description of the presentation to create or rebuild.

    Returns
    -------
    RequestPresentation
        The requested presentation goal.

    Raises
    ------
    RequestHumanRejection
        If ``goal`` is empty.
    """
    goal = goal.strip()
    if not goal:
        raise RequestHumanRejection("request_presentation rejected: `goal` must be non-empty.")
    return RequestPresentation(goal)


request_presentation_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_presentation)


class RequestPresentationOutlineConfirm:
    """An editable outline to review without completing the current step."""

    def __init__(self, data: Dict[str, Any]):
        self.data = data


async def request_presentation_outline_confirm(data: str) -> RequestPresentationOutlineConfirm:
    """Ask the user to edit and confirm the presentation outline.

    Call this alone during Plan's `map_slides` step. Wait for the user's
    response. If confirmed, use the returned outline as the source of truth,
    then call `report_presentation_step` to complete the step. If the user
    requests changes, revise the outline and request confirmation again.
    This interaction does not advance the production-step cursor.

    Parameters
    ----------
    data : str
        JSON object string containing the full `chapters` array. Each chapter
        has a title, optional summary, and ordered slides. Each slide has a
        title, non-empty content_outline, optional purpose and key_message,
        and source_ids from the registered evidence. The runtime assigns ids.
    """
    try:
        parsed = parse_presentation_step_data(data)
        if not isinstance(parsed.get("chapters"), list) or not parsed["chapters"]:
            raise ValueError("`data` requires a non-empty `chapters` array.")
    except ValueError as exc:
        raise PresentationToolRejection(f"request_presentation_outline_confirm rejected: {exc}") from exc
    return RequestPresentationOutlineConfirm(parsed)


request_presentation_outline_confirm_tool = FunctionToolSpec.from_raw(request_presentation_outline_confirm)


class RequestPresentationTemplateConfirm:
    """A request to review one recorded template retrieval result."""

    def __init__(self, search_id: str):
        self.search_id = search_id


async def request_presentation_template_confirm(search_id: str) -> RequestPresentationTemplateConfirm:
    """Ask the user to select a PowerPoint template or continue without one.

    Call this alone during Plan's visual-direction step, after `ppt_rag`.
    Pass the returned `search_id` to display that exact candidate batch. A
    retrieval_failed result can also be shown so the user can retry or skip.
    Wait for the user's decision. For another batch, retrieve again and call
    this tool with the new search_id. After selection or an explicit skip,
    finish the visual plan and call `report_presentation_step` separately.
    This interaction does not advance the production-step cursor.

    Parameters
    ----------
    search_id : str
        The search_id returned by a completed ppt_rag call in this Turn.
    """
    search_id = search_id.strip()
    if not search_id:
        raise RequestHumanRejection("request_presentation_template_confirm rejected: `search_id` must be non-empty.")
    return RequestPresentationTemplateConfirm(search_id)


request_presentation_template_confirm_tool = FunctionToolSpec.from_raw(request_presentation_template_confirm)


__all__ = [
    "RequestPresentation",
    "request_presentation",
    "request_presentation_tool",
    "RequestPresentationOutlineConfirm",
    "request_presentation_outline_confirm",
    "request_presentation_outline_confirm_tool",
    "RequestPresentationTemplateConfirm",
    "request_presentation_template_confirm",
    "request_presentation_template_confirm_tool",
]
