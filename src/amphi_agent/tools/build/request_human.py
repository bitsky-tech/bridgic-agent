"""Build entry requests and stage-owned human confirmations."""

import ast
import json
from typing import Any, Dict, Literal, Optional
from uuid import uuid4

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._request_human import RequestHumanRejection


class RequestBuild:
    """A request to propose or immediately enter reusable Workflow Build."""

    def __init__(self, goal: str, mode: Literal["ask", "start"] = "ask", reason: Optional[str] = None, request_id: Optional[str] = None):
        self.goal = goal
        self.mode = mode
        self.reason = reason
        self.request_id = (request_id or f"build_confirm_{uuid4().hex}") if mode == "ask" else None


async def request_build(goal: str, mode: Literal["ask", "start"] = "ask", reason: str = "") -> RequestBuild:
    """Start building a reusable Workflow or ask for confirmation.

    Use ``start`` when the user explicitly requests a new or replacement Workflow. Use
    ``ask`` when a reusable Workflow may help but was not requested, or when a
    retained Build requires the user to choose whether to keep, merge, or
    replace it. Do not use this tool for ordinary one-off work.

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
        The requested Workflow goal and confirmation or start action.

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


class RequestHumanTaskConfirm:
    """A request for the user to review the current ``task.md`` contract."""

    def __init__(self, request_id: Optional[str] = None):
        self.request_id = request_id or f"task_confirm_{uuid4().hex}"


async def request_human_task_confirm() -> RequestHumanTaskConfirm:
    """Ask the user to review and confirm ``task.md``; this ends the turn.

    Returns
    -------
    RequestHumanTaskConfirm
        A request identity used to correlate the user's structured response.
    """
    return RequestHumanTaskConfirm()


class RequestHumanWorkflowConfirm:
    def __init__(
        self,
        default_name: str,
        summary: Optional[str] = None,
        request_id: Optional[str] = None,
    ):
        self.request_id = request_id or f"workflow_confirm_{uuid4().hex}"
        self.default_name = default_name
        self.summary = summary

    @staticmethod
    def coerce_payload(prompt: Any) -> Dict[str, Any]:
        if isinstance(prompt, dict):
            return prompt
        if isinstance(prompt, str):
            for parse in (json.loads, ast.literal_eval):
                try:
                    value = parse(prompt)
                except (json.JSONDecodeError, ValueError, SyntaxError):
                    continue
                if isinstance(value, dict):
                    return value
        return {}


async def request_human_workflow_confirm(prompt: str) -> RequestHumanWorkflowConfirm:
    """Ask the user to name and confirm the verified workflow — this ENDS your turn.

    Use this only at the end of the build verify stage after Build Verify has
    completed. The UI surfaces a workflow naming card. The user's confirmation
    or cancellation arrives through the system resume path, so do NOT keep
    working after this call.

    Args:
        prompt: JSON payload:
            {"default_name": "workflow name", "summary": "optional short summary"}

    Returns:
        A ``RequestHumanWorkflowConfirm`` carrying the card payload.

    Raises:
        RequestHumanRejection: the payload is missing ``default_name``.
    """
    payload = RequestHumanWorkflowConfirm.coerce_payload(prompt)
    default_name = str(payload.get("default_name") or "").strip()
    summary = str(payload.get("summary") or "").strip() or None
    if not default_name:
        raise RequestHumanRejection(
            "request_human_workflow_confirm rejected: prompt must be JSON with "
            "a non-empty `default_name`, optionally `summary`."
        )
    return RequestHumanWorkflowConfirm(default_name=default_name, summary=summary)


request_human_task_confirm_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_human_task_confirm)


request_human_workflow_confirm_tool: FunctionToolSpec = FunctionToolSpec.from_raw(request_human_workflow_confirm)


__all__ = [
    "RequestBuild",
    "request_build",
    "request_build_tool",
    "RequestHumanTaskConfirm",
    "request_human_task_confirm",
    "RequestHumanWorkflowConfirm",
    "request_human_workflow_confirm",
    "request_human_task_confirm_tool",
    "request_human_workflow_confirm_tool",
]
