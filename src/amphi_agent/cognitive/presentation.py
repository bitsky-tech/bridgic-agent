"""Dedicated cognitive pipeline for planning, composing, and reviewing presentations."""

from typing import Any, List

from .._cognitive import MainThink
from .._context import AmphiContext, AmphiOTAContext
from ..prompts.presentation import (
    PRESENTATION_BRIEF_PERSONA,
    PRESENTATION_COMPOSE_PERSONA,
    PRESENTATION_PLAN_PERSONA,
    PRESENTATION_REVIEW_PERSONA,
)
from ..prompts.render import render_stage_persona
from ..tools import switch_tool


class PresentationThink(MainThink):
    """Shared tool surface and context for all presentation stages."""

    allowed_tools = MainThink.allowed_tools - {
        "create_schedule",
        "delete_schedule",
        "edit_workflow",
        "get_schedule",
        "help",
        "list_schedules",
        "remove_workflow",
        "request_build",
        "request_presentation",
        "request_run_workflow",
        "start_subagent",
        "update_schedule",
    }

    async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Render only context that can materially affect the current deck."""
        return [
            self.transcript_block(ota_context, context),
            await self.skills_block(ota_context, context),
            await self.memory_block(ota_context, context),
            await self.workspace_block(ota_context, context),
        ]

    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render this stage's persona with its exact runtime tool surface."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona([tool.tool_name for tool in tools], template=self.persona).strip()

    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[Any]:
        """Return presentation tools plus the cognitive handoff control."""
        return [*super().select_tools(ota_context, context), switch_tool]


class PresentationBriefThink(PresentationThink):
    """Establish the deck's communication contract before planning slides."""

    persona = PRESENTATION_BRIEF_PERSONA


class PresentationPlanThink(PresentationThink):
    """Create the evidence, visual direction, chapters, and slide map."""

    persona = PRESENTATION_PLAN_PERSONA


class PresentationComposeThink(PresentationThink):
    """Build the live deck from the approved production contract."""

    persona = PRESENTATION_COMPOSE_PERSONA


class PresentationReviewThink(PresentationThink):
    """Inspect and revise the deck before returning control to Main."""

    persona = PRESENTATION_REVIEW_PERSONA
