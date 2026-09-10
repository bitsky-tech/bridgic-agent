"""Shared context, tools, and legality checks for saved Workflow stages."""

import json
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ..base import BaseThink, render_input
from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ...security import Permission
from ..._tools import TOOL_LIBRARY
from ..._state import CallVerdict, NormalStageState, WorkflowStageState
from ...prompts.render import render_stage_persona
from ...tools import FILE_SYSTEM_TOOL_NAMES, switch_tool
from ...tools.workflow import WorkflowStepReport
from ....amphi_store import WorkflowRunStatus

if TYPE_CHECKING:
    from ..._agent import AmphiAgent


class WorkflowRunThink(BaseThink):
    """Provide stable source, prompt, tool, and legality mechanics for Workflow stages."""

    workflow_stage: str = ""
    permission_mode_override: Optional[str] = "full"

    ############################################################################
    # The agent design
    ############################################################################
    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Apply a Workflow section report or an explicit exit from its active Run."""
        await super().handle_action_result(ota_context, context, agent)

        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "switch":
                sig = step.tool_result
                current_status = ota_context.think_status
                target_mode = sig.get("mode") or current_status.mode
                if target_mode != "normal":
                    raise ValueError(
                        "Workflow stages advance automatically; switch only exits to normal mode."
                    )
                ota_context.transition_think(NormalStageState())
                agent._stamp_mode_exit(ota_context, current_status, sig.get("reason"))
                agent._close_run_workflow_bindings(context)

            elif step.tool_name == "report_workflow_step":
                result = step.tool_result
                current_status = ota_context.think_status
                if isinstance(result, WorkflowStepReport) and isinstance(current_status, WorkflowStageState):
                    source = agent._workflow_source(current_status, context)
                    stage_steps = source.steps(current_status.stage)
                    current_step = stage_steps[current_status.step_index]
                    workspace = context.workspace
                    if workspace is None:
                        raise RuntimeError("Cannot report Workflow progress without an active Run.")
                    state = workspace.run_workflow
                    if state is None:
                        raise RuntimeError("Workflow Run space is not bound.")
                    state.checkpoint_cursor(
                        expected_workflow_id=current_status.workflow_id,
                        expected_generation=current_status.generation,
                        expected_stage=current_status.stage,
                        expected_step_index=current_status.step_index,
                        stage=current_status.stage,
                        step_index=current_status.step_index,
                    )
                    workflow_runs = context.workflow_runs
                    if workflow_runs is None:
                        raise RuntimeError("Cannot record Workflow progress without its result library.")
                    workflow_runs.require_run_workflow(state.root)
                    durable_summary = workflow_runs.record_step(
                        stage=current_status.stage,
                        step_number=current_step.index,
                        step_title=current_step.title,
                        status=result.status,
                        summary=result.summary,
                        evidence=result.evidence,
                    )
                    reported_summary = (
                        durable_summary if result.status == "failure" else result.summary
                    )
                    if result.status == "success":
                        next_step_index = current_status.step_index + 1
                        state.checkpoint_cursor(
                            expected_workflow_id=current_status.workflow_id,
                            expected_generation=current_status.generation,
                            expected_stage=current_status.stage,
                            expected_step_index=current_status.step_index,
                            stage=current_status.stage,
                            step_index=next_step_index,
                        )
                    step.tool_result = {
                        "workflow_id": source.workflow_id,
                        "generation": current_status.generation,
                        "workflow_name": source.name,
                        "phase": current_status.stage,
                        "step_index": current_status.step_index,
                        "step_number": current_step.index,
                        "step_count": len(stage_steps),
                        "title": current_step.title,
                        **agent._workflow_sections(source),
                        "status": result.status,
                        "summary": reported_summary,
                        "evidence": result.evidence,
                    }
                    agent._publish_workflow_progress(
                        ota_context,
                        context,
                        current_status,
                        result.status,
                        reported_summary,
                        source=source,
                    )
                    if result.status == "failure":
                        terminal_summary = (
                            f"Workflow `{source.name}` stopped during "
                            f"{current_status.stage} section {current_step.index} "
                            f"(`{current_step.title}`): {reported_summary}"
                        )
                        try:
                            published = await agent._publish_workflow_run(
                                context,
                                current_status,
                                status=WorkflowRunStatus.FAILED,
                            )
                        except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
                            step.success = False
                            step.error = (
                                "The Workflow failure was recorded, but its terminal "
                                f"result could not be saved: {exc}. Retry the failure report."
                            )
                            step.tool_result = {
                                **step.tool_result,
                                "status": "save_failed",
                            }
                            continue
                        step.tool_result = {
                            **step.tool_result,
                            "run_id": published.run_id,
                            "run_status": published.status.value,
                            "created_at": published.created_at.isoformat(),
                            "published_result_dir": str(published.result_dir.resolve()),
                        }
                        await agent._finish_workflow_run(
                            ota_context,
                            context,
                            current_status,
                            generation=current_status.generation,
                            summary=terminal_summary,
                            published=published,
                        )
                    else:
                        next_status = WorkflowStageState(
                            workflow_id=state.workflow_id,
                            generation=state.generation,
                            stage=state.stage,
                            step_index=state.step_index,
                        )
                        ota_context.transition_think(next_status)
                        published = await agent._settle_workflow_boundary(ota_context, context)
                        if published is not None:
                            step.tool_result = {
                                **step.tool_result,
                                "run_id": published.run_id,
                                "run_status": published.status.value,
                                "created_at": published.created_at.isoformat(),
                                "published_result_dir": str(published.result_dir.resolve()),
                            }

    ############################################################################
    # Dynamic prompt assembly
    ############################################################################
    async def assemble_messages(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Message]:
        """Assemble one Workflow Run round from its stage-owned tool surface."""
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.context_blocks(ota_context, context)
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = "\n\n".join(block for block in (
            self.system_block(ota_context, context), umbrella,
        ) if block)

        turn_context, _ = self._stage_turn_context(
            ota_context,
            "run_workflow",
            self.workflow_stage,
        )
        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(turn_context, context)
        return messages

    ##############
    # Input
    ##############
    @staticmethod
    def workflow_input(context: AmphiContext) -> str:
        """Render the original structured input with its persisted references resolved."""
        workspace = context.workspace
        if workspace is None:
            raise RuntimeError("Workflow Run workspace is unavailable.")
        state = workspace.run_workflow
        if state is None:
            raise RuntimeError("Workflow Run space has not been prepared.")
        mention_ids = [
            str(block.get("id") or "")
            for block in state.workflow_input.blocks
            if block.get("type") == "mention" and block.get("id")
        ]
        path_map = (
            workspace.reference_map(mention_ids)
            if mention_ids
            else {}
        )
        workflow_runs = context.workflow_runs
        if workflow_runs is not None:
            for input_run in workflow_runs.referenced_runs(state.workflow_input):
                path_map[input_run.run_id] = str(input_run.result_dir)
        return render_input(state.workflow_input, path_map)

    ##############
    # Blocks
    ##############
    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Return the stable Workflow-stage persona."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona(
            [tool.tool_name for tool in tools],
            template=self.persona,
        ).strip()

    async def workspace_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Add this Workflow Run's writable directories to its Session environment."""
        lines = ["<Workspace>", self.working_directory_block(context)]
        workspace = context.workspace
        workflow_run = workspace.run_workflow if workspace is not None else None
        if workflow_run is not None and workflow_run.is_available:
            workflow_runs = context.workflow_runs
            if workflow_runs is None:
                raise RuntimeError("Workflow Run space is bound without its result library.")
            active_run = workflow_runs.require_run_workflow(workflow_run.root)
            lines.extend([
                "- Workflow final result directory (active, writable): "
                f"{json.dumps(str(active_run.result_dir), ensure_ascii=False)}",
                "- Workflow background work directory (active, writable): "
                f"{json.dumps(str(active_run.background_work_dir), ensure_ascii=False)}",
            ])
        lines.append(self.environment_block(context))
        lines.append("</Workspace>")
        return "\n".join(lines)

    async def workflow_run_block(
        self, ota_context: AmphiOTAContext, context: AmphiContext, expected_stage: str,
    ) -> str:
        """Render the active Workflow position and current immutable section."""
        state = self.state(ota_context, expected_stage)
        source = self.source(state, context)
        steps = source.steps(state.stage)
        if state.step_index > len(steps):
            raise RuntimeError(
                f"Workflow {state.stage} step index {state.step_index} is out of range."
            )
        current = steps[state.step_index] if state.step_index < len(steps) else None
        workflow_runs = context.workflow_runs
        workspace = context.workspace
        run_space = workspace.run_workflow if workspace is not None else None
        if workflow_runs is None or run_space is None:
            raise RuntimeError("Workflow run context is unavailable.")
        run = workflow_runs.require_run_workflow(run_space.root)
        durable = run_space
        execution_lines = [
            f"- [{'x' if index < state.step_index else ' '}] "
            f"{step.index}. {step.title}"
            for index, step in enumerate(source.execution_steps)
        ]
        result_dir = str(run.result_dir)
        work_dir = str(run.background_work_dir)
        input_lines = []
        for input_run in workflow_runs.referenced_runs(durable.workflow_input):
            input_lines.append(
                f"- {input_run.workflow_name} (run_id: {input_run.run_id}): "
                f"final results: {input_run.result_dir}; "
                f"intermediate work: {input_run.background_work_dir}"
            )
        boundary_instruction = (
            "This persisted boundary will be advanced automatically by the runtime."
        )
        current_block = (
            f"Current section: {current.index}. {current.title}\n"
            f"Current instruction:\n{current.instruction}\n"
            if current is not None
            else f"Stage completion boundary:\n{boundary_instruction}\n"
        )
        step_position = (
            f"Step: {state.step_index + 1} of {len(steps)}\n"
            if current is not None
            else f"Step: completion boundary ({len(steps)} of {len(steps)} steps complete)\n"
        )
        runtime = (
            "<workflow_run>\n"
            f"Workflow id: `{source.workflow_id}`\n"
            f"Workflow name: `{source.name}`\n"
            f"Original Workflow input: {self.workflow_input(context)}\n"
            f"Read-only package root: {source.root}\n"
            f"Read-only source root: {source.source_root}\n"
            f"Session-owned run root: {run_space.root}\n"
            f"Writable final result directory: {result_dir}\n"
            f"Writable background work directory: {work_dir}\n"
            + ("Read-only input results:\n" + "\n".join(input_lines) + "\n" if input_lines else "")
            + f"Stage: {state.stage}\n"
            + step_position
            + "Execution sections:\n"
            + "\n".join(execution_lines)
            + f"\n{current_block}"
            "</workflow_run>"
        )
        return runtime

    async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Render Workflow context from stable catalogues to live runtime state."""
        return [
            self.transcript_block(ota_context, context),
            await self.skills_block(ota_context, context),
            await self.schedules_block(ota_context, context),
            await self.workflow_run_block(ota_context, context, self.workflow_stage),
            await self.memory_block(ota_context, context),
            await self.workspace_block(ota_context, context),
        ]

    ############################################################################
    # Legality check
    ############################################################################
    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict]) -> List[CallVerdict]:
        """Validate controls against this stage's bound Run and pinned source."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts)
        resolved = self._exclusive_call_verdicts(calls, resolved, {"report_workflow_step"})

        def reason_for_call(call: StepToolCall) -> Optional[str]:
            tool_name = getattr(call, "tool", None)
            if ota_context is None:
                return (
                    "workflow control rejected: no Workflow run is active."
                    if tool_name in {
                        "switch",
                        "report_workflow_step",
                    }
                    else None
                )
            try:
                state = self.state(ota_context, self.workflow_stage)
                source = self.source(state, context)
            except (RuntimeError, ValueError) as exc:
                return f"workflow control rejected: {exc}."
            steps = source.steps(state.stage)
            if tool_name == "switch":
                arguments = {
                    _view(argument, "name"): _view(argument, "value")
                    for argument in getattr(call, "tool_arguments", None) or []
                }
                if arguments.get("mode") == "normal":
                    return None
                return (
                    "switch rejected: Workflow stages advance automatically; use mode "
                    "`normal` only for an explicit user-requested pause or exit."
                )
            if tool_name != "report_workflow_step":
                return None
            if state.step_index >= len(steps):
                return "workflow step report rejected: the current section does not exist."
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


    ############################################################################
    # Tools and Skills selection
    ############################################################################
    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Select this mode's tools in stable catalogue order."""
        tools = [
            *super().select_tools(ota_context, context),
            *TOOL_LIBRARY.select(FILE_SYSTEM_TOOL_NAMES | {
                "bash",
                "create_schedule",
                "delete_schedule",
                "generate_image",
                "get_schedule",
                "list_schedules",
                "list_workflow_runs",
                "read_image",
                "read_workflow_run",
                "remove_workflow",
                "report_workflow_step",
                "request_human_choice",
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
        tools = TOOL_LIBRARY.select(tool.tool_name for tool in tools)
        return [*tools, switch_tool]

    def select_skills(self, ota_context: AmphiOTAContext, context: AmphiContext) -> Dict[str, Skill]:
        """Expose the enabled Skills selected for this mode."""
        skills = context.skills
        return skills.data() if skills is not None else {}

    ############################################################################
    # Helpers
    ############################################################################
    @staticmethod
    def state(ota_context: AmphiOTAContext, expected_stage: str) -> WorkflowStageState:
        """Return the active Workflow state for the expected cognitive stage."""
        state = ota_context.think_status
        if not isinstance(state, WorkflowStageState) or state.stage != expected_stage:
            raise RuntimeError(f"Workflow {expected_stage} Think requires its active stage.")
        return state

    def source(self, state: WorkflowStageState, context: AmphiContext) -> Any:
        """Return the validated source selected by the active runtime state."""
        workspace = context.workspace
        workflows = context.workflows
        workflow_runs = context.workflow_runs
        durable = workspace.run_workflow if workspace is not None else None
        if workspace is None or workflows is None or workflow_runs is None or durable is None:
            raise RuntimeError("Workflow Run context is unavailable.")
        run = workflow_runs.require_run_workflow(durable.root)
        source = workflows.require_package(run.source_dir)
        reason = source.validation_reason()
        if reason is not None:
            raise ValueError(f"Pinned Workflow package is invalid: {reason}")
        if (
            durable.workflow_id != state.workflow_id
            or durable.generation != state.generation
            or durable.stage != state.stage
            or durable.step_index != state.step_index
        ):
            raise RuntimeError("Workflow cognitive state does not match `.run/.state.json`.")
        return source

    def _stage_turn_context(self, ota_context: AmphiOTAContext, mode: str, stage: str) -> Tuple[AmphiOTAContext, Optional[int]]:
        """Keep only the active automatic Workflow stage's trace."""
        boundary = next((
            index
            for index in range(len(ota_context.ota_record) - 1, -1, -1)
            if (
                (scope := self._record_think_scope(ota_context.ota_record[index]))
                is not None
                and scope[0] == mode
                and scope[1] != stage
            )
        ), None)
        if boundary is None:
            return ota_context, None
        return ota_context.model_copy(update={
            "ota_record": list(ota_context.ota_record[boundary + 1:]),
        }), boundary

__all__ = ["WorkflowRunThink"]
