"""Cognitive workers for the staged Workflow Build mode."""

import re
from typing import Any, Dict, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.model.types import Message, Role

from .._cognitive import MainThink
from .._context import AmphiContext, AmphiOTAContext, _view
from .._skills import Skill, SkillGroup
from ..prompts.build import (
    CLARIFY_PERSONA,
    EXPLORE_PERSONA,
    GENERATE_PERSONA,
    VERIFY_PERSONA,
)
from ..prompts.render import render_stage_persona
from ..tools import switch_tool

__all__ = [
    "BuildThink",
    "ClarifyThink",
    "ExploreThink",
    "GenerateThink",
    "VerifyThink",
]


################################################################################################################
# Build thinking chain — stage workers (same mechanics as MainThink, different frame)
################################################################################################################
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
                "validation check, and dependency.",
            ])
        else:
            operation_lines = [
                "Operation: create",
                "Workflow id: (none; allocated after final confirmation)",
                "Baseline: New Workflow; no saved baseline is being edited.",
            ]
        operation_lines.append(
            "Acceptance review: "
            + ("presented" if build.acceptance_review_presented else "not presented")
            + ". task.md is the sole durable source of truth for acceptance criteria."
        )
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


class ClarifyThink(BuildThink):
    """Clarify requirements and maintain this build's task definition."""

    persona: str = CLARIFY_PERSONA
    allowed_tools = BuildThink.allowed_tools | {
        "request_accept_rule",
        "request_human_task_confirm",
    }

    _MERMAID_DIAGRAM_TYPES = frozenset({
        "architecture-beta", "block-beta", "classdiagram", "erdiagram", "gantt",
        "gitgraph", "journey", "kanban", "mindmap", "packet-beta", "pie",
        "quadrantchart", "radar-beta", "requirementdiagram", "sankey-beta",
        "sequencediagram", "statediagram", "statediagram-v2", "timeline",
        "treemap-beta", "xychart-beta", "zenuml",
    })

    async def assemble_messages(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Message]:
        """Assemble clarify's model messages.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active build turn and its current action trace.
        context : AmphiContext
            Session context for this Build turn.

        Returns
        -------
        List[Message]
            Persona, live context, stage-scoped conversation, user input, and
            turn trace.

        Notes
        -----
        The returned messages have this shape::

            SYSTEM  clarify persona
                    + <context> containing transcript, skills, artifacts, memory,
                      Build workspace, and Session workspace
            ...     persisted session messages in their native roles
            USER    current user input
            ...     current-Clarify assistant and tool-result messages

        """
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.build_context_blocks(
            ota_context,
            context,
            "task.md",
        )
        umbrella = "<context>\n" + "\n\n".join(b for b in blocks if b) + "\n</context>"
        system = self.assemble_system(
            ota_context,
            context,
            self.system_block(ota_context, context),
            umbrella,
        )

        turn_context, _ = self._stage_turn_context(
            ota_context,
            "build",
            "clarify",
        )

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(turn_context, context)
        return messages

    async def legality_check(
        self,
        call: StepToolCall,
        ota_context: Optional[AmphiOTAContext],
        context: AmphiContext,
    ) -> Optional[str]:
        """Check whether clarify may execute a control-flow tool.

        Parameters
        ----------
        call : StepToolCall
            Proposed tool call.
        ota_context : Optional[AmphiOTAContext]
            Active turn carrying the build identifier.
        context : AmphiContext
            Session context carrying the workspace.

        Returns
        -------
        Optional[str]
            ``None`` when legal; otherwise an actionable rejection reason.
        """
        tool_name = getattr(call, "tool", None)
        if tool_name == "request_accept_rule":
            build = self.build_space(context)
            if build is None:
                return "acceptance review rejected: there is no active Build."
            if build.acceptance_review_presented:
                return (
                    "acceptance review rejected: this Build already has its one-time "
                    "acceptance outline; refine task.md and the validation design around "
                    "that outline instead of presenting another review."
                )
            return None
        if tool_name == "request_human_task_confirm":
            reason = self.task_validation_reason(context)
            if reason:
                return f"task confirmation rejected: {reason}"
            build = self.build_space(context)
            if build is None or not build.acceptance_review_presented:
                return (
                    "task confirmation rejected: call request_accept_rule and obtain "
                    "the one-time acceptance outline first."
                )
            return None
        if tool_name != "switch":
            return None

        arguments = {
            _view(argument, "name"): _view(argument, "value")
            for argument in getattr(call, "tool_arguments", None) or []
        }
        if arguments.get("mode") == "normal":
            return None
        target_stage = next(
            (
                _view(argument, "value")
                for argument in reversed(getattr(call, "tool_arguments", None) or [])
                if _view(argument, "name") == "stage"
            ),
            None,
        )
        if target_stage is None:
            return None
        reason = self.task_validation_reason(context)
        if reason:
            return f"switch rejected: {reason}"
        return (
            "switch rejected: task.md must be reviewed by the user before Explore. "
            "Call request_human_task_confirm instead; the system advances after confirmation."
        )

    def task_validation_reason(self, context: AmphiContext) -> Optional[str]:
        """Validate the current task definition and any Mermaid diagrams it contains."""
        def diagram_reason(source: str) -> Optional[str]:
            lines = [
                (number, line.strip())
                for number, line in enumerate(source.splitlines(), start=1)
                if line.strip() and not line.lstrip().startswith("%%")
            ]
            if not lines:
                return "the diagram is empty."

            header = lines[0][1]
            kind = header.split(maxsplit=1)[0].casefold().rstrip(";")
            flowchart = kind in {"flowchart", "graph"}
            if flowchart:
                if not re.fullmatch(
                    r"(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\s*;?",
                    header,
                    re.IGNORECASE,
                ):
                    return "declare a valid flow direction, for example `flowchart TD`."
            elif kind not in self._MERMAID_DIAGRAM_TYPES and not kind.startswith("c4"):
                return f"`{header}` is not a recognized Mermaid diagram declaration."
            if len(lines) == 1:
                return "the diagram has a declaration but no content."

            pairs = {")": "(", "]": "[", "}": "{"}
            stack: List[Tuple[str, int]] = []
            quoted = False
            escaped = False
            for line_number, line in enumerate(source.splitlines(), start=1):
                if line.lstrip().startswith("%%"):
                    continue
                for character in line:
                    if escaped:
                        escaped = False
                    elif character == "\\" and quoted:
                        escaped = True
                    elif character == '"':
                        quoted = not quoted
                    elif not quoted and character in "([{":
                        stack.append((character, line_number))
                    elif not quoted and character in pairs:
                        if not stack or stack[-1][0] != pairs[character]:
                            return f"line {line_number} has an unmatched `{character}`."
                        stack.pop()
            if quoted:
                return "a double-quoted label is not closed."
            if stack:
                opener, line_number = stack[-1]
                return f"line {line_number} has an unmatched `{opener}`."

            if flowchart:
                open_subgraphs = 0
                edge = r"(?:<-->|<==>|-->|---|-\.->|==>|~~~|--[ox]|[ox]--[ox])"
                for line_number, line in lines[1:]:
                    if re.match(r"^subgraph(?:\s|$)", line, flags=re.IGNORECASE):
                        open_subgraphs += 1
                    elif line.casefold().rstrip(";") == "end":
                        if open_subgraphs == 0:
                            return f"line {line_number} has an unmatched `end`."
                        open_subgraphs -= 1
                    dangling = re.match(rf"^{edge}", line) or re.search(
                        rf"{edge}(?:\|[^|]*\|)?\s*;?$",
                        line,
                    )
                    if dangling:
                        return f"line {line_number} has a connector without nodes on both sides."
                if open_subgraphs:
                    return "a `subgraph` block is missing its closing `end`."
            return None

        package = self.build_package(context)
        body = package.read_document("task.md") if package is not None else None
        if not body:
            return "write task.md before requesting confirmation."
        document_reason = self.human_document_reason("task.md", body)
        if document_reason:
            return document_reason

        diagrams: List[Tuple[int, str]] = []
        fence: Optional[str] = None
        start_line = 0
        source: List[str] = []

        for line_number, line in enumerate(body.splitlines(), start=1):
            stripped = line.strip()
            if fence is None:
                opening = re.fullmatch(r"(`{3,})\s*mermaid\s*", stripped, flags=re.IGNORECASE)
                if opening:
                    fence = opening.group(1)
                    start_line = line_number
                    source = []
                elif re.match(r"`{3,}.*\bmermaid\b", stripped, flags=re.IGNORECASE):
                    return (
                        f"task.md line {line_number} has an invalid Mermaid fence; "
                        "use a standalone ```mermaid opening fence."
                    )
                continue

            if stripped == fence:
                diagrams.append((start_line, "\n".join(source)))
                fence = None
                source = []
            elif stripped.startswith(fence):
                return (
                    f"task.md line {line_number} has an invalid Mermaid closing fence; "
                    f"close the block with {fence} on its own line."
                )
            else:
                source.append(line)

        if fence is not None:
            return f"the Mermaid block opened at task.md line {start_line} is not closed."

        for index, (line_number, diagram) in enumerate(diagrams, start=1):
            reason = diagram_reason(diagram)
            if reason:
                return f"Mermaid diagram {index} at task.md line {line_number}: {reason}"
        return None


