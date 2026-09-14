"""Execute the current section of a saved Workflow."""

from ...prompts.workflow.execute import WORKFLOW_PERSONA
from ..register import cognitive_stage
from .base import WorkflowRunThink


@cognitive_stage(mode="run_workflow", stage="execute", order=10)
class WorkflowThink(WorkflowRunThink):
    """Execute the current section of a saved Workflow."""

    persona: str = WORKFLOW_PERSONA
    workflow_stage: str = "execute"

__all__ = ["WorkflowThink"]
