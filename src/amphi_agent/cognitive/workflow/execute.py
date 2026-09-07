"""Execute the current section of a saved Workflow."""

from typing import Optional

from bridgic.amphibious import StepToolCall

from ..._context import AmphiContext, AmphiOTAContext
from ...prompts.workflow.execute import WORKFLOW_PERSONA
from .base import WorkflowRunThink


class WorkflowThink(WorkflowRunThink):
    """Execute the current section of a saved Workflow."""

    persona: str = WORKFLOW_PERSONA
    workflow_stage: str = "execute"

    async def legality_check(
        self,
        call: StepToolCall,
        ota_context: Optional[AmphiOTAContext],
        context: AmphiContext,
    ) -> Optional[str]:
        """Ensure an execution report belongs to the active WORKFLOW.md section."""
        return await self.report_legality_reason(call, ota_context, context, "execute")

__all__ = ["WorkflowThink"]
