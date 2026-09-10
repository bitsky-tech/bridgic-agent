"""Shared cognitive behavior for presentation stages."""

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Dict, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ..._tools import TOOL_LIBRARY
from ..._state import CallVerdict, NormalStageState, PresentationStageState, PresentationStepRecord
from ...prompts.render import render_stage_persona
from ...security import Permission
from ...tools import FILE_SYSTEM_TOOL_NAMES, switch_tool
from ...tools.ppt import PresentationStepReport, parse_presentation_step_data
from ..base import BaseThink
from .shared import PRESENTATION_STAGE_ARTIFACTS, PRESENTATION_STAGE_ORDER, PRESENTATION_STAGE_STEPS


if TYPE_CHECKING:
    from ..._agent import AmphiAgent


class PresentationThink(BaseThink):
    """Shared tool surface and context for all presentation stages."""

    ############################################################################
    # The agent design
    ############################################################################
    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Apply presentation handoffs and production-step reports."""
        await super().handle_action_result(ota_context, context, agent)
        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "switch":
                sig = step.tool_result
                current_status = ota_context.think_status
                target_mode = sig.get("mode") or current_status.mode
                if target_mode == "normal":
                    next_status = NormalStageState()
                else:
                    if target_mode != current_status.mode:
                        raise RuntimeError(f"Cannot switch from `{current_status.mode}` to `{target_mode}`.")
                    target = str(sig.get("stage"))
                    current_index = PRESENTATION_STAGE_ORDER.index(current_status.stage)
                    target_index = PRESENTATION_STAGE_ORDER.index(target)
                    reports = current_status.reports
                    if target_index <= current_index:
                        retained_stages = set(PRESENTATION_STAGE_ORDER[:target_index])
                        reports = [report for report in reports if report.stage in retained_stages]
                    reset_plan = target_index <= PRESENTATION_STAGE_ORDER.index("ppt_plan")
                    next_status = current_status.model_copy(update={
                        "stage": target,
                        "step_index": 0,
                        "reports": reports,
                        **({
                            "sources": [],
                            "outline": [],
                            "outline_confirmed": False,
                            "outline_confirmation_id": None,
                            "template_candidates": [],
                            "template_selection_id": None,
                            "template_selection_status": "idle",
                            "template_selection_error": None,
                            "selected_template": None,
                            "template_excluded_ids": [],
                        } if reset_plan else {}),
                    })
                    if target_index <= current_index:
                        self.invalidate_artifacts(context, PRESENTATION_STAGE_ORDER[target_index:])
                ota_context.transition_think(next_status)
                if sig.get("reason") and not isinstance(next_status, NormalStageState):
                    agent._stamp_stage_handoff(ota_context, current_status, next_status, sig["reason"])
                if isinstance(next_status, NormalStageState):
                    agent._stamp_mode_exit(ota_context, current_status, sig.get("reason"))
            elif step.tool_name == "report_presentation_step":
                result = step.tool_result
                current_status = ota_context.think_status
                if isinstance(result, PresentationStepReport) and isinstance(current_status, PresentationStageState):
                    stage_steps = PRESENTATION_STAGE_STEPS.get(current_status.stage, ())
                    if current_status.step_index >= len(stage_steps):
                        raise RuntimeError("Cannot report a completed Presentation stage.")
                    current_step = stage_steps[current_status.step_index]
                    report = PresentationStepRecord(
                        stage=current_status.stage,
                        step_id=current_step.step_id,
                        summary=result.summary,
                        evidence=result.evidence,
                    )
                    reports = [
                        item
                        for item in current_status.reports
                        if (item.stage, item.step_id) != (report.stage, report.step_id)
                    ]
                    reports.append(report)
                    next_status = current_status.apply_plan_step_data(
                        current_step.step_id,
                        result.data,
                    ).model_copy(update={
                        "step_index": current_status.step_index + 1,
                        "reports": reports,
                    })
                    payload = {
                        "mode": "presentation",
                        "stage": current_status.stage,
                        "step_index": current_status.step_index,
                        "step_count": len(stage_steps),
                        "step_id": current_step.step_id,
                        "summary": result.summary,
                        "evidence": result.evidence,
                        "data": result.data,
                        "next_step_index": next_status.step_index,
                    }
                    ota_context.transition_think(next_status)
                    step.tool_result = payload

    ############################################################################
    # Dynamic prompt assembly
    ############################################################################
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

    ##############
    # Blocks
    ##############
    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render this stage's persona with its exact runtime tool surface."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona([tool.tool_name for tool in tools], template=self.persona).strip()

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

    ############################################################################
    # Legality check
    ############################################################################
    async def legality_check(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict]) -> List[CallVerdict]:
        """Keep one presentation control and validate its active production cursor."""
        resolved = await super().legality_check(ota_context, context, calls, verdicts)
        resolved = self._exclusive_call_verdicts(calls, resolved, {"ppt_rag", "report_presentation_step"})

        def legality_reason(call: StepToolCall) -> Optional[str]:
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

        for index, (call, verdict) in enumerate(zip(calls, resolved)):
            if verdict.verdict == Permission.DENY.value:
                continue
            reason = legality_reason(call)
            if reason is not None:
                resolved[index] = verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
        return resolved

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

    ############################################################################
    # Tools and Skills selection
    ############################################################################
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

    def select_skills(self, ota_context: AmphiOTAContext, context: AmphiContext) -> Dict[str, Skill]:
        """Expose the enabled Skills selected for this mode."""
        skills = context.skills
        return skills.data() if skills is not None else {}

    ############################################################################
    # Helpers
    ############################################################################
    @staticmethod
    def state(ota_context: AmphiOTAContext) -> PresentationStageState:
        """Return the active presentation progress state."""
        state = ota_context.think_status
        if not isinstance(state, PresentationStageState):
            raise RuntimeError("Presentation Think requires an active presentation stage.")
        return state

    @staticmethod
    def artifact_path(context: AmphiContext, stage: str) -> Optional[Path]:
        """Return the fixed Session-local artifact path for a stage that owns one."""
        workspace = context.workspace
        relative = PRESENTATION_STAGE_ARTIFACTS.get(stage)
        if workspace is None or relative is None:
            return None
        return workspace.work_dir / relative

    @staticmethod
    def invalidate_artifacts(context: AmphiContext, stages: Iterable[str]) -> None:
        """Remove exact derived contracts that no longer belong to the active cursor."""
        workspace = context.workspace
        if workspace is None:
            return
        for stage in stages:
            relative = PRESENTATION_STAGE_ARTIFACTS.get(stage)
            if relative is None:
                continue
            path = workspace.work_dir / relative
            if path.parent.is_symlink():
                raise RuntimeError(
                    f"Cannot invalidate Presentation artifact through symlinked directory `{path.parent}`."
                )
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                raise RuntimeError(
                    f"Cannot invalidate stale Presentation artifact `{relative}`: {exc}."
                ) from exc

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
