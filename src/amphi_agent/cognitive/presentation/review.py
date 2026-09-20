"""Cognitive worker for the presentation review stage."""

from typing import List

from bridgic.core.agentic.tool_specs import ToolSpec

from ..._context import AmphiContext, AmphiOTAContext
from ..._tools import TOOL_LIBRARY
from ...prompts.presentation.review import PRESENTATION_REVIEW_PERSONA
from ...tools.powerpoint import POWERPOINT_TOOL_NAMES

from ..register import cognitive_stage
from .base import PresentationThink


@cognitive_stage(mode="presentation", stage="ppt_review", order=40)
class PresentationReviewThink(PresentationThink):
    """Inspect and revise the deck before returning control to Main."""

    persona = PRESENTATION_REVIEW_PERSONA

    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Expose inspection and repair tools for final live-deck review."""
        tools = super().select_tools(ota_context, context)
        selected = {tool.tool_name for tool in tools}
        controls = [tool for tool in tools if tool.tool_name == "switch"]
        tools = [tool for tool in tools if tool.tool_name != "switch"]
        return [*tools, *(tool for tool in TOOL_LIBRARY.select(POWERPOINT_TOOL_NAMES) if tool.tool_name not in selected), *controls]
