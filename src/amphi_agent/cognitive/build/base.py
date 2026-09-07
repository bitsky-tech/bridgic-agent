"""Shared capabilities and history policy for Workflow Build stages."""

import re
from typing import Any, List, Optional, Tuple

from ..base import MainThink
from ..._context import AmphiContext, AmphiOTAContext, _view
from ...prompts.render import render_stage_persona
from ...tools import switch_tool


class BuildThink(MainThink):
    """Provide the shared history policy and capabilities for Build stages.

    Notes
    -----
    Concrete Thinks keep their own prompt assembly and legality checks. This
    base centralizes Build history projection, stable paths, artifact rendering,
    and tool access.
    """

    allowed_tools: frozenset[str] = (
        MainThink.allowed_tools
        - frozenset({
            "edit_workflow",
            "help",
            "request_presentation",
            "request_run_workflow",
            "remove_workflow",
            "start_subagent",
            "create_schedule",
            "delete_schedule",
            "get_schedule",
            "list_schedules",
            "update_schedule",
        })
    )

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

    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render the Build-stage persona with its exact current ToolSurface."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona(
            [tool.tool_name for tool in tools],
            template=self.persona,
        ).strip()

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

    def select_tools(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Any]:
        """Return this stage's gated tools plus the build switch."""
        tools = super().select_tools(ota_context, context)
        return [*tools, switch_tool]
