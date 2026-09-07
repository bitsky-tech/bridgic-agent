"""Entry requests for reusable Workflow Build."""

from typing import Literal, Optional
from uuid import uuid4

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ..request_human import RequestHumanRejection


class RequestBuild:
    """A request to propose or immediately enter reusable Workflow Build."""

    def __init__(self, goal: str, mode: Literal["ask", "start"] = "ask", reason: Optional[str] = None, request_id: Optional[str] = None):
        self.goal = goal
        self.mode = mode
        self.reason = reason
        self.request_id = (request_id or f"build_confirm_{uuid4().hex}") if mode == "ask" else None


async def request_build(goal: str, mode: Literal["ask", "start"] = "ask", reason: str = "") -> RequestBuild:
    """Propose or immediately enter reusable Workflow Build.

    In Main, use ``start`` for explicit new or replacement Build intent. Use
    ``ask`` when a reusable Workflow may help but was not requested, or when a
    retained Build requires the user to choose whether to keep, merge, or
    replace it. In Build, use ``ask`` only for genuinely competing intents. Do
    not use this tool for ordinary one-off work.

    Parameters
    ----------
    goal : str
        Concise description of the reusable Workflow to build.
    mode : {"ask", "start"}, optional
        Whether to ask for confirmation or enter Build immediately.
    reason : str, optional
        Short explanation shown when ``mode`` is ``ask``.

    Returns
    -------
    RequestBuild
        Structured Build entry request handled by the Agent.

    Raises
    ------
    RequestHumanRejection
        If ``goal`` is empty.
    """
    goal = goal.strip()
    if not goal:
        raise RequestHumanRejection("request_build rejected: `goal` must be non-empty.")
    return RequestBuild(goal=goal, mode=mode, reason=reason.strip() or None)


request_build_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_build)


__all__ = [
    "RequestBuild",
    "request_build",
    "request_build_tool",
]
