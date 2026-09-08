"""Cognitive worker for clarifying Workflow Build requirements."""

import re
from typing import TYPE_CHECKING, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ...security import Permission
from ..register import cognitive_stage
from .base import BuildThink
from ..._tools import TOOL_LIBRARY
from ..._state import CallVerdict, AwaitingTaskConfirm, BuildStageState
from ...tools.build import RequestHumanTaskConfirm
from ...tools import switch_tool
from ..._context import AmphiContext, AmphiOTAContext, _view
from ...prompts.build.clarify import CLARIFY_PERSONA


if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="build", stage="clarify", order=10)
class ClarifyThink(BuildThink):
    """Clarify requirements and maintain this build's task definition."""

    persona: str = CLARIFY_PERSONA

    _MERMAID_DIAGRAM_TYPES = frozenset({
        "architecture-beta", "block-beta", "classdiagram", "erdiagram", "gantt",
        "gitgraph", "journey", "kanban", "mindmap", "packet-beta", "pie",
        "quadrantchart", "radar-beta", "requirementdiagram", "sankey-beta",
        "sequencediagram", "statediagram", "statediagram-v2", "timeline",
        "treemap-beta", "xychart-beta", "zenuml",
    })

    ############################################################################
    # The agent design
    ############################################################################
    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Prepare this stage's confirmation payload and park for user review."""
        await super().handle_action_result(ota_context, context, agent)

        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "request_human_task_confirm":
                result = step.tool_result
                if isinstance(result, RequestHumanTaskConfirm):
                    workspace = context.workspace
                    build = workspace.build if workspace is not None else None
                    think = ota_context.think_status
                    workflow_id = think.workflow_id if isinstance(think, BuildStageState) else None
                    workflows = context.workflows
                    task_markdown = (
                        workflows.require_package(build.root).read_document("task.md")
                        if workflows is not None and build is not None
                        else ""
                    )
                    previous_confirmation = (
                        build.last_task_confirmation if build is not None else None
                    )
                    previous_task_markdown = (
                        previous_confirmation["task_markdown"]
                        if previous_confirmation is not None
                        else None
                    )
                    if previous_task_markdown is None:
                        previous_task_markdown = (
                            build.edit_task_baseline
                            if build is not None and workflow_id is not None
                            else ""
                        )
                    payload = {
                        "request_id": result.request_id,
                        "task_markdown": task_markdown,
                        "previous_task_markdown": previous_task_markdown,
                        "operation": "edit" if workflow_id else "create",
                        "workflow_id": workflow_id,
                        "original_task_markdown": (
                            build.edit_task_baseline
                            if build is not None and workflow_id is not None
                            else None
                        ),
                        "status": "pending",
                    }
                    ota_context.transition_interaction(AwaitingTaskConfirm(task_confirm=payload))
                    step.tool_result = payload

    ############################################################################
    # Dynamic prompt assembly
    ############################################################################
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
        system = "\n\n".join(block for block in (
            self.system_block(ota_context, context), umbrella,
        ) if block)

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

    ############################################################################
    # Legality check
    ############################################################################
    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict]) -> List[CallVerdict]:
        """Apply inherited admission rules, then this worker's business constraints."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts)
        resolved = self._exclusive_call_verdicts(calls, resolved, {"request_human_task_confirm"})

        def reason_for_call(call: StepToolCall) -> Optional[str]:
            tool_name = getattr(call, "tool", None)
            if tool_name == "request_human_task_confirm":
                reason = self.task_validation_reason(context)
                if reason:
                    return f"task confirmation rejected: {reason}"
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

        for index, (call, verdict) in enumerate(zip(calls, resolved)):
            if verdict.verdict == Permission.DENY.value:
                continue
            reason = reason_for_call(call)
            if reason:
                resolved[index] = verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
        return resolved

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

    ############################################################################
    # Tools and Skills selection
    ############################################################################
    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Add this stage's confirmation tool without changing catalogue order."""
        tools = super().select_tools(ota_context, context)
        names = [tool.tool_name for tool in tools]
        return [*TOOL_LIBRARY.select([*names, "request_human_task_confirm"]), switch_tool]
