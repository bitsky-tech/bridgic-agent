"""Entry and re-entry requests for saved Workflow Runs."""

from typing import Literal, Optional

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._request_human import RequestHumanRejection


class RequestRunWorkflow:
    """A semantic decision for entering one Session-owned Workflow Run."""

    MAX_REASON_LENGTH = 300

    def __init__(self, workflow_id: str, action: Literal["start", "ask"], reason: Optional[str] = None):
        self.workflow_id = workflow_id
        self.action = action
        self.reason = reason


async def request_run_workflow(workflow_id: str, action: Literal["start", "ask"] = "start", reason: str = "") -> RequestRunWorkflow:
    """Start a saved Workflow or ask how to handle an unfinished Run.

    Use ``start`` when the user explicitly requests a new Run or replacement
    of an unfinished Run. Each new Run uses the current task input.
    Use ``ask`` only when an unfinished Run exists, with a concrete reason for
    choosing between continuing its pinned snapshot and running the currently
    saved Workflow from the beginning. Never claim or replace another Session's Run.

    Parameters
    ----------
    workflow_id : str
        Saved Workflow requested by the user.
    action : {"start", "ask"}, optional
        Whether to start a new or replacement Run, or ask about the unfinished Run.
    reason : str, optional
        Concise explanation. Required when ``action`` is ``ask``.

    Returns
    -------
    RequestRunWorkflow
        The requested Workflow, action, and explanation.

    Raises
    ------
    RequestHumanRejection
        If the Workflow id, action, or required explanation is invalid.
    """
    workflow_id = workflow_id.strip()
    reason = reason.strip()
    if not workflow_id:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `workflow_id` must be non-empty.",
        )
    if action not in {"start", "ask"}:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `action` must be `start` or `ask`.",
        )
    if action == "ask" and not reason:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `reason` must explain the unfinished Run choice.",
        )
    if len(reason) > RequestRunWorkflow.MAX_REASON_LENGTH:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `reason` exceeds "
            f"{RequestRunWorkflow.MAX_REASON_LENGTH} characters.",
        )
    return RequestRunWorkflow(workflow_id, action, reason or None)


request_run_workflow_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_run_workflow)


__all__ = [
    "RequestRunWorkflow",
    "request_run_workflow",
    "request_run_workflow_tool",
]
