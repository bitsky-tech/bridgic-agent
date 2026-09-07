"""Cognitive worker for generating a reusable Workflow Build implementation."""

from typing import List, Optional

from bridgic.amphibious import StepToolCall
from bridgic.core.model.types import Message, Role

from ..registry import cognitive_stage
from .base import BuildThink
from ..._context import AmphiContext, AmphiOTAContext, _view
from ...prompts.build.generate import GENERATE_PERSONA


@cognitive_stage(mode="build", stage="generate", order=30)
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
