"""Shared cognitive behavior for presentation stages."""

from dataclasses import replace

import json
from pathlib import Path
from typing import TYPE_CHECKING, Iterable, Dict, List, Optional

from bridgic.amphibious import StepToolCall
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.model.types import Message, Role

from ..._context import AmphiContext, AmphiOTAContext, _view
from ..._skills import Skill
from ..._tools import TOOL_LIBRARY
from ..state import CallVerdict, InStage, ThinkUnitOutcome
from ..normal.state import NormalStageState
from .state import PresentationStageState, PresentationPlanData
from ...prompts.render import render_stage_persona
from ...security import Permission
from ...tools import FILE_SYSTEM_TOOL_NAMES, switch_tool
from ...tools.ppt import PresentationStepReport, parse_presentation_step_data
from ...tools.powerpoint import POWERPOINT_READ_TOOL_NAMES
from ..base import BaseThink
from .shared import (
    PRESENTATION_STAGE_ARTIFACTS, PRESENTATION_STAGE_ORDER, PRESENTATION_STAGE_STEPS,
    confirmed_artifact, presentation_outputs, presentation_records, read_artifact, write_artifact,
)


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
                    next_status = current_status.model_copy(update={"stage": target, "step_index": 0})
                    if target_index <= current_index:
                        self.invalidate_artifacts(context, PRESENTATION_STAGE_ORDER[target_index:])
                sig["reason"] = self._handoff_reason(ota_context, context, sig.get("reason") or "")
                ota_context.transition_think(next_status)
                if sig.get("reason") and not isinstance(next_status, NormalStageState):
                    self._stamp_stage_handoff(ota_context, current_status, next_status, sig["reason"])
                if isinstance(next_status, NormalStageState):
                    self._stamp_mode_exit(ota_context, current_status, sig.get("reason"))
            elif step.tool_name == "report_presentation_step":
                result = step.tool_result
                current_status = ota_context.think_status
                if isinstance(result, PresentationStepReport) and isinstance(current_status, PresentationStageState):
                    stage_steps = PRESENTATION_STAGE_STEPS.get(current_status.stage, ())
                    if current_status.step_index >= len(stage_steps):
                        raise RuntimeError("Cannot report a completed Presentation stage.")
                    current_step = stage_steps[current_status.step_index]
                    outputs = presentation_outputs(presentation_records(ota_context, context))
                    artifact = None
                    data = result.data
                    if current_status.stage == "ppt_plan" and current_step.step_id == "map_slides":
                        if "chapters" in result.data:
                            raise RuntimeError("Report `map_slides` without resubmitting the confirmed outline.")
                        confirmed_artifact(outputs, "outline", context)
                        artifact = outputs["outline"]["artifact"]
                        data = {"artifact": artifact}
                    elif current_status.stage == "ppt_plan" and current_step.step_id == "collect_evidence":
                        normalized = PresentationPlanData().apply_plan_step_data(current_step.step_id, data)
                        data = {"sources": [source.model_dump(mode="json") for source in normalized.sources]}
                        artifact = write_artifact(context, "sources", data)
                    elif current_status.stage == "ppt_plan" and current_step.step_id == "design_visual_direction":
                        confirmed_artifact(outputs, "template", context)
                    next_status = current_status.model_copy(update={"step_index": current_status.step_index + 1})
                    payload = {
                        "mode": "presentation",
                        "stage": current_status.stage,
                        "step_index": current_status.step_index,
                        "step_count": len(stage_steps),
                        "step_id": current_step.step_id,
                        "summary": result.summary,
                        "evidence": result.evidence,
                        "data": data,
                        "next_step_index": next_status.step_index,
                        **({"artifact": artifact} if artifact else {}),
                    }
                    ota_context.transition_think(next_status)
                    step.tool_result = payload

    async def handle_think_unit_result(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        previous_status: InStage,
        result: Optional[str],
        agent: "AmphiAgent",
    ) -> ThinkUnitOutcome:
        """Continue the active presentation step until its report or handoff occurs."""
        outcome = await super().handle_think_unit_result(
            ota_context, context, previous_status, result, agent,
        )
        if ota_context.think_status != previous_status:
            return outcome
        status = ota_context.think_status
        if not isinstance(status, PresentationStageState):
            return outcome
        steps = PRESENTATION_STAGE_STEPS.get(status.stage, ())
        if status.stage == "ppt_brief":
            note = (
                "[presentation] Brief is still active. Complete `.ppt/brief.md`, then "
                "call switch(stage=\"ppt_plan\", reason=...). Do not call "
                "report_presentation_step; Brief has no production-step cursor."
            )
        elif status.step_index < len(steps):
            current = steps[status.step_index]
            note = (
                f"[presentation] Production step `{current.step_id}` is still active. Complete "
                "only that step, then call report_presentation_step with its concrete result "
                "and evidence."
            )
        else:
            current_index = PRESENTATION_STAGE_ORDER.index(status.stage)
            if status.stage == "ppt_review":
                handoff = 'switch(mode="normal", reason=...)'
            else:
                handoff = f'switch(stage="{PRESENTATION_STAGE_ORDER[current_index + 1]}", reason=...)'
            note = (
                f"[presentation] Every production step in `{status.stage}` is reported. Call "
                f"{handoff} now; do not repeat a completed step."
            )
        return replace(outcome, continuation=note)

    ############################################################################
    # Dynamic prompt assembly
    ############################################################################
    async def assemble_messages(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[Message]:
        """Assemble each presentation stage with its own history and tool surface."""
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.context_blocks(ota_context, context)
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = "\n\n".join(block for block in (
            self.system_block(ota_context, context), umbrella,
        ) if block)

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(ota_context, context)
        return messages

    ##############
    # Blocks
    ##############
    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render this stage's persona with its exact runtime tool surface."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona([tool.tool_name for tool in tools], template=self.persona).strip()

    def progress_block(self, ota_context: AmphiOTAContext) -> str:
        """Render only the production cursor and current step instruction."""
        state = self.state(ota_context)
        steps = PRESENTATION_STAGE_STEPS.get(state.stage, ())
        lines = [
            "<presentation_progress>",
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
        lines.append("</presentation_progress>")
        return "\n".join(lines)

    def artifacts_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Expose artifacts produced before this round, not the Turn's final business state."""
        outputs = presentation_outputs(presentation_records(ota_context, context))
        parts: List[str] = []
        for kind in ("sources", "outline", "template"):
            receipt = outputs.get(kind) or {}
            if kind == "outline" and receipt.get("status") != "confirmed":
                continue
            if kind == "template" and receipt.get("status") not in {"selected", "skipped"}:
                continue
            relative = receipt.get("artifact")
            if not relative:
                continue
            try:
                body = read_artifact(context, relative)
            except (OSError, ValueError):
                parts.append(f'<artifact kind="{kind}" path="{relative}" status="unavailable" />')
                continue
            parts.append(f'<artifact kind="{kind}" path="{relative}">\n{json.dumps(body, ensure_ascii=False, indent=2)}\n</artifact>')
        # Mutable production documents are read explicitly through file tools.
        # Never inject a later edit or a downstream document into an earlier round.
        parts.append("Production documents: .ppt/brief.md, .ppt/plan.md, .ppt/review.md. Use file tools to read the documents needed by the current step.")
        return "<presentation_artifacts>\n" + "\n\n".join(parts) + "\n</presentation_artifacts>"

    async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Render only context that can materially affect the current deck."""
        return [
            self.transcript_block(ota_context, context),
            await self.skills_block(ota_context, context),
            await self.memory_block(ota_context, context),
            self.artifacts_block(ota_context, context),
            self.progress_block(ota_context),
            await self.workspace_block(ota_context, context),
        ]

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
                "request_presentation_outline_confirm",
                "request_presentation_template_confirm",
                "run_subagent",
                "ppt_open",
                "web_fetch",
                "web_search",
            } | POWERPOINT_READ_TOOL_NAMES),
            *TOOL_LIBRARY.get_browser_tools(include_advanced=ota_context.browser_tool_loaded),
            *TOOL_LIBRARY.get_workspace_tools(include_advanced=ota_context.workspace_tools_loaded),
            *TOOL_LIBRARY.get_skills_tools(include_advanced=ota_context.skills_tool_loaded),
        ]
        tools = TOOL_LIBRARY.select(tool.tool_name for tool in tools)
        state = ota_context.think_status
        expose_template_tools = (
            isinstance(state, PresentationStageState)
            and state.stage == "ppt_plan"
            and state.step_index == 2
        )
        if not expose_template_tools:
            tools = [tool for tool in tools if tool.tool_name not in {"ppt_rag", "request_presentation_template_confirm"}]
        expose_outline_confirm = (
            isinstance(state, PresentationStageState)
            and state.stage == "ppt_plan"
            and state.step_index == 1
        )
        if not expose_outline_confirm:
            tools = [tool for tool in tools if tool.tool_name != "request_presentation_outline_confirm"]
        return [*tools, switch_tool]

    def select_skills(self, ota_context: AmphiOTAContext, context: AmphiContext) -> Dict[str, Skill]:
        """Expose the enabled Skills selected for this mode."""
        skills = context.skills
        return skills.data() if skills is not None else {}

    ############################################################################
    # Helpers
    ############################################################################
    async def _check_action_legality(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict], agent: "AmphiAgent") -> List[CallVerdict]:
        """Keep one presentation control and validate its active production cursor."""
        resolved = await super()._check_action_legality(ota_context, context, calls, verdicts, agent)
        resolved = self._exclusive_call_verdicts(calls, resolved, {"request_presentation_template_confirm", "request_presentation_outline_confirm", "report_presentation_step"})

        def legality_reason(call: StepToolCall) -> Optional[str]:
            tool_name = getattr(call, "tool", None)
            if tool_name not in {"ppt_rag", "request_presentation_template_confirm", "request_presentation_outline_confirm", "report_presentation_step", "switch"}:
                return None
            if ota_context is None or not isinstance(ota_context.think_status, PresentationStageState):
                return "presentation control rejected: no presentation pipeline is active."
            state = ota_context.think_status
            steps = PRESENTATION_STAGE_STEPS.get(state.stage, ())
            if tool_name == "request_presentation_outline_confirm":
                if state.stage != "ppt_plan" or state.step_index != 1:
                    return "presentation outline confirmation rejected: the `map_slides` step is not active."
                arguments = {
                    _view(argument, "name"): _view(argument, "value")
                    for argument in getattr(call, "tool_arguments", None) or []
                }
                try:
                    outputs = presentation_outputs(presentation_records(ota_context, context))
                    sources = ((outputs.get("sources") or {}).get("data") or {}).get("sources") or []
                    PresentationPlanData(sources=sources).apply_plan_step_data("map_slides", parse_presentation_step_data(arguments.get("data")))
                except (TypeError, ValueError) as exc:
                    return f"presentation outline confirmation rejected: {exc}"
                return None
            if tool_name in {"ppt_rag", "request_presentation_template_confirm"}:
                if (
                    state.stage != "ppt_plan"
                    or state.step_index != 2
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
                        if current.step_id == "map_slides":
                            confirmed_artifact(presentation_outputs(presentation_records(ota_context, context)), "outline", context)
                            if "chapters" in data:
                                return "presentation step report rejected: omit `chapters`; the confirmed outline is already an artifact."
                        else:
                            PresentationPlanData().apply_plan_step_data(current.step_id, data)
                    except (OSError, TypeError, ValueError, RuntimeError) as exc:
                        return f"presentation step report rejected: {exc}"
                if state.stage == "ppt_plan" and current.step_id == "design_visual_direction":
                    try:
                        confirmed_artifact(presentation_outputs(presentation_records(ota_context, context)), "template", context)
                    except (OSError, ValueError, RuntimeError) as exc:
                        return f"presentation step report rejected: {exc}"
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
