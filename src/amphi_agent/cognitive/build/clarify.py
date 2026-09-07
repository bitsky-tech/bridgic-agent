"""Cognitive worker for clarifying Workflow Build requirements."""

import re
from typing import List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.model.types import Message, Role

from .base import BuildThink
from ..._context import AmphiContext, AmphiOTAContext, _view
from ...prompts.build.clarify import CLARIFY_PERSONA


class ClarifyThink(BuildThink):
    """Clarify requirements and maintain this build's task definition."""

    persona: str = CLARIFY_PERSONA
    allowed_tools = BuildThink.allowed_tools | {
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
