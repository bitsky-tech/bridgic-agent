"""Section progress reports owned by Workflow execution stages."""

from typing import List, Literal, Optional

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._workflow import WorkflowToolRejection


class WorkflowStepReport:
    """The terminal result of one Workflow execution section."""

    def __init__(self, status: Literal["success", "failure"], summary: str, evidence: List[str]) -> None:
        self.status = status
        self.summary = summary
        self.evidence = evidence


async def report_workflow_step(status: Literal["success", "failure"], summary: str, evidence: Optional[List[str]] = None) -> WorkflowStepReport:
    """Finish the current Workflow section and advance or stop the run.

    Parameters
    ----------
    status : {"success", "failure"}
        Whether the current execution section completed as instructed. Report
        failure when the requested outcome cannot be completed safely or after
        reasonable recovery attempts.
    summary : str
        Concise account of what happened. On failure, include the concrete
        blocker or diagnosis and any attempted recovery when useful.
    evidence : list[str], optional
        Relevant output paths, command results, or observations.

    Returns
    -------
    WorkflowStepReport
        Structured step result consumed by the Agent runtime.
    """
    summary = summary.strip()
    if not summary:
        raise WorkflowToolRejection("report_workflow_step rejected: `summary` must be non-empty.")
    clean_evidence = [str(item).strip() for item in evidence or [] if str(item).strip()]
    return WorkflowStepReport(status, summary, clean_evidence)


report_workflow_step_tool = FunctionToolSpec.from_raw(report_workflow_step)


__all__ = [
    "WorkflowStepReport",
    "report_workflow_step",
    "report_workflow_step_tool",
]
