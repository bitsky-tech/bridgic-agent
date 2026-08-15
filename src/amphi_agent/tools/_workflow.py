import json
from typing import List, Literal, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec


class WorkflowToolRejection(ValueError):
    """Raised when a Workflow tool request is invalid or unavailable."""


class EditWorkflow:
    """A request to restore one saved Workflow into the Build pipeline."""

    def __init__(self, workflow_id: str) -> None:
        self.workflow_id = workflow_id


async def edit_workflow(workflow_id: str) -> EditWorkflow:
    """Edit an existing Workflow when the user explicitly requests a change.

    Parameters
    ----------
    workflow_id : str
        Stable id from ``<workflows>`` or a retained Workflow Run listed in
        ``<Workspace>``, not the display name.

    Returns
    -------
    EditWorkflow
        Structured edit request handled by the Agent runtime.
    """
    workflow_id = workflow_id.strip()
    if not workflow_id:
        raise WorkflowToolRejection("edit_workflow rejected: `workflow_id` must be non-empty.")
    agent = current_agent.get(None)
    workflows = getattr(getattr(agent, "ctx", None), "workflows", None)
    if workflows is not None:
        try:
            await workflows.prepare_edit(workflow_id)
        except ValueError as exc:
            raise WorkflowToolRejection(f"edit_workflow rejected: {exc}.") from exc
    return EditWorkflow(workflow_id)


async def remove_workflow(workflow_id: str) -> str:
    """Permanently remove one saved Workflow definition and source package.

    Parameters
    ----------
    workflow_id : str
        Stable id from ``<workflows>``, not the display name.

    Returns
    -------
    str
        Confirmation naming the removed Workflow. Published Workflow Run
        results and active pinned Run snapshots are retained.
    """
    workflow_id = workflow_id.strip()
    if not workflow_id:
        raise WorkflowToolRejection("remove_workflow rejected: `workflow_id` must be non-empty.")
    agent = current_agent.get(None)
    workflows = getattr(getattr(agent, "ctx", None), "workflows", None)
    if workflows is None:
        raise WorkflowToolRejection("remove_workflow rejected: Workflow catalogue is unavailable.")
    package = workflows.get(workflow_id)
    if not await workflows.delete(workflow_id):
        raise WorkflowToolRejection(
            f"remove_workflow rejected: Workflow `{workflow_id}` is unavailable."
        )
    name = str(getattr(package, "name", "") or "").strip()
    label = f"`{name}` (`{workflow_id}`)" if name else f"`{workflow_id}`"
    return (
        f"Removed Workflow {label} and its saved source package. "
        "Published Workflow Run results were retained."
    )


class WorkflowStepReport:
    """The terminal result of one execution or validation section."""

    def __init__(self, status: Literal["success", "failure"], summary: str, evidence: List[str]) -> None:
        self.status = status
        self.summary = summary
        self.evidence = evidence


async def report_workflow_step(
    status: Literal["success", "failure"],
    summary: str,
    evidence: Optional[List[str]] = None,
) -> WorkflowStepReport:
    """Finish the current Workflow section and advance or stop the run.

    Parameters
    ----------
    status : {"success", "failure"}
        Whether the current section completed as instructed. Validation reports
        failure only after its bounded recovery attempts are exhausted or no
        safe repair is plausible.
    summary : str
        Concise account of what happened. A repaired validation includes the
        cause, correction, attempt count, and passing evidence; a failed
        validation includes its diagnosis and attempted repairs.
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


async def list_workflow_runs(workflow_id: str = "", query: str = "", limit: int = 20) -> str:
    """List recent Workflow results available to the current user.

    Parameters
    ----------
    workflow_id : str, optional
        Restrict results to one saved Workflow id.
    query : str, optional
        Match a run id, Workflow name, or original Workflow input.
    limit : int, optional
        Maximum number of recent results, from 1 to 50.

    Returns
    -------
    str
        JSON array containing stable run ids, status, validation, input, and
        published final-result and intermediate-work files.
    """
    agent = current_agent.get(None)
    workflow_runs = getattr(getattr(agent, "ctx", None), "workflow_runs", None)
    if workflow_runs is None:
        raise WorkflowToolRejection("Workflow results are unavailable in this context.")
    rows = await workflow_runs.search(
        query.strip(),
        workflow_id.strip() or None,
        max(1, min(int(limit), 50)),
    )
    return json.dumps([
        {
            "run_id": run.run_id,
            "workflow_id": run.workflow_id,
            "workflow_name": run.workflow_name,
            "status": run.status.value,
            "validation": run.validation_status.value,
            "workflow_input": run.workflow_input.model_dump(),
            "created_at": run.created_at.isoformat(),
            "files": list(run.files),
        }
        for run in rows
    ], ensure_ascii=False)


async def read_workflow_run(run_id: str, path: str = "") -> str:
    """Read one Workflow result summary or one of its text files.

    Parameters
    ----------
    run_id : str
        Stable id returned by ``list_workflow_runs`` or a structured mention.
    path : str, optional
        Published file path under ``result/`` or ``background/work/``; omit to
        read the metadata summary.

    Returns
    -------
    str
        JSON summary or the selected UTF-8 file content.
    """
    agent = current_agent.get(None)
    workflow_runs = getattr(getattr(agent, "ctx", None), "workflow_runs", None)
    run = await workflow_runs.load_run(run_id.strip()) if workflow_runs is not None else None
    if run is None or not run.is_published:
        raise WorkflowToolRejection(f"Workflow result `{run_id}` is unavailable.")
    if path.strip():
        return workflow_runs.read_file(run.run_id, path.strip())
    return json.dumps({
        "run_id": run.run_id,
        "workflow_id": run.workflow_id,
        "workflow_name": run.workflow_name,
        "status": run.status.value,
        "validation": run.validation_status.value,
        "workflow_input": run.workflow_input.model_dump(),
        "source_session_id": run.source_session_id,
        "result_root": str(run.result_dir),
        "work_root": str(run.background_work_dir),
        "files": list(run.files),
    }, ensure_ascii=False)


edit_workflow_tool = FunctionToolSpec.from_raw(edit_workflow)
remove_workflow_tool = FunctionToolSpec.from_raw(remove_workflow)
report_workflow_step_tool = FunctionToolSpec.from_raw(report_workflow_step)
list_workflow_runs_tool = FunctionToolSpec.from_raw(list_workflow_runs)
read_workflow_run_tool = FunctionToolSpec.from_raw(read_workflow_run)


__all__ = [
    "EditWorkflow",
    "WorkflowStepReport",
    "edit_workflow",
    "edit_workflow_tool",
    "list_workflow_runs",
    "list_workflow_runs_tool",
    "read_workflow_run",
    "read_workflow_run_tool",
    "remove_workflow",
    "remove_workflow_tool",
    "report_workflow_step",
    "report_workflow_step_tool",
]
