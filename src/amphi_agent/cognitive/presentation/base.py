"""Shared cognitive behavior for presentation stages."""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ..._tools import TOOL_LIBRARY
from ..._state import PresentationStageState
from ...prompts.render import render_stage_persona
from ...tools import FILE_SYSTEM_TOOL_NAMES, switch_tool
from ...tools.powerpoint import parse_presentation_step_data
from ..base import BaseThink
from .shared import PRESENTATION_STAGE_ARTIFACTS, PRESENTATION_STAGE_ORDER, PRESENTATION_STAGE_STEPS


class PresentationThink(BaseThink):
    """Shared tool surface and context for all presentation stages."""


    def select_skills(self, ota_context: AmphiOTAContext, context: AmphiContext) -> Dict[str, Skill]:
        """Expose the enabled Skills selected for this mode."""
        skills = context.skills
        return skills.data() if skills is not None else {}

    def _stage_turn_context(self, ota_context: AmphiOTAContext, mode: str, stage: str) -> Tuple[AmphiOTAContext, Optional[int]]:
        """Project the current Turn to the active presentation stage and its handoff."""
        def switches_to_target(record: Any) -> bool:
            steps = _view(_view(record, "action_result"), "results") or []
            for step in steps:
                if _view(step, "tool_name") != "switch" or _view(step, "success") is False:
                    continue
                arguments = _view(step, "tool_arguments") or {}
                result = _view(step, "tool_result") or {}
                if str(_view(result, "stage") or _view(arguments, "stage") or "") == stage:
                    return True
            return False

        records = ota_context.ota_record
        scopes = [self._record_think_scope(record) for record in records]
        target_scope = (mode, stage)
        mode_indexes = [
            index for index, scope in enumerate(scopes)
            if scope is not None and scope[0] == mode
        ]
        selected = set(range(len(records))) if not mode_indexes else set()
        if mode_indexes and scopes[mode_indexes[0]] == target_scope:
            selected.update(range(mode_indexes[0]))
        transitions: List[int] = []
        for index, (record, scope) in enumerate(zip(records, scopes)):
            if scope == target_scope:
                selected.add(index)
            if switches_to_target(record):
                selected.add(index)
                transitions.append(index)
                continue
            next_scope = scopes[index + 1] if index + 1 < len(scopes) else target_scope
            if next_scope == target_scope and scope != target_scope:
                transitions.append(index)
                if scope is None or scope[0] != mode:
                    selected.add(index)
        projected = [record for index, record in enumerate(records) if index in selected]
        turn_context = (
            ota_context
            if len(projected) == len(records)
            else ota_context.model_copy(update={"ota_record": projected})
        )
        return turn_context, transitions[-1] if transitions else None

    @staticmethod
    def state(ota_context: AmphiOTAContext) -> PresentationStageState:
        """Return the active presentation progress state."""
        state = ota_context.think_status
        if not isinstance(state, PresentationStageState):
            raise RuntimeError("Presentation Think requires an active presentation stage.")
        return state

    def progress_block(self, ota_context: AmphiOTAContext) -> str:
        """Render the durable production cursor and completed reports."""
        state = self.state(ota_context)
        steps = PRESENTATION_STAGE_STEPS.get(state.stage, ())
        lines = [
            "<presentation_progress>",
            f"Goal: {state.goal or '(infer from the current request and retained history)'}",
            f"Stage: {state.stage}",
        ]
        if not steps:
            lines.append("This stage has no production-step cursor; follow its system prompt and use the prescribed handoff when its required artifact is complete.")
        elif state.step_index < len(steps):
            lines.append(f"Completed steps in this stage: {state.step_index} of {len(steps)}")
            current = steps[state.step_index]
            lines.extend([
                f"Current step id: {current.step_id}",
                f"Current step instruction: {current.instruction}",
                "Complete this step, then call `report_presentation_step` with a concrete summary and evidence.",
            ])
        else:
            lines.append(f"Completed steps in this stage: {len(steps)} of {len(steps)}")
            lines.append("All steps in this stage are complete; perform the required `switch` handoff.")
        if state.reports:
            lines.append("Completed production reports:")
            for report in state.reports:
                lines.append(f"- {report.stage}/{report.step_id}: {report.summary}")
                lines.extend(f"  - evidence: {item}" for item in report.evidence)
        lines.append("</presentation_progress>")
        return "\n".join(lines)

    @staticmethod
    def artifact_path(context: AmphiContext, stage: str) -> Optional[Path]:
        """Return the fixed Session-local artifact path for a stage that owns one."""
        workspace = context.workspace
        relative = PRESENTATION_STAGE_ARTIFACTS.get(stage)
        if workspace is None or relative is None:
            return None
        return workspace.work_dir / relative

    def artifacts_block(self, context: AmphiContext) -> str:
        """Render completed presentation contracts directly into downstream context."""
        parts: List[str] = []
        for stage, relative in PRESENTATION_STAGE_ARTIFACTS.items():
            path = self.artifact_path(context, stage)
            if path is None or path.parent.is_symlink() or path.is_symlink() or not path.is_file():
                continue
            try:
                body = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if body:
                parts.append(f'<artifact stage="{stage}" path="{relative}">\n{body}\n</artifact>')
        return "<presentation_artifacts>\n" + "\n\n".join(parts) + "\n</presentation_artifacts>" if parts else ""

    def plan_data_block(self, ota_context: AmphiOTAContext) -> str:
        """Render runtime-owned Plan data with stable ids for downstream work."""
        state = self.state(ota_context)
        if not state.sources and not state.outline:
            return ""
        payload = {
            "sources": [source.model_dump(mode="json") for source in state.sources],
            "chapters": [chapter.model_dump(mode="json") for chapter in state.outline],
            "outline_confirmed": state.outline_confirmed,
            "template_selection_status": state.template_selection_status,
            "selected_template": (
                state.selected_template.agent_context()
                if state.selected_template is not None
                else None
            ),
        }
        return "<presentation_plan_data>\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n</presentation_plan_data>"

    def artifact_validation_reason(self, context: AmphiContext, stage: str) -> Optional[str]:
        """Require the durable contract owned by a stage before its final report."""
        path = self.artifact_path(context, stage)
        if path is None:
            return None
        relative = PRESENTATION_STAGE_ARTIFACTS[stage]
        if path.parent.is_symlink() or path.is_symlink() or not path.is_file():
            return f"write the required stage artifact `{relative}` first."
        try:
            body = path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            return f"the required stage artifact `{relative}` cannot be read: {exc}."
        if not body:
            return f"the required stage artifact `{relative}` is empty."
        return None

    async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Render only context that can materially affect the current deck."""
        return [
            self.transcript_block(ota_context, context),
            await self.skills_block(ota_context, context),
            await self.memory_block(ota_context, context),
            self.artifacts_block(context),
            self.plan_data_block(ota_context),
            self.progress_block(ota_context),
            await self.workspace_block(ota_context, context),
        ]

    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render this stage's persona with its exact runtime tool surface."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona([tool.tool_name for tool in tools], template=self.persona).strip()

    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Select this mode's tools in stable catalogue order."""
        tools = [
            *super().select_tools(ota_context, context),
            *TOOL_LIBRARY.select(FILE_SYSTEM_TOOL_NAMES | {
                "bash",
                "generate_image",
                "list_workflow_runs",
                "ppt_rag",
                "read_image",
                "read_workflow_run",
                "report_presentation_step",
                "request_human_choice",
                "run_subagent",
                "web_fetch",
                "web_search",
            }),
            *TOOL_LIBRARY.get_browser_tools(include_advanced=ota_context.browser_tool_loaded),
            *TOOL_LIBRARY.get_workspace_tools(include_advanced=ota_context.workspace_tools_loaded),
            *TOOL_LIBRARY.get_skills_tools(include_advanced=ota_context.skills_tool_loaded),
        ]
        tools = TOOL_LIBRARY.select(tool.tool_name for tool in tools)
        state = ota_context.think_status
        expose_ppt_rag = (
            isinstance(state, PresentationStageState)
            and state.stage == "ppt_plan"
            and state.step_index == 2
            and state.outline_confirmed
            and state.template_selection_status == "idle"
        )
        if not expose_ppt_rag:
            tools = [tool for tool in tools if tool.tool_name != "ppt_rag"]
        return [*tools, switch_tool]

    async def assemble_messages(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[Message]:
        """Assemble every presentation stage with its exact runtime tool surface."""
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.context_blocks(ota_context, context)
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = "\n\n".join(block for block in (
            self.system_block(ota_context, context), umbrella,
        ) if block)

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        turn_context, _ = self._stage_turn_context(
            ota_context,
            "presentation",
            self.state(ota_context).stage,
        )
        messages += self.turn_messages_block(turn_context, context)
        return messages

    async def legality_check(self, call: StepToolCall, ota_context: Optional[AmphiOTAContext], context: AmphiContext) -> Optional[str]:
        """Keep reports and stage handoffs aligned with the production cursor."""
        tool_name = getattr(call, "tool", None)
        if tool_name not in {"ppt_rag", "report_presentation_step", "switch"}:
            return None
        if ota_context is None or not isinstance(ota_context.think_status, PresentationStageState):
            return "presentation control rejected: no presentation pipeline is active."
        state = ota_context.think_status
        steps = PRESENTATION_STAGE_STEPS.get(state.stage, ())
        if tool_name == "ppt_rag":
            if (
                state.stage != "ppt_plan"
                or state.step_index != 2
                or not state.outline_confirmed
                or state.template_selection_status != "idle"
            ):
                return "PPT template retrieval rejected: the confirmed visual-direction step is not active."
            calls = getattr(ota_context.think_result, "tool_calls", None) or []
            if len(calls) != 1:
                return "PPT template retrieval rejected: `ppt_rag` must be the only tool call in this round."
            return None
        if tool_name == "report_presentation_step":
            if not steps:
                return "presentation step report rejected: this stage has no reportable production steps."
            if state.step_index >= len(steps):
                return "presentation step report rejected: this stage has no unfinished step."
            current = steps[state.step_index]
            if state.stage == "ppt_plan" and current.step_id in {"collect_evidence", "map_slides"}:
                arguments = {
                    _view(argument, "name"): _view(argument, "value")
                    for argument in getattr(call, "tool_arguments", None) or []
                }
                try:
                    data = parse_presentation_step_data(arguments.get("data"))
                    state.apply_plan_step_data(current.step_id, data)
                except (TypeError, ValueError) as exc:
                    return f"presentation step report rejected: {exc}"
            if state.stage == "ppt_plan" and current.step_id == "design_visual_direction" and not state.outline_confirmed:
                return "presentation step report rejected: the editable outline must be confirmed first."
            if state.stage == "ppt_plan" and current.step_id == "design_visual_direction" and state.template_selection_status not in {"selected", "skipped"}:
                return "presentation step report rejected: call `ppt_rag` by itself and wait for the user's template decision first."
            if state.step_index == len(steps) - 1:
                reason = self.artifact_validation_reason(context, state.stage)
                if reason:
                    return f"presentation step report rejected: {reason}"
            return None

        arguments = {
            _view(argument, "name"): _view(argument, "value")
            for argument in getattr(call, "tool_arguments", None) or []
        }
        target_mode = str(arguments.get("mode") or state.mode)
        if target_mode == "normal":
            return None
        target_stage = str(arguments.get("stage") or "")
        if target_stage not in PRESENTATION_STAGE_ORDER:
            return f"switch rejected: `{target_stage}` is not a presentation stage."
        current_index = PRESENTATION_STAGE_ORDER.index(state.stage)
        target_index = PRESENTATION_STAGE_ORDER.index(target_stage)
        if state.stage == "ppt_review" and target_index < current_index:
            return None
        if target_index != current_index + 1:
            return "switch rejected: presentation stages must advance in production order."
        if state.step_index < len(steps):
            current = steps[state.step_index]
            return (
                "switch rejected: finish and report the current presentation step "
                f"`{current.step_id}` first."
            )
        reason = self.artifact_validation_reason(context, state.stage)
        if reason:
            return f"switch rejected: {reason}"
        return None
