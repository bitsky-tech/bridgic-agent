"""The focused Child Session worker and its tool ceiling."""

from typing import List

from bridgic.core.agentic.tool_specs import ToolSpec

from ..._context import AmphiContext, AmphiOTAContext
from ..._state import NormalStageState
from ..._tools import TOOL_LIBRARY
from ...prompts.normal.subagent import SUB_AGENT_PERSONA
from ...tools import FILE_SYSTEM_TOOL_NAMES
from ..register import cognitive_stage
from .main import MainThink


@cognitive_stage(mode="normal", stage="subagent", order=20)
class SubAgentThink(MainThink):
    """Run one focused delegated task inside a Child Session."""

    persona: str = SUB_AGENT_PERSONA

    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Select this mode's tools in stable catalogue order."""
        tools = [
            *TOOL_LIBRARY.select(FILE_SYSTEM_TOOL_NAMES | {
                "bash",
                "generate_image",
                "list_workflow_runs",
                "read_image",
                "read_workflow_run",
                "request_human_choice",
                "web_fetch",
                "web_search",
            }),
            *TOOL_LIBRARY.get_browser_tools(include_advanced=ota_context.browser_tool_loaded),
            *TOOL_LIBRARY.get_workspace_tools(include_advanced=ota_context.workspace_tools_loaded),
            *TOOL_LIBRARY.get_skills_tools(include_advanced=ota_context.skills_tool_loaded),
        ]
        return [
            tool for tool in TOOL_LIBRARY.select(tool.tool_name for tool in tools)
            if tool.tool_name not in {"workspace_restore_file", "workspace_restore"}
        ]

    async def workspace_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Add the root Session's unfinished Workflow Run to the Child's context."""
        lines = ["<Workspace>", self.working_directory_block(context)]
        workspace = context.workspace
        if isinstance(ota_context.think_status, NormalStageState) and workspace is not None:
            run_checkpoint = workspace.run_workflow_checkpoint()
            if run_checkpoint is not None:
                lines.append(
                    f"- Retained Workflow Run: {run_checkpoint.workflow_name} "
                    f"(workflow_id: {run_checkpoint.workflow_id}, "
                    f"stage: {run_checkpoint.stage}, "
                    f"step_index: {run_checkpoint.step_index}, "
                    "owner: root Session)"
                )
        lines.append(self.environment_block(context))
        lines.append("</Workspace>")
        return "\n".join(lines)

    async def runtime_state_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Show changed files and browser tabs to the Child without checkpoint controls."""
        lines: List[str] = []
        workspace = context.workspace
        if workspace is not None:
            try:
                lines.extend(workspace.checkpoints.changed_files_context_lines())
            except Exception as exc:  # noqa: BLE001
                lines.append(f"- Changed files: unavailable ({type(exc).__name__}: {exc})")
        browser = await self.browser_block(ota_context, context)
        if browser:
            lines.append(browser)
        if not lines:
            return ""
        return (
            "<runtime_state>\n"
            "Live workspace and browser state as of this round (may change between rounds).\n"
            + "\n".join(lines)
            + "\n</runtime_state>"
        )

    async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Render the catalogues and shared workspace available to a Child Session."""
        return [
            await self.skills_block(ota_context, context),
            await self.workflows_block(ota_context, context),
            await self.memory_block(ota_context, context),
            await self.workspace_block(ota_context, context),
        ]

__all__ = ["SubAgentThink"]
