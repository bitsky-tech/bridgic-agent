"""Human confirmations owned by the Build Clarify and Verify stages."""

import ast
import json
from typing import Any, Dict, Optional
from uuid import uuid4

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ..request_human import RequestHumanRejection


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
    "RequestHumanTaskConfirm",
    "request_human_task_confirm",
    "RequestHumanWorkflowConfirm",
    "request_human_workflow_confirm",
    "request_human_task_confirm_tool",
    "request_human_workflow_confirm_tool",
]
