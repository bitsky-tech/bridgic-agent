"""Cognitive worker for verifying a generated Workflow Build implementation."""

import re
from typing import List, Optional

from bridgic.amphibious import StepToolCall
from bridgic.core.model.types import Message, Role

from ..registry import cognitive_stage
from .base import BuildThink
from ..._context import AmphiContext, AmphiOTAContext
from ...prompts.build.verify import VERIFY_PERSONA


@cognitive_stage(mode="build", stage="verify", order=40)
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
        body = package.read_document("verify.md") if package is not None else None
        if not body:
            return (
                "confirm rejected: write verify.md with the isolated test scope, what "
                "actually ran, what was substituted or not run for safety, "
                "and the overall verification verdict before calling "
                "request_human_workflow_confirm."
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
