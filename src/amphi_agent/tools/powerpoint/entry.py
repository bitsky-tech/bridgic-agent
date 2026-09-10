"""Entry requests for the presentation workflow."""

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ..request_human import RequestHumanRejection


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


__all__ = [
    "RequestPresentation",
    "request_presentation",
    "request_presentation_tool",
]
