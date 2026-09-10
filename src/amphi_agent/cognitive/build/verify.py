"""Cognitive worker for verifying a generated Workflow Build implementation."""

import logging
import re
from typing import TYPE_CHECKING, Any, List, Optional

from bridgic.amphibious import OTARecord, StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ...security import Permission
from ..register import cognitive_stage
from .base import BuildThink
from ..base import render_input
from ....amphi_store import SessionTurnRecord, TurnStatus
from ..._tools import TOOL_LIBRARY
from ..state import CallVerdict
from .state import AwaitingWorkflowConfirm, BuildStageState
from ..normal.state import NormalStageState
from ...tools.build import RequestHumanWorkflowConfirm
from ...tools import switch_tool
from ..._context import AmphiContext, AmphiOTAContext
from ...prompts.build.verify import VERIFY_PERSONA


if TYPE_CHECKING:
    from ..._agent import AmphiAgent


logger = logging.getLogger(__name__)


@cognitive_stage(mode="build", stage="verify", order=40)
class VerifyThink(BuildThink):
    """Safely test the generated workflow against the task definition."""

    persona: str = VERIFY_PERSONA

    ############################################################################
    # The agent design
    ############################################################################
    async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: Optional[SessionTurnRecord], agent: "AmphiAgent") -> None:
        """Recover publication before reopening a Build that may already be removed."""
        awaiting_human = previous_turn is not None and previous_turn.status is TurnStatus.AWAITING_HUMAN
        interaction = ((previous_turn.agent_state or {}).get("interaction") or {}) if awaiting_human else {}
        user_input = ota_context.user_input
        input_type = user_input.get("type") if isinstance(user_input, dict) else getattr(user_input, "type", None)
        action = user_input.get("action") if isinstance(user_input, dict) else getattr(user_input, "action", None)
        confirming_workflow = (
            "workflow_confirm" in interaction
            and input_type == "workflow_confirm"
            and str(action or "").strip().lower() in {"confirm", "save_as_new"}
        )
        if not awaiting_human or "workflow_confirm" not in interaction:
            await super().init_state(ota_context, context, previous_turn, agent)
            return
        if not confirming_workflow:
            await self.sync_build_space(ota_context, context)

        async def _resume_workflow_confirm(ota_context: AmphiOTAContext, context: AmphiContext, pending_turn: SessionTurnRecord, original_user_input: Any) -> None:
            """Resume a parked workflow confirmation and save an approved Build.

            Parameters
            ----------
            ota_context : AmphiOTAContext
                Current attempt carrying the dedicated confirmation message.
            context : AmphiContext, optional
                Hydrated Session and Workspace context.
            pending_turn : SessionTurnRecord
                Awaiting Turn whose request and source id identify the Workflow.
            original_user_input : Any
                User input restored when the parked Turn resumes.
            """
            def field(name: str) -> Any:
                if isinstance(ota_context.user_input, dict):
                    return ota_context.user_input.get(name)
                return getattr(ota_context.user_input, name, None)

            pending = (pending_turn.agent_state.get("interaction") or {})["workflow_confirm"]
            input_type = field("type")
            if input_type not in {None, "chat", "workflow_confirm"}:
                raise RuntimeError("This Session is waiting for a workflow confirmation.")
            direct_reply = input_type != "workflow_confirm"
            if not direct_reply and field("request_id") != pending["request_id"]:
                raise RuntimeError("This workflow confirmation does not match the pending request.")

            user_message = render_input(ota_context.user_input).strip() if direct_reply else ""
            action = str(field("action") or "").strip().lower()
            save_as_new = not direct_reply and action == "save_as_new"
            confirmed = not direct_reply and action in {"confirm", "save_as_new"}
            source_workflow_id = pending.get("workflow_id")
            target_workflow_id = None if save_as_new else source_workflow_id
            publication_operation = (
                "create" if save_as_new else str(pending.get("operation") or "create")
            )
            workflow = None
            save_error: Optional[str] = None
            if confirmed:
                workflows = context.workflows
                workspace = context.workspace
                try:
                    if workflows is None or workspace is None:
                        raise RuntimeError("Workflow persistence is unavailable")
                    if target_workflow_id is None:
                        workflow = await workflows.find_materialized_workflow(pending_turn.id)
                    if workflow is None:
                        build = await workspace.prepare_build_space("resume")
                        if build.workflow_id != source_workflow_id:
                            raise RuntimeError(
                                "The active Build does not match the Workflow confirmation."
                            )
                        workflow = await workflows.materialize_workflow(
                            build.root,
                            workflow_id=target_workflow_id,
                            source_session_id=context.session.id,
                            source_turn_id=pending_turn.id,
                            name=str(field("name") or pending.get("default_name") or ""),
                            description=pending.get("summary"),
                        )
                except Exception as exc:  # noqa: BLE001 - save failure returns to Verify
                    logger.warning(
                        "Workflow confirmation save failed for session %s: %s",
                        context.session.id,
                        exc,
                    )
                    save_error = str(exc).strip() or type(exc).__name__

            if direct_reply:
                result: Any = {
                    **pending,
                    "status": "not_answered",
                    "user_message": user_message,
                    "message": (
                        "The user replied to the entire workflow confirmation card instead "
                        f"of choosing an action: {user_message}"
                    ),
                }
            elif workflow is not None:
                operation = "updated" if target_workflow_id is not None else "saved"
                result = {
                    **pending,
                    "operation": publication_operation,
                    "status": "confirmed",
                    "name": workflow.name,
                    "workflow_id": workflow.workflow_id,
                    "published_root": str(workflow.root.expanduser().resolve()),
                    "message": (
                        f"The user confirmed the workflow, and it was {operation} successfully "
                        f"as `{workflow.name}` (workflow id: `{workflow.workflow_id}`)."
                    ),
                }
            elif confirmed:
                result = {
                    **pending,
                    "operation": publication_operation,
                    "status": "save_failed",
                    "name": str(field("name") or pending.get("default_name") or ""),
                    "error": save_error,
                    "message": (
                        "The user approved the Workflow, but saving failed"
                        f"{': ' + save_error if save_error else ''}. "
                        "The Build remains open so Verify can correct or retry it."
                    ),
                }
            else:
                result = {
                    **pending,
                    "status": "cancelled",
                    "message": (
                        "The user cancelled the workflow confirmation. "
                        "The Build remains open for further changes."
                    ),
                }

            ota_context.ota_record = [OTARecord.model_validate(record) for record in pending_turn.ota_records]
            for rec in reversed(ota_context.ota_record):
                steps = (rec.action_result or {}).get("results") or []
                confirm = next((s for s in steps if s.get("tool_name") == "request_human_workflow_confirm"), None)
                if confirm is not None:
                    confirm["tool_result"] = result
                    break

            if workflow is not None:
                current = ota_context.think_status
                workspace = context.workspace
                if workspace is not None:
                    await workspace.discard_build()
                if isinstance(current, BuildStageState):
                    agent._stamp_mode_exit(
                        ota_context,
                        current,
                        str(result["message"]),
                        retained=False,
                    )
                agent._stamp_published_directory_handoff(
                    ota_context,
                    publication="The Workflow package under .build was published to",
                    published_directory=workflow.root,
                    relative_paths=(
                        "Package-relative paths are unchanged for task.md, explore.md, verify.md, "
                        "and workflow/. Other files from .build were not published and must not be "
                        "linked."
                    ),
                    temporary_workspace=".build",
                )
                ota_context.transition_think(NormalStageState())
                self.close_build_bindings(context)
            elif confirmed:
                await self.sync_build_space(ota_context, context)
            ota_context.transition_interaction(None)
            context.session = context.session.without_last()
            ota_context.user_input = original_user_input

        await _resume_workflow_confirm(
            ota_context, context, previous_turn, agent._renderable_user_input(previous_turn.user_input),
        )

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
    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict], agent: "AmphiAgent") -> List[CallVerdict]:
        """Apply inherited admission rules, then this worker's business constraints."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts, agent)
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