class ExploreThink(BuildThink):
    """Explore and record this build's implementation plan."""

    persona: str = EXPLORE_PERSONA
    allowed_tools = BuildThink.allowed_tools

    def select_skills(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> Dict[str, Skill]:
        """Select enabled Skills plus the Explore-only built-in ``how-to``."""
        selected = super().select_skills(ota_context, context)
        skills = context.skills
        how_to = skills.all_data().get("how-to") if skills is not None else None
        if how_to is not None and how_to.group is SkillGroup.BUILTIN:
            selected["how-to"] = how_to
        return selected

    async def assemble_messages(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Message]:
        """Assemble explore's model messages.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active build turn and its current action trace.
        context : AmphiContext
            Session context for this Build turn.

        Returns
        -------
        List[Message]
            Persona, live context, Session history, task artifact, user input,
            and the current Explore trace.
        """
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.build_context_blocks(
            ota_context,
            context,
            "task.md",
        )
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = self.assemble_system(
            ota_context,
            context,
            self.system_block(ota_context, context),
            umbrella,
        )

        turn_context, _ = self._stage_turn_context(
            ota_context,
            "build",
            "explore",
        )

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(turn_context, context)
        return messages

    async def legality_check(
        self,
        call: StepToolCall,
        ota_context: Optional[AmphiOTAContext],
        context: AmphiContext,
    ) -> Optional[str]:
        """Check whether explore may execute a control-flow tool.

        Parameters
        ----------
        call : StepToolCall
            Proposed tool call.
        ota_context : Optional[AmphiOTAContext]
            Active turn carrying the build identifier.
        context : AmphiContext
            Session context carrying the workspace.

        Returns
        -------
        Optional[str]
            ``None`` when legal; otherwise an actionable rejection reason.
        """
        if getattr(call, "tool", None) != "switch":
            return None

        target_stage = next(
            (
                _view(argument, "value")
                for argument in reversed(getattr(call, "tool_arguments", None) or [])
                if _view(argument, "name") == "stage"
            ),
            None,
        )
        if target_stage != "generate":
            return None
        package = self.build_package(context)
        body = package.read_document("explore.md") if package is not None else None
        if body:
            reason = self.human_document_reason("explore.md", body)
            return f"switch rejected: {reason}" if reason else None
        return (
            "switch rejected: write explore.md before handing off to "
            "generate; it is the operation sequence generate builds from. Create "
            "explore.md now as a complete, non-empty file, then call switch "
            "again."
        )


class GenerateThink(BuildThink):
    """Generate a reusable workflow from this build's implementation plan."""

    persona: str = GENERATE_PERSONA
    allowed_tools = BuildThink.allowed_tools

    async def assemble_messages(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Message]:
        """Assemble generate's model messages.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active build turn and its current action trace.
        context : AmphiContext
            Session context for this Build turn.

        Returns
        -------
        List[Message]
            Persona, live context, Session history, upstream artifacts, user
            input, and the current Generate trace.
        """
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.build_context_blocks(
            ota_context,
            context,
            "task.md",
            "explore.md",
        )
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = self.assemble_system(
            ota_context,
            context,
            self.system_block(ota_context, context),
            umbrella,
        )

        turn_context, _ = self._stage_turn_context(
            ota_context,
            "build",
            "generate",
        )

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(turn_context, context)
        return messages

    async def legality_check(
        self,
        call: StepToolCall,
        ota_context: Optional[AmphiOTAContext],
        context: AmphiContext,
    ) -> Optional[str]:
        """Check whether generate may execute a control-flow tool.

        Parameters
        ----------
        call : StepToolCall
            Proposed tool call.
        ota_context : Optional[AmphiOTAContext]
            Active turn carrying the build identifier.
        context : AmphiContext
            Session context carrying the workspace.

        Returns
        -------
        Optional[str]
            ``None`` when legal; otherwise an actionable rejection reason.
        """
        if getattr(call, "tool", None) != "switch":
            return None

        target_stage = next(
            (
                _view(argument, "value")
                for argument in reversed(getattr(call, "tool_arguments", None) or [])
                if _view(argument, "name") == "stage"
            ),
            None,
        )
        if target_stage != "verify":
            return None

        reason = self.workflow_validation_reason(context)
        return f"switch rejected: {reason}" if reason else None


class VerifyThink(BuildThink):
    """Safely test the generated workflow against the task definition."""

    persona: str = VERIFY_PERSONA
    allowed_tools = BuildThink.allowed_tools | {"request_human_workflow_confirm"}

    async def assemble_messages(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Message]:
        """Assemble verify's model messages.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active build turn and its current action trace.
        context : AmphiContext
            Session context for this Build turn.

        Returns
        -------
        List[Message]
            Persona, live context, Session history, upstream artifacts, user
            input, and the current Verify trace.
        """
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.build_context_blocks(
            ota_context,
            context,
            "task.md",
            "explore.md",
            "verify.md",
        )
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = self.assemble_system(
            ota_context,
            context,
            self.system_block(ota_context, context),
            umbrella,
        )

        turn_context, _ = self._stage_turn_context(
            ota_context,
            "build",
            "verify",
        )

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(turn_context, context)
        return messages

    async def legality_check(
        self,
        call: StepToolCall,
        ota_context: Optional[AmphiOTAContext],
        context: AmphiContext,
    ) -> Optional[str]:
        """Check whether verify may execute a control-flow tool.

        Parameters
        ----------
        call : StepToolCall
            Proposed tool call.
        ota_context : Optional[AmphiOTAContext]
            Active turn carrying the build identifier.
        context : AmphiContext
            Session context carrying the workspace.

        Returns
        -------
        Optional[str]
            ``None`` when legal; otherwise an actionable rejection reason.
        """
        if getattr(call, "tool", None) != "request_human_workflow_confirm":
            return None

        package = self.build_package(context)
        execution_only = bool(package and package.validation_disabled)
        body = package.read_document("verify.md") if package is not None else None
        if not body:
            return (
                "confirm rejected: write verify.md with the isolated test scope, what "
                "actually ran, what was substituted or not run for safety, "
                + (
                    "and the execution-only verification verdict before "
                    if execution_only
                    else "and a result or explicit safety limitation for every runtime "
                    "acceptance check in VALIDATE.md before "
                )
                + "calling request_human_workflow_confirm."
            )
        document_reason = self.human_document_reason("verify.md", body)
        if document_reason:
            return f"confirm rejected: {document_reason}"

        def overall_verdict() -> Optional[str]:
            """Read a localized overall-verdict section at the document tail."""
            lines = [line.strip() for line in body.splitlines() if line.strip()]
            if len(lines) < 2 or not re.fullmatch(r"##\s+\S.*", lines[-2]):
                return None
            return lines[-1].upper()

        if overall_verdict() != "PASS":
            return (
                "confirm rejected: verify.md must end with a level-two heading meaning "
                "Overall verdict in the document language, followed by `PASS`. Do not "
                "mark PASS while safely testable behavior failed, Verify changed actual "
                "external state, or a safety limitation was hidden."
            )
        reason = self.workflow_validation_reason(context)
        return f"confirm rejected: {reason}" if reason else None
