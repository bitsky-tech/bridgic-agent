"""The focused Child Session worker and its tool ceiling."""

from typing import List

from .._context import AmphiContext, AmphiOTAContext
from ..prompts.main import SUB_AGENT_PERSONA
from ..tools import BROWSER_TOOL_NAMES
from .base import MainThink


CHILD_TOOL_NAMES = BROWSER_TOOL_NAMES | frozenset({
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "web_search",
    "web_fetch",
    "read_image",
    "generate_image",
    "workspace_status",
    "workspace_diff",
    "workspace_history",
    "load_workspace_tools",
    "view_skill",
    "manage_skills",
    "list_workflow_runs",
    "read_workflow_run",
    "request_human_choice",
})



class SubAgentThink(MainThink):
    """Run one focused delegated task inside a Child Session."""

    persona: str = SUB_AGENT_PERSONA
    allowed_tools: frozenset[str] = CHILD_TOOL_NAMES
    show_build_context: bool = False
    show_workspace_checkpoints: bool = False
    workflow_run_owner_label: str = "root Session"

    async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Render the catalogues and shared workspace available to a Child Session."""
        return [
            await self.skills_block(ota_context, context),
            await self.workflows_block(ota_context, context),
            await self.memory_block(ota_context, context),
            await self.workspace_block(ota_context, context),
        ]

__all__ = ["CHILD_TOOL_NAMES", "SubAgentThink"]
