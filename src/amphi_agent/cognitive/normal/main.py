"""Normal-mode prompt, tool policy, and Workflow entry checks."""

import json
from typing import TYPE_CHECKING, Any, Dict, List, Optional
from uuid import uuid4

from bridgic.amphibious import ActionStepResult, OTARecord, StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ..._state import CallVerdict, AwaitingBuildConfirm, AwaitingBuildConflict, AwaitingWorkflowRunChoice, BuildStageState, NormalStageState, PresentationStageState
from ..._tools import TOOL_LIBRARY
from ...prompts.normal.main import PERSONA
from ...prompts.render import render_main_persona
from ...tools import FILE_SYSTEM_TOOL_NAMES
from ...tools.ppt import RequestPresentation
from ...tools._workflow import EditWorkflow
from ...tools.workflow import RequestRunWorkflow
from ...tools.build import RequestBuild
from ....amphi_service.i18n import backend_i18n
from ....amphi_store import SessionTurnRecord, TurnStatus
from ..base import BaseThink, render_input
from ..build.base import BuildThink
from ..workflow.base import WorkflowRunThink
from ...security import Permission
from ..register import cognitive_stage
from ..presentation.base import PresentationThink
from ..presentation.shared import PRESENTATION_STAGE_ORDER

if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="normal", stage="main", order=10)
class MainThink(BaseThink):
    """Run ordinary conversation with the Main persona and entry policies."""

    persona: str = PERSONA

    ############################################################################
    # The agent design
    ############################################################################
    async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: Optional[SessionTurnRecord], agent: "AmphiAgent") -> None:
        """Resolve entry confirmations and unfinished-work choices owned by Main."""
        if previous_turn is None or previous_turn.status is not TurnStatus.AWAITING_HUMAN:
            await super().init_state(ota_context, context, previous_turn, agent)
            return
        dump = previous_turn.ota_context_dump()
        interaction = (dump.get("state") or {}).get("interaction") or {}
        if not (
            interaction.get("build_confirm") is True
            or interaction.get("build_conflict") is True
            or interaction.get("workflow_run_choice") is True
        ):
            await super().init_state(ota_context, context, previous_turn, agent)
            return
        rounds = dump.get("ota_record") or []
        original_user_input = agent._renderable_user_input(previous_turn.user_input)

        async def resume_build_confirm() -> None:
            """Resume Main after the user accepts or declines a Build proposal."""
            def field(name: str) -> Any:
                if isinstance(ota_context.user_input, dict):
                    return ota_context.user_input.get(name)
                return getattr(ota_context.user_input, name, None)

            pending = AwaitingBuildConfirm.model_validate(previous_turn.agent_state.get("interaction") or {})
            ota_context.ota_record = [OTARecord.model_validate(record) for record in previous_turn.ota_records]
            request = ota_context.ota_record[-1].action_result["results"][0]
            input_type = field("type")
            if input_type not in {None, "chat", "build_confirm"}:
                raise RuntimeError("This Session is waiting for a Build confirmation.")
            if input_type != "build_confirm":
                user_message = render_input(ota_context.user_input).strip()
                payload = request.get("tool_result")
                payload = dict(payload) if isinstance(payload, dict) else pending.model_dump()
                payload.update({
                    "status": "not_answered",
                    "user_message": user_message,
                    "message": (
                        "The user replied to the entire Build confirmation card instead "
                        f"of choosing an action: {user_message}"
                    ),
                })
                request["tool_result"] = payload
                ota_context.transition_interaction(None)
                context.session = context.session.without_last()
                ota_context.user_input = original_user_input
                return
            if field("request_id") != pending.request_id:
                raise RuntimeError("This Build confirmation does not match the pending request.")

            confirmed = field("action") == "confirm"
            message = (
                "The user chose to keep this as a one-off task. Continue the original request in Main."
            )
            if confirmed:
                ota_context.transition_think(BuildStageState(stage="clarify"))
                await BuildThink.sync_build_space(ota_context, context, create=True)
                message = (
                    "The user confirmed that this task should become a reusable Workflow. "
                    "A new Build was created; clarify the Workflow definition."
                )
            request["tool_result"].update({
                "status": "confirmed" if confirmed else "cancelled",
                "message": message,
            })

            ota_context.transition_interaction(None)
            context.session = context.session.without_last()
            ota_context.user_input = original_user_input

        async def resume_build_conflict() -> None:
            """Apply a Build-domain choice or fold a free-form reply into Build Think."""
            workspace = context.workspace
            if workspace is None:
                raise RuntimeError("Cannot resolve a Build conflict without a Workspace.")
            ota_context.ota_record = [OTARecord.model_validate(record) for record in rounds]

            selected_action = self._choice_selection(
                ota_context.user_input,
                request_id=conflict.request_id,
                questions=conflict.questions,
                allowed={"keep", "merge", "replace_edit", "replace_new"},
            )
            user_message = (
                self._option_label(conflict.questions, selected_action)
                if selected_action is not None
                else self._choice_reply_text(ota_context.user_input, conflict.questions)
            )
            if selected_action == "keep":
                ota_context.transition_think(BuildStageState(
                    stage=conflict.existing_stage,
                    workflow_id=conflict.existing_workflow_id,
                ))
                await BuildThink.sync_build_space(ota_context, context)
                action = "keep"
                message = (
                    "The user chose to continue the existing unfinished Build. Ignore the "
                    "competing Build request that triggered this choice."
                )
            elif selected_action == "merge":
                ota_context.transition_think(BuildStageState(
                    stage="clarify",
                    workflow_id=conflict.existing_workflow_id,
                ))
                await BuildThink.sync_build_space(ota_context, context)
                action = "merge"
                message = (
                    "The user chose to merge the latest requirements into the unfinished "
                    "Build. Clarify the combined task while preserving the existing Build files as context."
                )
            elif selected_action == "replace_edit":
                await workspace.discard_build()
                ota_context.transition_think(BuildStageState(
                    stage="clarify",
                    workflow_id=conflict.requested_workflow_id,
                ))
                await BuildThink.sync_build_space(ota_context, context, create=True)
                action = "replace"
                message = (
                    "The user chose to discard the unfinished Build and restore the selected "
                    "Workflow as the new editable Build."
                )
            elif selected_action == "replace_new":
                ota_context.transition_think(BuildStageState(stage="clarify"))
                await BuildThink.sync_build_space(ota_context, context, create=True)
                action = "replace"
                message = (
                    "The user chose to discard the unfinished Build and start a clean Build "
                    "from the latest request."
                )
            else:
                ota_context.transition_think(BuildStageState(
                    stage=conflict.existing_stage,
                    workflow_id=conflict.existing_workflow_id,
                ))
                await BuildThink.sync_build_space(ota_context, context)
                action = "not_answered"
                message = (
                    "The user replied to the entire unfinished-Build choice instead of "
                    f"selecting an action: {user_message}"
                )

            request = None
            for record in reversed(ota_context.ota_record):
                steps = (record.action_result or {}).get("results") or []
                request = next(
                    (
                        step
                        for step in reversed(steps)
                        if step.get("tool_name") == "request_build"
                    ),
                    None,
                )
                if request is not None:
                    break
            if request is not None:
                payload = request.get("tool_result")
                payload = dict(payload) if isinstance(payload, dict) else conflict.model_dump(mode="json")
                payload.update({
                    "status": "resolved" if action != "not_answered" else "not_answered",
                    "action": action,
                    "message": message,
                    "response": user_message,
                    **({"user_message": user_message} if action == "not_answered" else {}),
                })
                request["tool_result"] = payload
            else:
                ota_context.ota_record.append(OTARecord(observation_result=f"[build] {message}"))

            ota_context.transition_interaction(None)
            context.session = context.session.without_last()
            ota_context.user_input = original_user_input

        async def resume_workflow_run_choice() -> None:
            """Apply the user's Run choice or fold a free-form reply back into Main."""
            answer_input = ota_context.user_input
            ota_context.ota_record = [OTARecord.model_validate(record) for record in rounds]
            context.session = context.session.without_last()
            ota_context.user_input = original_user_input

            selected_action = self._choice_selection(
                answer_input,
                request_id=choice.request_id,
                questions=choice.questions,
                allowed={"resume", "restart"},
            )
            user_message = (
                self._option_label(choice.questions, selected_action)
                if selected_action is not None
                else self._choice_reply_text(answer_input, choice.questions)
            )
            action = "not_answered"
            message = (
                "The user replied to the unfinished-Run choice without selecting an "
                f"action: {user_message}"
            )
            result_fields: Dict[str, Any] = {}
            selected_workflow_id = (
                choice.existing_workflow_id
                if selected_action == "resume"
                else choice.requested_workflow_id
            )

            if selected_action is not None:
                try:
                    source, resolved_action = await WorkflowRunThink._enter_or_resume_run_workflow(
                        ota_context,
                        context,
                        selected_workflow_id,
                        selected_action,
                    )
                    action = selected_action
                    message = (
                        "The user chose to resume the existing pinned Workflow Run."
                        if selected_action == "resume"
                        else (
                            "The user chose to discard the unfinished Run and start a "
                            "fresh Run from the currently saved Workflow."
                        )
                    )
                    result_fields = {
                        "workflow_id": source.workflow_id,
                        "workflow_name": source.name,
                        **WorkflowRunThink._workflow_sections(source),
                        "resolved_action": resolved_action,
                    }
                except (RuntimeError, ValueError) as exc:
                    action = "failed"
                    message = (
                        f"The selected Workflow Run action could not be applied: {exc}. "
                        "The original unfinished Run was preserved."
                    )
                    ota_context.transition_think(NormalStageState())
                    WorkflowRunThink._close_run_workflow_bindings(context)

            request = None
            for record in reversed(ota_context.ota_record):
                steps = (record.action_result or {}).get("results") or []
                request = next(
                    (
                        step
                        for step in reversed(steps)
                        if step.get("tool_name") == "request_run_workflow"
                    ),
                    None,
                )
                if request is not None:
                    break
            if request is not None:
                payload = request.get("tool_result")
                payload = dict(payload) if isinstance(payload, dict) else choice.model_dump(mode="json")
                payload.update({
                    "status": "resolved" if action in {"resume", "restart"} else action,
                    "action": action,
                    "message": message,
                    "response": user_message,
                    **result_fields,
                    **({"user_message": user_message} if action == "not_answered" else {}),
                })
                request["tool_result"] = payload
            else:
                ota_context.ota_record.append(OTARecord(
                    observation_result=f"[workflow re-entry] {message}",
                ))

            ota_context.transition_interaction(None)

        if interaction.get("build_confirm") is True:
            await resume_build_confirm()
        elif interaction.get("build_conflict") is True:
            conflict = AwaitingBuildConflict.model_validate(interaction)
            await resume_build_conflict()
        elif interaction.get("workflow_run_choice") is True:
            choice = AwaitingWorkflowRunChoice.model_validate(interaction)
            await resume_workflow_run_choice()

    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Enter the requested specialized workflow from normal conversation."""
        await super().handle_action_result(ota_context, context, agent)

        async def handle_build_request(step: ActionStepResult, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
            """Resolve Main's request to enter or replace a Build."""
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
                BuildThink.close_build_bindings(context)
                return conflict

            result = step.tool_result
            if isinstance(result, RequestBuild):
                if result.mode == "start":
                    workflow_id = requested_edit_workflow_id()
                    ota_context.transition_think(BuildStageState(
                        stage="clarify",
                        workflow_id=workflow_id,
                    ))
                    await BuildThink.sync_build_space(ota_context, context, create=True)
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


        async def handle_workflow_run_request(step: ActionStepResult, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
            """Resolve Main's request to enter or restart a Workflow Run."""
            def workflow_run_request_interaction(context: AmphiContext, requested_workflow_id: str, reason: Optional[str]) -> AwaitingWorkflowRunChoice:
                """Create the unfinished-Run interaction requested through ``request_run_workflow``."""
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

                if context.session.is_child:
                    raise RuntimeError("Child Sessions cannot control Workflow Runs.")
                workflows = context.workflows
                workspace = context.workspace
                if workflows is None or workspace is None or not context.session.id:
                    raise RuntimeError("Cannot request a Workflow Run choice without a Session.")
                existing_state = workspace.run_workflow_checkpoint()
                if existing_state is None:
                    raise RuntimeError("Cannot request a Workflow Run choice without an unfinished Run.")
                same_workflow = existing_state.workflow_id == requested_workflow_id
                try:
                    requested = workflows.source(requested_workflow_id)
                except ValueError:
                    if not same_workflow:
                        raise
                    requested = None
                options = [card_option("agent.workflow_run_choice", "resume")]
                if requested is None:
                    question = backend_i18n.text(
                        "agent.workflow_run_choice.question_resume_only",
                        name=existing_state.workflow_name,
                        reason=reason or backend_i18n.text("agent.workflow_run_choice.default_reason"),
                    )
                else:
                    target_text = (
                        backend_i18n.text(
                            "agent.workflow_run_choice.target_same",
                            name=existing_state.workflow_name,
                        )
                        if same_workflow
                        else backend_i18n.text(
                            "agent.workflow_run_choice.target_other",
                            name=requested.name,
                        )
                    )
                    question = backend_i18n.text(
                        "agent.workflow_run_choice.question",
                        reason=reason or backend_i18n.text("agent.workflow_run_choice.default_reason"),
                        target=target_text,
                    )
                    options.append(card_option("agent.workflow_run_choice", "restart"))
                return AwaitingWorkflowRunChoice(
                    existing_workflow_id=existing_state.workflow_id,
                    requested_workflow_id=requested_workflow_id,
                    reason=reason,
                    request_id=f"workflow_run_choice_{uuid4().hex}",
                    questions=[{
                        "question": question,
                        "header": backend_i18n.text("agent.workflow_run_choice.header"),
                        "options": options,
                        "multiSelect": False,
                    }],
                )

            result = step.tool_result
            if isinstance(result, RequestRunWorkflow):
                step.tool_result = {
                    "workflow_id": result.workflow_id,
                    "action": result.action,
                    "reason": result.reason,
                }
                if result.action == "ask":
                    choice = workflow_run_request_interaction(
                        context,
                        result.workflow_id,
                        result.reason,
                    )
                    ota_context.transition_interaction(choice)
                    step.tool_result = {
                        **choice.model_dump(mode="json"),
                        "status": "pending",
                    }
                else:
                    workspace = context.workspace
                    retained = workspace.run_workflow_checkpoint() if workspace is not None else None
                    source, resolved_action = await WorkflowRunThink._enter_or_resume_run_workflow(
                        ota_context,
                        context,
                        result.workflow_id,
                        "restart" if retained is not None else "start",
                    )
                    step.tool_result = {
                        "workflow_id": source.workflow_id,
                        "workflow_name": source.name,
                        **WorkflowRunThink._workflow_sections(source),
                        "status": resolved_action,
                        "reason": result.reason,
                    }


        async def enter_or_resume_build(ota_context: AmphiOTAContext, context: AmphiContext, workflow_id: Optional[str] = None) -> Optional[BuildStageState]:
            """Enter a new Build or reopen the unfinished Build for semantic routing.

            Returns
            -------
            BuildStageState, optional
                The reopened unfinished Build state. ``None`` means a new Build was
                created for the requested operation.
            """
            workspace = context.workspace
            if workspace is None:
                ota_context.transition_think(BuildStageState(stage="clarify", workflow_id=workflow_id))
                return None
            if not workspace.has_build:
                ota_context.transition_think(BuildStageState(stage="clarify", workflow_id=workflow_id))
                await BuildThink.sync_build_space(ota_context, context, create=True)
                return None

            build = await workspace.prepare_build_space("resume")
            existing = BuildStageState(stage=build.stage, workflow_id=build.workflow_id)
            if existing.workflow_id != workflow_id:
                BuildThink.close_build_bindings(context)
                return existing
            ota_context.transition_think(existing)
            await BuildThink.sync_build_space(ota_context, context)
            return existing

        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "request_build":
                await handle_build_request(step, ota_context, context, agent)
            elif step.tool_name == "edit_workflow":
                result = step.tool_result
                if isinstance(result, EditWorkflow):
                    workflows = context.workflows
                    session_id = context.session.id
                    workflow = workflows.get(result.workflow_id) if workflows is not None else None
                    if workflows is not None and session_id:
                        await workflows.associate_session(session_id, result.workflow_id)
                    existing = await enter_or_resume_build(
                        ota_context,
                        context,
                        result.workflow_id,
                    )
                    competing = existing is not None and existing.workflow_id != result.workflow_id
                    step.tool_result = {
                        "workflow_id": result.workflow_id,
                        "workflow_name": workflow.name if workflow is not None else result.workflow_id,
                        "message": (
                            "A different unfinished Build remains active, so the selected "
                            "Workflow has not been restored yet. Compare the two intents and "
                            "call request_build with mode `ask` if the user must choose between them."
                            if competing
                            else (
                                "The requested Workflow is already the active editable Build."
                                if existing is not None
                                else "The saved Workflow was restored as an editable Build baseline."
                            )
                        ),
                    }
            elif step.tool_name == "request_presentation":
                result = step.tool_result
                if isinstance(result, RequestPresentation):
                    PresentationThink.invalidate_artifacts(context, PRESENTATION_STAGE_ORDER)
                    ota_context.transition_think(PresentationStageState(goal=result.goal))
                    step.tool_result = {
                        "mode": "presentation",
                        "stage": "ppt_brief",
                        "goal": result.goal,
                        "message": "The presentation request entered the dedicated pipeline.",
                    }
            elif step.tool_name == "request_run_workflow":
                await handle_workflow_run_request(step, ota_context, context, agent)

    def select_skills(self, ota_context: AmphiOTAContext, context: AmphiContext) -> Dict[str, Skill]:
        """Expose the enabled Skills selected for this mode."""
        skills = context.skills
        return skills.data() if skills is not None else {}

    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Select this mode's tools in stable catalogue order."""
        tools = [
            *super().select_tools(ota_context, context),
            *TOOL_LIBRARY.select(FILE_SYSTEM_TOOL_NAMES | {
                "bash",
                "create_schedule",
                "delete_schedule",
                "edit_workflow",
                "generate_image",
                "get_schedule",
                "help",
                "list_schedules",
                "list_workflow_runs",
                "read_image",
                "read_workflow_run",
                "remove_workflow",
                "request_build",
                "request_human_choice",
                "request_presentation",
                "request_run_workflow",
                "run_subagent",
                "start_subagent",
                "update_schedule",
                "web_fetch",
                "web_search",
            }),
            *TOOL_LIBRARY.get_browser_tools(include_advanced=ota_context.browser_tool_loaded),
            *TOOL_LIBRARY.get_workspace_tools(include_advanced=ota_context.workspace_tools_loaded),
            *TOOL_LIBRARY.get_skills_tools(include_advanced=ota_context.skills_tool_loaded),
        ]
        return TOOL_LIBRARY.select(tool.tool_name for tool in tools)

    async def assemble_messages(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[Message]:
        """The next model call as a NATIVE message list (not a flattened text blob).
        Both isolated reasoning and hydrated Session runs receive an
        :class:`AmphiContext`; a hydrated turn assembles as::

            # Root SYSTEM: stable persona, then context from stable to volatile
            SYSTEM:
                You are Bridgic Agent, a general-purpose agent that helps users on
                their machine. …(full persona)…
                The tools currently available … <exact tool selection names>

                <context>
                <transcript>
                /Users/me/.bridgic/sessions/s_42/history.md
                </transcript>
                <skills>
                - <name>: <description>
                </skills>
                <schedules>
                - <name> (id: <schedule_id>, status: enabled, …)
                </schedules>
                <workflows>
                - <name> (id: <workflow_id>, entry: <path>): <description>
                </workflows>
                <workflow_results>
                - <name> result (run_id: <run_id>, status: completed, …)
                </workflow_results>
                <memories>
                The user prefers pnpm over npm.
                </memories>
                <Workspace>
                - Working directory: /Users/me/.bridgic/sessions/s_42/.work
                - OS: Darwin 24.6.0 (arm64)
                - Node environment: bundled Node with one app-level base shared across Sessions, Builds, Workflow Runs, and Child Agents
                - Python environment: app-level base shared across Sessions, Builds, Workflow Runs, and Child Agents
                - Changed files: none
                </Workspace>
                </context>

            ``SubAgentThink`` gives a Child Session its own persona and tool ceiling
            while retaining the same native message structure::

                SYSTEM:
                    …(the Child persona, rendered with only Child tool selection names)…

                    <context>
                    <skills>
                    …optional enabled Skills, usable through view_skill…
                    </skills>
                    <workflow_results>
                    …optional read-only Workflow results…
                    </workflow_results>
                    <memories>
                    …optional recalled memory…
                    </memories>
                    <Workspace>
                    - Session work directory: /Users/me/.bridgic/sessions/root/.work
                    - Mounted directories / files: [...]
                    - OS: Darwin 24.6.0 (arm64)
                    - Node environment: bundled Node with one app-level base shared across Sessions, Builds, Workflow Runs, and Child Agents
                    - Python environment: app-level base shared across Sessions, Builds, Workflow Runs, and Child Agents
                    - Changed files: ...
                    </Workspace>
                    </context>

            # past turns (session_messages_block): persisted OTA replay
            USER:  what python version is acme-api on?
            AI:    ToolCall(id=call_0, name=read_file, args={"path": "pyproject.toml"})
            TOOL:  (call_0) "[project]\nrequires-python = '>=3.13'"
            AI:    It targets Python 3.13.

            # this turn's request
            USER:  count the TODOs under src/

                   <current_time>
                   2026-07-26 10:00 (UTC+08:00)
                   </current_time>

            # this turn's rounds so far (turn_messages_block): AI tool-call + TOOL result, paired by id
            AI:    "Let me grep for them."
                   ToolCall(id=call_0_0, name=grep, args={"pattern": "TODO", "path": "src"})
            TOOL:  (call_0_0) "src/app.py:12: # TODO: validate input
                               src/db.py:88: # TODO: index this"
        """
        ota_context.tools = self.select_tools(ota_context, context)
        blocks = await self.context_blocks(ota_context, context)
        umbrella = "<context>\n" + "\n\n".join(b for b in blocks if b) + "\n</context>"
        system = "\n\n".join(block for block in (
            self.system_block(ota_context, context), umbrella,
        ) if block)

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(ota_context, context)
        return messages

    async def workspace_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Add the Session's unfinished Build and Workflow Run to its common context."""
        lines = ["<Workspace>", self.working_directory_block(context)]
        workspace = context.workspace
        if isinstance(ota_context.think_status, NormalStageState) and workspace is not None:
            build_checkpoint = workspace.build_checkpoint()
            if build_checkpoint is not None:
                workflow_id = build_checkpoint.workflow_id
                operation = "edit" if workflow_id else "create"
                details = [
                    f"stage: {build_checkpoint.stage}",
                    f"operation: {operation}",
                ]
                if workflow_id:
                    details.append(f"workflow_id: {workflow_id}")
                lines.append("- Retained Build: " + ", ".join(details))
            run_checkpoint = workspace.run_workflow_checkpoint()
            if run_checkpoint is not None:
                lines.append(
                    f"- Retained Workflow Run: {run_checkpoint.workflow_name} "
                    f"(workflow_id: {run_checkpoint.workflow_id}, "
                    f"stage: {run_checkpoint.stage}, "
                    f"step_index: {run_checkpoint.step_index}, "
                    "owner: this Session)"
                )
        lines.append(self.environment_block(context))
        lines.append("</Workspace>")
        return "\n".join(lines)

    async def workflows_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render saved Workflow definitions and recent global results."""
        workflows = context.workflows
        workflow_runs = context.workflow_runs
        if workflows is None and workflow_runs is None:
            return ""
        blocks = []
        if workflows is not None and workflows.data():
            lines = [
                f"- {workflow.name} (id: {workflow.workflow_id}, "
                f"entry: {json.dumps(str(workflow.entry_path), ensure_ascii=False)}): "
                f"{workflow.description or '(no description)'}"
                for workflow in workflows.data().values()
            ]
            blocks.append("<workflows>\n" + "\n".join(lines) + "\n</workflows>")
        runs = workflow_runs.runs()[:10] if workflow_runs is not None else ()
        if runs:
            run_lines = [
                f"- {run.workflow_name} result (run_id: {run.run_id}, "
                f"status: {run.status.value}, "
                f"result path: {json.dumps(str(run.result_dir), ensure_ascii=False)}, "
                f"intermediate work path: "
                f"{json.dumps(str(run.background_work_dir), ensure_ascii=False)}, "
                f"input: {json.dumps(run.workflow_input.text, ensure_ascii=False)})"
                for run in runs
            ]
            blocks.append("<workflow_results>\n" + "\n".join(run_lines) + "\n</workflow_results>")
        return "\n\n".join(blocks)

    async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Render Main context from the most stable prefix to live round state."""
        return [
            self.transcript_block(ota_context, context),
            await self.skills_block(ota_context, context),
            await self.schedules_block(ota_context, context),
            await self.workflows_block(ota_context, context),
            await self.memory_block(ota_context, context),
            await self.workspace_block(ota_context, context),
        ]

    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """The persona / system-instructions piece — ``assemble_messages`` composes
        the full SYSTEM message from this plus the ``<context>`` umbrella."""
        names = [tool.tool_name for tool in ota_context.tools]
        return render_main_persona(names, template=self.persona).strip()

    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict]) -> List[CallVerdict]:
        """Apply inherited admission rules, then this worker's business constraints."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts)
        resolved = self._exclusive_call_verdicts(calls, resolved, {"edit_workflow", "request_build", "request_presentation", "request_run_workflow"})

        def reason_for_call(call: StepToolCall) -> Optional[str]:
            tool_name = getattr(call, "tool", None)
            if tool_name == "request_build":
                arguments = {
                    _view(argument, "name"): _view(argument, "value")
                    for argument in getattr(call, "tool_arguments", None) or []
                }
                workspace = context.workspace
                retained = workspace.build_checkpoint() if workspace is not None else None
                if arguments.get("mode", "ask") == "ask" and retained is not None and not str(arguments.get("reason") or "").strip():
                    return (
                        "request_build rejected: mode `ask` requires a concrete reason "
                        "when resolving an unfinished Build conflict."
                    )
                return None
            if tool_name == "switch":
                return "switch rejected: Main enters cognitive modes through their dedicated tools."
            if tool_name not in {"edit_workflow", "request_run_workflow"}:
                return None
            if tool_name == "request_run_workflow" and ota_context is not None:
                recent_steps = (
                    step
                    for record in reversed(ota_context.ota_record)
                    for step in reversed(_view(_view(record, "action_result"), "results") or [])
                )
                for step in recent_steps:
                    if (
                        _view(step, "tool_name") == "switch"
                        and _view(step, "success")
                        and _view(_view(step, "tool_result"), "mode") == "normal"
                    ):
                        break
                    if _view(step, "tool_name") == "report_workflow_step":
                        return "workflow run rejected: this turn already ran the Workflow; summarize its reports."
            arguments = {
                _view(argument, "name"): _view(argument, "value")
                for argument in getattr(call, "tool_arguments", None) or []
            }
            workflow_id = str(arguments.get("workflow_id") or "").strip()
            workflows = context.workflows
            if workflows is None:
                return f"{tool_name} rejected: no Workflow catalogue is available."
            if tool_name == "request_run_workflow":
                workspace = context.workspace
                active = (
                    workspace.run_workflow_checkpoint()
                    if workspace is not None
                    else None
                )
                action = str(arguments.get("action") or "start")
                if action not in {"start", "ask"}:
                    return (
                        f"request_run_workflow rejected: unsupported action `{action}`; "
                        "use action `start` or `ask`."
                    )
                if action == "ask" and active is None:
                    return (
                        "request_run_workflow rejected: `ask` requires an "
                        "unfinished Run; use action `start`."
                    )
                if action == "ask" and active.workflow_id == workflow_id:
                    return None
            try:
                workflows.source(workflow_id)
            except ValueError as exc:
                return f"{tool_name} rejected: {exc}."
            return None

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


__all__ = ["MainThink"]
