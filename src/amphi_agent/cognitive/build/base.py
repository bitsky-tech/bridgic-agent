"""Shared capabilities and history policy for Workflow Build stages."""

import json
import re
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple
from uuid import uuid4

from bridgic.amphibious import ActionStepResult, StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec

from ..base import BaseThink
from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ...security import Permission
from ..._state import CallVerdict, AwaitingBuildConfirm, AwaitingBuildConflict, BuildStageState, NormalStageState
from ..._tools import TOOL_LIBRARY
from ...prompts.render import render_stage_persona
from ...tools import FILE_SYSTEM_TOOL_NAMES, switch_tool
from ...tools.build import RequestBuild
from ....amphi_service.i18n import backend_i18n

if TYPE_CHECKING:
    from ..._agent import AmphiAgent


def build_request_legality_reason(call: StepToolCall, context: AmphiContext) -> Optional[str]:
    """Require a concrete reason when a Build proposal conflicts with retained work."""
    if getattr(call, "tool", None) != "request_build":
        return None
    arguments = {
        _view(argument, "name"): _view(argument, "value")
        for argument in getattr(call, "tool_arguments", None) or []
    }
    if arguments.get("mode", "ask") != "ask":
        return None
    workspace = context.workspace
    retained = workspace.build_checkpoint() if workspace is not None else None
    if retained is not None and not str(arguments.get("reason") or "").strip():
        return (
            "request_build rejected: mode `ask` requires a concrete reason "
            "when resolving an unfinished Build conflict."
        )
    return None


async def handle_build_request(step: ActionStepResult, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
    """Resolve a Build entry request from normal mode or an active Build stage."""
    def requested_edit_workflow_id() -> Optional[str]:
        """Return the most recent successful edit target from this Agent turn."""
        def value(item: Any, name: str) -> Any:
            return item.get(name) if isinstance(item, dict) else getattr(item, name, None)

        for record in reversed(ota_context.ota_record):
            steps = value(value(record, "action_result"), "results") or []
            for step in reversed(steps):
                if value(step, "tool_name") != "edit_workflow" or not value(step, "success"):
                    continue
                result = value(step, "tool_result")
                workflow_id = result.get("workflow_id") if isinstance(result, dict) else None
                return str(workflow_id or "").strip() or None
        return None

    def build_request_interaction(context: AmphiContext, request: RequestBuild, *, requested_workflow_id: Optional[str] = None) -> AwaitingBuildConflict:
        """Create the unfinished-Build interaction requested through ``request_build``."""
        def card_option(prefix: str, option_id: str) -> dict:
            """One choice-card option. Id, label and description all derive from the catalog
            by naming convention (``{prefix}.option_{id}`` / ``{prefix}.desc_{id}``), so the
            id ↔ copy coupling is structural — pairing an id with another option's label
            can no longer happen by hand-copied dict drift."""
            return {
                "id": option_id,
                "label": backend_i18n.text(f"{prefix}.option_{option_id}"),
                "description": backend_i18n.text(f"{prefix}.desc_{option_id}"),
            }

        workspace = context.workspace
        checkpoint = workspace.build_checkpoint() if workspace is not None else None
        if checkpoint is None:
            raise RuntimeError("Cannot ask about an unfinished Build when none is retained.")
        reason = (request.reason or "").strip()
        if not reason:
            raise ValueError("request_build mode `ask` requires a conflict reason for an unfinished Build.")
        existing_stage = checkpoint.stage
        existing_workflow_id = checkpoint.workflow_id
        if requested_workflow_id:
            question = backend_i18n.text("agent.build_conflict.question_replace", reason=reason)
            options = [
                card_option("agent.build_conflict", "keep"),
                card_option("agent.build_conflict", "replace_edit"),
            ]
        else:
            question = backend_i18n.text("agent.build_conflict.question_new", reason=reason)
            options = [
                card_option("agent.build_conflict", "keep"),
                card_option("agent.build_conflict", "merge"),
                card_option("agent.build_conflict", "replace_new"),
            ]
        conflict = AwaitingBuildConflict(
            existing_stage=existing_stage,
            existing_workflow_id=existing_workflow_id,
            requested_workflow_id=requested_workflow_id,
            reason=reason,
            request_id=request.request_id or f"build_conflict_{uuid4().hex}",
            questions=[{
                "question": question,
                "header": backend_i18n.text("agent.build_conflict.header"),
                "options": options,
                "multiSelect": False,
            }],
        )
        agent._close_build_bindings(context)
        return conflict

    result = step.tool_result
    if isinstance(result, RequestBuild):
        if result.mode == "start":
            workflow_id = requested_edit_workflow_id()
            ota_context.transition_think(BuildStageState(
                stage="clarify",
                workflow_id=workflow_id,
            ))
            await agent._sync_build_space(ota_context, context, create=True)
            step.tool_result = {
                "mode": "start",
                "goal": result.goal,
                **({"workflow_id": workflow_id} if workflow_id else {}),
                "message": "The user's explicit Workflow request entered a new Build.",
            }
        else:
            workspace = context.workspace
            retained = workspace.build_checkpoint() if workspace is not None else None
            if retained is None:
                step.tool_result = {
                    "mode": "ask",
                    "request_id": result.request_id,
                    "goal": result.goal,
                    "reason": result.reason,
                    "status": "pending",
                }
                ota_context.transition_interaction(AwaitingBuildConfirm(
                    request_id=result.request_id,
                    goal=result.goal,
                    reason=result.reason,
                ))
            else:
                conflict = build_request_interaction(
                    context,
                    result,
                    requested_workflow_id=requested_edit_workflow_id(),
                )
                ota_context.transition_interaction(conflict)
                step.tool_result = {
                    "mode": "ask",
                    "goal": result.goal,
                    **conflict.model_dump(mode="json"),
                    "status": "pending",
                }


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
    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Apply Build entry and stage transitions after an admitted tool succeeds."""
        await super().handle_action_result(ota_context, context, agent)

        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "request_build":
                await handle_build_request(step, ota_context, context, agent)
            elif step.tool_name == "switch":
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
                    await agent._sync_build_space(ota_context, context)
                elif isinstance(next_status, NormalStageState):
                    agent._stamp_mode_exit(ota_context, current_status, sig.get("reason"))
                    agent._close_build_bindings(context)

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
    # Legality check
    ############################################################################
    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict]) -> List[CallVerdict]:
        """Validate Build entry proposals and explicit stage handoffs."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts)
        resolved = self._exclusive_call_verdicts(calls, resolved, {"request_build"})
        for index, (call, verdict) in enumerate(zip(calls, resolved)):
            if verdict.verdict == Permission.DENY.value:
                continue
            reason = build_request_legality_reason(call, context)
            if reason is None and getattr(call, "tool", None) == "switch" and ota_context is not None:
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
                "request_build",
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
