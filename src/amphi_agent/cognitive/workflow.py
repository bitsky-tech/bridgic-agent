"""Cognitive workers for executing saved Workflows."""

from typing import Any, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.model.types import Message, Role

from .._cognitive import MainThink, render_input
from .._context import AmphiContext, AmphiOTAContext, _view
from .._state import WorkflowStageState
from ..prompts.render import render_stage_persona
from ..prompts.workflow import WORKFLOW_PERSONA
from ..tools import switch_tool

__all__ = [
    "WorkflowRunThink",
    "WorkflowThink",
]


# Workflow runtime — one saved source section at a time
################################################################################################################
class WorkflowRunThink(MainThink):
    """Provide stable source, prompt, tool, and legality mechanics for Workflow stages."""

    workflow_stage: str = ""
    permission_mode_override: Optional[str] = "full"
    allowed_tools = (
        MainThink.allowed_tools
        - {"edit_workflow", "help", "request_build", "request_presentation"}
        | {"report_workflow_step"}
    )

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

    async def assemble_messages(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Message]:
        """Assemble one Workflow Run round from its stage-owned tool surface."""
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.context_blocks(ota_context, context)
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = self.assemble_system(
            ota_context,
            context,
            self.system_block(ota_context, context),
            umbrella,
        )

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

    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Return the stable Workflow-stage persona."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona(
            [tool.tool_name for tool in tools],
            template=self.persona,
        ).strip()

    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[Any]:
        """Return Workflow runtime tools plus the cognitive-mode switch."""
        tools = super().select_tools(ota_context, context)
        return [*tools, switch_tool]

    @staticmethod
    def run_request_legality_reason(
        call: StepToolCall,
        context: AmphiContext,
    ) -> Optional[str]:
        """Validate a replacement request from an active Workflow stage."""
        arguments = {
            _view(argument, "name"): _view(argument, "value")
            for argument in getattr(call, "tool_arguments", None) or []
        }
        workflow_id = str(arguments.get("workflow_id") or "").strip()
        action = str(arguments.get("action") or "start")
        workflows = context.workflows
        workspace = context.workspace
        active = workspace.run_workflow_checkpoint() if workspace is not None else None
        if workflows is None or active is None:
            return "request_run_workflow rejected: no unfinished Workflow Run is active."
        if action == "start":
            return (
                "request_run_workflow rejected: this Workflow stage already owns an unfinished Run; "
                "choose resume, restart, or ask."
            )
        if action == "resume" and active.workflow_id != workflow_id:
            return (
                "request_run_workflow rejected: resume must target the active Workflow "
                f"`{active.workflow_id}`."
            )
        try:
            workflows.source(workflow_id)
        except ValueError as exc:
            return f"request_run_workflow rejected: {exc}."
        return None

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

    async def report_legality_reason(
        self,
        call: StepToolCall,
        ota_context: Optional[AmphiOTAContext],
        context: AmphiContext,
        expected_stage: str,
    ) -> Optional[str]:
        """Return why a Workflow control call is illegal in the active section."""
        tool_name = getattr(call, "tool", None)
        if tool_name == "request_run_workflow":
            if ota_context is None:
                return "request_run_workflow rejected: no Workflow Run is active."
            return self.run_request_legality_reason(call, context)
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
            state = self.state(ota_context, expected_stage)
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


class WorkflowThink(WorkflowRunThink):
    """Execute the current section of a saved Workflow."""

    persona: str = WORKFLOW_PERSONA
    workflow_stage: str = "execute"

    async def legality_check(
        self,
        call: StepToolCall,
        ota_context: Optional[AmphiOTAContext],
        context: AmphiContext,
    ) -> Optional[str]:
        """Ensure an execution report belongs to the active WORKFLOW.md section."""
        return await self.report_legality_reason(call, ota_context, context, "execute")
