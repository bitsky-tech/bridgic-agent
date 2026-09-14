"""Cognitive worker for the presentation brief stage."""

from typing import List

from bridgic.core.agentic.tool_specs import ToolSpec

from ..._context import AmphiContext, AmphiOTAContext
from ...prompts.presentation.brief import PRESENTATION_BRIEF_PERSONA

from ..register import cognitive_stage
from .base import PresentationThink


@cognitive_stage(mode="presentation", stage="ppt_brief", order=10)
class PresentationBriefThink(PresentationThink):
    """Establish the deck's communication contract before planning slides."""

    persona = PRESENTATION_BRIEF_PERSONA

    ############################################################################
    # Tools and Skills selection
    ############################################################################
    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Keep production reports out of the brief stage."""
        return [
            tool for tool in super().select_tools(ota_context, context)
            if tool.tool_name != "report_presentation_step"
        ]
