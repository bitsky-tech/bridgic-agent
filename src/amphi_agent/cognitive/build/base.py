"""Shared capabilities and history policy for Workflow Build stages."""

from dataclasses import replace

import json
import re
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec

from ..base import BaseThink
from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ...security import Permission
from ..state import CallVerdict, InStage, ThinkUnitOutcome
from .state import BuildStageState
from ..normal.state import NormalStageState
from ..._tools import TOOL_LIBRARY
from ...prompts.render import render_stage_persona
from ...tools import FILE_SYSTEM_TOOL_NAMES, switch_tool
from ....amphi_store import SessionTurnRecord

if TYPE_CHECKING:
    from ..._agent import AmphiAgent


class BuildThink(BaseThink):
    """Provide the shared history policy and capabilities for Build stages.

    Notes
    -----
    Concrete Thinks keep their own prompt assembly and legality checks. This
    base centralizes Build history projection, stable paths, artifact rendering,
    and tool access.
    """


    ############################################################################
    # The agent design
    ############################################################################
    async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: Optional[SessionTurnRecord], agent: "AmphiAgent") -> None:
        """Bind Build resources before a shared reply can consume the pending Turn."""
        await self.sync_build_space(ota_context, context)
        await super().init_state(ota_context, context, previous_turn, agent)

    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Apply stage transitions within the current Build or return control to Main."""
        await super().handle_action_result(ota_context, context, agent)

        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "switch":
                sig = step.tool_result
                current_status = ota_context.think_status
                target_mode = sig.get("mode") or current_status.mode
                if target_mode == "normal":
                    next_status = NormalStageState()
                elif target_mode != current_status.mode:
                    raise RuntimeError(f"Cannot switch from `{current_status.mode}` to `{target_mode}`.")
                else:
                    next_status = current_status.model_copy(update={"stage": str(sig.get("stage"))})
                ota_context.transition_think(next_status)
                if sig.get("reason") and not isinstance(next_status, NormalStageState):
                    agent._stamp_stage_handoff(ota_context, current_status, next_status, sig["reason"])
                if isinstance(next_status, BuildStageState):
                    await self.sync_build_space(ota_context, context)
                elif isinstance(next_status, NormalStageState):
                    agent._stamp_mode_exit(ota_context, current_status, sig.get("reason"))
                    self.close_build_bindings(context)

    async def handle_think_unit_result(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        previous_status: InStage,
        result: Optional[str],
        agent: "AmphiAgent",
    ) -> ThinkUnitOutcome:
        """Continue an unchanged Build stage until its completion control is used."""
        outcome = await super().handle_think_unit_result(
            ota_context, context, previous_status, result, agent,
        )
        if ota_context.think_status != previous_status:
            return outcome
        nudge = (
            "[build] Your last reply did NOT move the pipeline — you are still in this "
            "stage. The stage advances ONLY when you actually INVOKE the switch tool "
            "(a real tool call). Writing a tool call as text in your message does NOT "
            "count and changes nothing. When this stage is done, call the switch tool "
            "to hand off to the next Build stage. Never switch to normal merely because "
            "the work appears complete; normal is only for an explicit user pause or exit. "
            "Need input from the user? Call request_human_choice. Otherwise invoke the "
            "next-stage handoff now—call it, don't type it."
        )

        return replace(outcome, continuation=nudge)

    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict], agent: "AmphiAgent") -> List[CallVerdict]:
        """Validate explicit handoffs within the current Build."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts, agent)
        for index, (call, verdict) in enumerate(zip(calls, resolved)):
            if verdict.verdict == Permission.DENY.value:
                continue
            reason = None
            if getattr(call, "tool", None) == "switch" and ota_context is not None:
                arguments = {
                    _view(argument, "name"): _view(argument, "value")
                    for argument in getattr(call, "tool_arguments", None) or []
                }
                if (
                    arguments.get("mode") != "normal"
                    and arguments.get("stage")
                    and not str(arguments.get("reason") or "").strip()
                ):
                    reason = (
                        "switch rejected: a Build stage handoff requires a non-empty, "
                        "self-contained reason for the next stage."
                    )
            if reason:
                resolved[index] = verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
        return resolved

    ############################################################################
    # Dynamic prompt assembly
    ############################################################################
    ##############
    # Blocks
    ##############
    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render the Build-stage persona with its exact current tool selection."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona(
            [tool.tool_name for tool in tools],
            template=self.persona,
        ).strip()

    async def workspace_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Add the active Build directory to the shared Session environment."""
        lines = ["<Workspace>", self.working_directory_block(context)]
        build = self.build_space(context)
        if build is not None:
            lines.append(
                "- Build work directory (active, writable): "
                f"{json.dumps(str(build.root), ensure_ascii=False)}"
            )
        lines.append(self.environment_block(context))
        lines.append("</Workspace>")
        return "\n".join(lines)

    def build_workspace_block(self, context: AmphiContext) -> str:
        """Render the active Build root and its current file tree."""
        build = self.build_space(context)
        if build is None:
            return ""
        package = self.build_package(context)
        if package is None:
            return ""
        relative = build.root.name
        workflow_id = build.workflow_id
        workflows = context.workflows
        workflow = workflows.get(workflow_id) if workflows is not None and workflow_id else None
        if workflow_id:
            operation_lines = [
                "Operation: edit",
                f"Workflow id: `{workflow_id}`",
            ]
            if workflow is not None:
                operation_lines.append(f"Workflow name: `{workflow.name}`")
            operation_lines.extend([
                "Baseline: Restored from the saved Workflow.",
                "Preservation: Preserve every unaffected requirement, plan, source file, "
                "and dependency.",
            ])
        else:
            operation_lines = [
                "Operation: create",
                "Workflow id: (none; allocated after final confirmation)",
                "Baseline: New Workflow; no saved baseline is being edited.",
            ]
        return (
            "<build_workspace>\n"
            + "\n".join(operation_lines)
            + "\n\n"
            f"Workspace-relative root: `{relative}/` (use with file tools).\n"
            f"Absolute root: `{build.root}` (required as `bash.cwd` for Build shell calls).\n"
            "Write every Build artifact under this root and never at the workspace root.\n"
            "Current contents:\n"
            + "\n".join(package.tree_lines())
            + "\n</build_workspace>"
        )

    def artifacts_block(
        self,
        context: AmphiContext,
        *names: str,
    ) -> str:
        """Render selected non-empty Build artifacts as model context."""
        build = self.build_space(context)
        if build is None:
            return ""
        package = self.build_package(context)
        if package is None:
            return ""
        parts: List[str] = []
        for name in names:
            body = package.read_document(name)
            if body:
                parts.append(f"<{name}>\n{body}\n</{name}>")
        if not parts:
            return ""
        return (
            "<artifacts>\nCurrent Build artifacts relevant to this stage.\n"
            + "\n\n".join(parts)
            + "\n</artifacts>"
        )

    async def build_context_blocks(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        *artifact_names: str,
    ) -> List[str]:
        """Render Build context from stable references to live filesystem state."""
        return [
            self.transcript_block(ota_context, context),
            await self.skills_block(ota_context, context),
            self.artifacts_block(context, *artifact_names),
            await self.memory_block(ota_context, context),
            self.build_workspace_block(context),
            await self.workspace_block(ota_context, context),
        ]

    ############################################################################
    # Tools and Skills selection
    ############################################################################
    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Select this mode's tools in stable catalogue order."""
        tools = [
            *super().select_tools(ota_context, context),
            *TOOL_LIBRARY.select(FILE_SYSTEM_TOOL_NAMES | {
                "bash",
                "generate_image",
                "list_workflow_runs",
                "read_image",
                "read_workflow_run",
                "request_human_choice",
                "run_subagent",
                "web_fetch",
                "web_search",
            }),
            *TOOL_LIBRARY.get_browser_tools(include_advanced=ota_context.browser_tool_loaded),
            *TOOL_LIBRARY.get_workspace_tools(include_advanced=ota_context.workspace_tools_loaded),
            *TOOL_LIBRARY.get_skills_tools(include_advanced=ota_context.skills_tool_loaded),
        ]
        tools = TOOL_LIBRARY.select(tool.tool_name for tool in tools)
        return [*tools, switch_tool]

    def select_skills(self, ota_context: AmphiOTAContext, context: AmphiContext) -> Dict[str, Skill]:
        """Expose the enabled Skills selected for this mode."""
        skills = context.skills
        return skills.data() if skills is not None else {}

    ############################################################################
    # Helpers
    ############################################################################
    @staticmethod
    async def sync_build_space(ota_context: AmphiOTAContext, context: AmphiContext, *, create: bool = False) -> None:
        """Project the resolved think state onto this turn's Workspace.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Turn state containing the active discriminated think state.
        context : AmphiContext
            Session context whose Workspace receives the Build-space projection.
        create : bool
            Create a new build directory instead of reopening an existing one.
        """
        workspace = context.workspace
        if workspace is None:
            return
        workflows = context.workflows
        think = ota_context.think_status
        if isinstance(think, BuildStageState):
            if workflows is None:
                raise RuntimeError("No Workflow library is available for the active Build.")
            if create:
                workflows.close_package()
            active = workspace.build
            if create:
                if think.workflow_id:
                    async with workflows.guarded_source(think.workflow_id) as workflow:
                        active = await workspace.prepare_build_space(
                            "create",
                            workflow_id=think.workflow_id,
                            stage=think.stage,
                        )
                        try:
                            await workflows.restore_source(workflow, active.root)
                            task_baseline = workflow.task_markdown
                            if task_baseline is None:
                                raise RuntimeError(
                                    "The saved Workflow has no task.md edit baseline."
                                )
                            active.record_edit_task_baseline(task_baseline)
                        except BaseException:
                            await workspace.discard_build()
                            raise
                else:
                    active = await workspace.prepare_build_space(
                        "create",
                        stage=think.stage,
                    )
            elif active is None:
                active = await workspace.prepare_build_space(
                    "resume",
                    stage=think.stage,
                )
            if active.workflow_id != think.workflow_id:
                raise RuntimeError("The active Build does not match the current edit target.")
            active.set_stage(think.stage, think.workflow_id)
            workflows.open_package(active.root)
            return
        workspace.close_build_space()
        if workflows is not None:
            workflows.close_package()

    @staticmethod
    def close_build_bindings(context: AmphiContext) -> None:
        """Unbind the Build Space and its active Workflow package."""
        if context.workspace is not None:
            context.workspace.close_build_space()
        if context.workflows is not None:
            context.workflows.close_package()

    @staticmethod
    def human_document_reason(name: str, body: str) -> Optional[str]:
        """Validate heading use in a human-facing Build document."""
        level_one: List[int] = []
        fence: Optional[str] = None
        annotation = re.compile(
            r"^\s*#{1,6}\s+`?(CODE|AGENT|STABLE|VOLATILE|HUMAN|sample)`?\s*[:=]",
            flags=re.IGNORECASE,
        )
        for line_number, line in enumerate(body.splitlines(), start=1):
            stripped = line.strip()
            marker = re.match(r"^(`{3,}|~{3,})", stripped)
            if marker:
                candidate = marker.group(1)
                if fence is None:
                    fence = candidate
                elif candidate[0] == fence[0] and len(candidate) >= len(fence):
                    fence = None
                continue
            if fence is not None:
                continue
            if annotation.match(line):
                return (
                    f"{name} line {line_number} uses a machine annotation as a Markdown "
                    "heading; write it as a list item with an inline-code marker instead."
                )
            if re.match(r"^#\s+\S", stripped):
                level_one.append(line_number)
        if len(level_one) > 1:
            lines = ", ".join(str(line_number) for line_number in level_one)
            return (
                f"{name} has multiple level-one headings on lines {lines}; keep one "
                "document title and use ## or ### for sections."
            )
        return None

    def workflow_validation_reason(
        self,
        context: AmphiContext,
    ) -> Optional[str]:
        """Return why the active build's workflow is invalid, if applicable."""
        build = self.build_space(context)
        if build is None:
            return "no active build directory."
        package = self.build_package(context)
        return package.validation_reason() if package is not None else "no active build package."

    def _stage_turn_context(self, ota_context: AmphiOTAContext, mode: str, stage: str) -> Tuple[AmphiOTAContext, Optional[int]]:
        """Project one stable Build-stage trace with its entry and switch context."""
        def switches_to_target(record: Any) -> bool:
            steps = _view(_view(record, "action_result"), "results") or []
            for step in steps:
                if _view(step, "tool_name") != "switch" or _view(step, "success") is False:
                    continue
                arguments = _view(step, "tool_arguments") or {}
                result = _view(step, "tool_result") or {}
                if str(_view(result, "stage") or _view(arguments, "stage") or "") == stage:
                    return True
            return False

        records = ota_context.ota_record
        scopes = [self._record_think_scope(record) for record in records]
        target_scope = (mode, stage)
        mode_indexes = [
            index for index, scope in enumerate(scopes)
            if scope is not None and scope[0] == mode
        ]
        # The first Build stage owns the pre-Build entry prefix. Keeping that
        # prefix on later stage re-entry makes persisted compaction boundaries
        # refer to the same projected-round coordinates for the whole Turn.
        selected = set(range(len(records))) if not mode_indexes else set()
        if mode_indexes and scopes[mode_indexes[0]] == target_scope:
            selected.update(range(mode_indexes[0]))
        transitions: List[int] = []
        for index, (record, scope) in enumerate(zip(records, scopes)):
            if scope == target_scope:
                selected.add(index)
            if switches_to_target(record):
                selected.add(index)
                transitions.append(index)
                continue
            next_scope = scopes[index + 1] if index + 1 < len(scopes) else target_scope
            if next_scope == target_scope and scope != target_scope:
                transitions.append(index)
                # A later cross-mode entry can carry the request that reopened
                # Build, so retain its immediate handoff round as well.
                if scope is None or scope[0] != mode:
                    selected.add(index)
        projected = [record for index, record in enumerate(records) if index in selected]
        turn_context = (
            ota_context
            if len(projected) == len(records)
            else ota_context.model_copy(update={"ota_record": projected})
        )
        return turn_context, transitions[-1] if transitions else None

    @staticmethod
    def build_space(context: AmphiContext) -> Optional[Any]:
        """Return the build resource bound during this turn's state initialization."""
        workspace = context.workspace
        build = workspace.build if workspace is not None else None
        return build if build is not None and build.is_available else None

    @classmethod
    def build_package(cls, context: AmphiContext) -> Optional[Any]:
        """Return the Workflow package bound alongside the active Build Space."""
        build = cls.build_space(context)
        if build is None:
            return None
        workflows = context.workflows
        if workflows is None:
            raise RuntimeError("Build space is bound without its Workflow library.")
        return workflows.require_package(build.root)
