"""Cognitive worker for verifying a generated Workflow Build implementation."""

import re
from typing import TYPE_CHECKING, List, Optional

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ...security import Permission
from ..register import cognitive_stage
from .base import BuildThink
from ..._tools import TOOL_LIBRARY
from ..._state import CallVerdict, AwaitingWorkflowConfirm, BuildStageState
from ...tools.build import RequestHumanWorkflowConfirm
from ...tools import switch_tool
from ..._context import AmphiContext, AmphiOTAContext
from ...prompts.build.verify import VERIFY_PERSONA


if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="build", stage="verify", order=40)
class VerifyThink(BuildThink):
    """Safely test the generated workflow against the task definition."""

    persona: str = VERIFY_PERSONA

    ############################################################################
    # The agent design
    ############################################################################
    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Prepare this stage's confirmation payload and park for user review."""
        await super().handle_action_result(ota_context, context, agent)

        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "request_human_workflow_confirm":
                result = step.tool_result
                if isinstance(result, RequestHumanWorkflowConfirm):
                    think = ota_context.think_status
                    workflow_id = think.workflow_id if isinstance(think, BuildStageState) else None
                    workflows = context.workflows
                    workflow = workflows.get(workflow_id) if workflows is not None and workflow_id else None
                    payload = {
                        "request_id": result.request_id,
                        "default_name": workflow.name if workflow is not None else result.default_name,
                        "summary": result.summary,
                        "operation": "edit" if workflow_id else "create",
                        "workflow_id": workflow_id,
                        "status": "pending",
                    }
                    ota_context.transition_interaction(AwaitingWorkflowConfirm(workflow_confirm=payload))
                    step.tool_result = payload

    ############################################################################
    # Dynamic prompt assembly
    ############################################################################
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
        system = "\n\n".join(block for block in (
            self.system_block(ota_context, context), umbrella,
        ) if block)

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

    ############################################################################
    # Legality check
    ############################################################################
    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict]) -> List[CallVerdict]:
        """Apply inherited admission rules, then this worker's business constraints."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts)
        resolved = self._exclusive_call_verdicts(calls, resolved, {"request_human_workflow_confirm"})

        def reason_for_call(call: StepToolCall) -> Optional[str]:
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

    ############################################################################
    # Tools and Skills selection
    ############################################################################
    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Add this stage's confirmation tool without changing catalogue order."""
        tools = super().select_tools(ota_context, context)
        names = [tool.tool_name for tool in tools]
        return [*TOOL_LIBRARY.select([*names, "request_human_workflow_confirm"]), switch_tool]
