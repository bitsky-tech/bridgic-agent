"""Entry and re-entry requests for saved Workflow Runs."""

from typing import Literal, Optional

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ..request_human import RequestHumanRejection


class RequestRunWorkflow:
    """A semantic decision for entering one Session-owned Workflow Run."""

    MAX_REASON_LENGTH = 300

    def __init__(
        self,
        workflow_id: str,
        action: Literal["start", "resume", "restart", "ask"],
        reason: Optional[str] = None,
    ):
        self.workflow_id = workflow_id
        self.action = action
        self.reason = reason


async def request_run_workflow(
    workflow_id: str,
    action: Literal["start", "resume", "restart", "ask"] = "start",
    reason: str = "",
) -> RequestRunWorkflow:
    """Start or resolve re-entry into a Session-owned Workflow Run.

    Choose ``start`` when the Session has no active Run, ``resume`` when the
    user's intent clearly continues its pinned snapshot, ``restart`` when the
    user clearly wants the currently saved Workflow from the beginning, and
    ``ask`` only when an existing Run makes the intent ambiguous.

    Parameters
    ----------
    workflow_id : str
        Saved Workflow requested by the user.
    action : {"start", "resume", "restart", "ask"}
        Agent's semantic entry or re-entry decision.
    reason : str, optional
        Concise explanation. Required when ``action`` is ``ask``.

    Returns
    -------
    RequestRunWorkflow
        Structured Run re-entry request handled by the Agent runtime.

    Raises
    ------
    RequestHumanRejection
        If the Workflow id or required explanation is invalid.
    """
    workflow_id = workflow_id.strip()
    reason = reason.strip()
    if not workflow_id:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `workflow_id` must be non-empty.",
        )
    if action == "ask" and not reason:
        raise RequestHumanRejection(
            "request_run_workflow rejected: `reason` must explain the ambiguous Run intent.",
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
