"""Normal-mode prompt, tool policy, and Workflow entry checks."""

import json
from typing import TYPE_CHECKING, Dict, List, Optional

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ..._state import CallVerdict, BuildStageState, NormalStageState, PresentationStageState
from ..._tools import TOOL_LIBRARY
from ...prompts.main import PERSONA
from ...prompts.render import render_main_persona
from ...tools import FILE_SYSTEM_TOOL_NAMES
from ...tools.powerpoint import RequestPresentation
from ...tools.workflow import EditWorkflow
from ..base import BaseThink
from ...security import Permission
from ..register import cognitive_stage
from ..build.base import build_request_legality_reason, handle_build_request
from ..presentation.base import PresentationThink
from ..presentation.shared import PRESENTATION_STAGE_ORDER
from ..workflow.base import handle_workflow_run_request

if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="normal", stage="main", order=10)
class MainThink(BaseThink):
    """Run ordinary conversation with the Main persona and entry policies."""

    persona: str = PERSONA

    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Enter the requested specialized workflow from normal conversation."""
        await super().handle_action_result(ota_context, context, agent)

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
                await agent._sync_build_space(ota_context, context, create=True)
                return None

            build = await workspace.prepare_build_space("resume")
            existing = BuildStageState(stage=build.stage, workflow_id=build.workflow_id)
            ota_context.transition_think(existing)
            await agent._sync_build_space(ota_context, context)
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
            reason = build_request_legality_reason(call, context)
            if reason:
                return reason
            tool_name = getattr(call, "tool", None)
            if tool_name == "switch":
                return "switch rejected: Main enters cognitive modes through their dedicated tools."
            if tool_name not in {"edit_workflow", "request_run_workflow"}:
                return None
            if tool_name == "request_run_workflow" and ota_context is not None and any(
                _view(step, "tool_name") == "report_workflow_step"
                for record in ota_context.ota_record
                for step in (_view(_view(record, "action_result"), "results") or [])
            ):
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
                if active is None:
                    if action != "start":
                        return (
                            f"request_run_workflow rejected: `{action}` requires an "
                            "unfinished Run; use action `start`."
                        )
                    try:
                        workflows.source(workflow_id)
                    except ValueError as exc:
                        return f"request_run_workflow rejected: {exc}."
                    return None
                state = active
                if action == "start":
                    return (
                        "request_run_workflow rejected: this Session already owns an "
                        "unfinished Run; choose resume, restart, or ask."
                    )
                if action == "resume":
                    if state.workflow_id == workflow_id:
                        return None
                    return (
                        "request_run_workflow rejected: resume must target the unfinished "
                        f"Workflow `{state.workflow_id}`."
                    )
                try:
                    workflows.source(workflow_id)
                except ValueError as exc:
                    return f"request_run_workflow rejected: {exc}."
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
