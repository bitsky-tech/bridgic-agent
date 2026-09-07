"""Entry requests for the presentation workflow."""

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ..request_human import RequestHumanRejection


class RequestPresentation:
    """A semantic request to enter the dedicated presentation pipeline."""

    def __init__(self, goal: str):
        self.goal = goal


async def request_presentation(goal: str) -> RequestPresentation:
    """Enter the dedicated presentation pipeline for an explicit deck request.

    Use this from Main when the user asks to create or substantially rebuild a
    PowerPoint presentation. Ordinary one-off questions about slides remain in
    Main. The pipeline begins by clarifying the communication goal before it
    plans, composes, and reviews the deck.

    Parameters
    ----------
    goal : str
        Concise description of the presentation to create or rebuild.

    Returns
    -------
    RequestPresentation
        Structured presentation entry request handled by the Agent.

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
