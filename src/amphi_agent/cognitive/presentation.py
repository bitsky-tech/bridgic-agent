"""Dedicated cognitive pipeline for planning, composing, and reviewing presentations."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from bridgic.amphibious import StepToolCall
from bridgic.core.model.types import Message, Role

from .._cognitive import MainThink
from .._context import AmphiContext, AmphiOTAContext, _view
from .._state import PresentationStageState
from ..prompts.presentation import (
    PRESENTATION_BRIEF_PERSONA,
    PRESENTATION_COMPOSE_PERSONA,
    PRESENTATION_PLAN_PERSONA,
    PRESENTATION_REVIEW_PERSONA,
)
from ..prompts.render import render_stage_persona
from ..tools import switch_tool


@dataclass(frozen=True)
class PresentationStep:
    """One observable unit of work inside a presentation stage."""

    step_id: str
    instruction: str


PRESENTATION_STAGE_ORDER: Tuple[str, ...] = (
    "ppt_brief",
    "ppt_plan",
    "ppt_compose",
    "ppt_review",
)

PRESENTATION_STAGE_STEPS: Dict[str, Tuple[PresentationStep, ...]] = {
    "ppt_plan": (
        PresentationStep(
            "design_visual_direction",
            "Choose the template strategy and define palette, typography, imagery, and recurring layout roles.",
        ),
        PresentationStep(
            "collect_evidence",
            "Collect only the content, data, source links, and citations needed to support the deck.",
        ),
        PresentationStep(
            "shape_chapters",
            "Turn the communication goal into a coherent chapter sequence with a clear narrative arc.",
        ),
        PresentationStep(
            "map_slides",
            "Create the production blueprint: every slide's purpose, key message, content, and visual treatment.",
        ),
    ),
    "ppt_compose": (
        PresentationStep(
            "build_slide_shells",
            "Open the live deck, apply the design system, and create all slide shells and layout roles first.",
        ),
        PresentationStep(
            "fill_slide_content",
            "Fill concise titles, body copy, data, speaker-facing detail, and citations from the blueprint.",
        ),
        PresentationStep(
            "create_visuals",
            "Add or generate the planned images, diagrams, charts, and backgrounds without obscuring the message.",
        ),
        PresentationStep(
            "polish_deck",
            "Normalize spacing, hierarchy, alignment, repeated elements, and chapter continuity across the deck.",
        ),
    ),
    "ppt_review": (
        PresentationStep(
            "audit_narrative",
            "Review the deck end to end for story logic, pacing, and whether every slide advances the goal.",
        ),
        PresentationStep(
            "audit_evidence",
            "Verify material claims, data, citations, and source traceability; repair unsupported content.",
        ),
        PresentationStep(
            "inspect_visual_quality",
            "Inspect hierarchy, density, contrast, alignment, consistency, clipping, and overflow in the live deck.",
        ),
        PresentationStep(
            "confirm_delivery",
            "Fix remaining material defects and record the final delivery scope and any explicit limitations.",
        ),
    ),
}

PRESENTATION_STAGE_ARTIFACTS = {
    "ppt_brief": ".presentation/brief.md",
    "ppt_plan": ".presentation/plan.md",
    "ppt_review": ".presentation/review.md",
}


class PresentationThink(MainThink):
    """Shared tool surface and context for all presentation stages."""

    allowed_tools = (
        MainThink.allowed_tools
        - {
            "create_schedule",
            "delete_schedule",
            "edit_workflow",
            "get_schedule",
            "help",
            "list_schedules",
            "remove_workflow",
            "request_build",
            "request_presentation",
            "request_run_workflow",
            "start_subagent",
            "update_schedule",
        }
        | {"report_presentation_step"}
    )

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
            self.progress_block(ota_context),
            self.artifacts_block(context),
            await self.skills_block(ota_context, context),
            await self.memory_block(ota_context, context),
            await self.workspace_block(ota_context, context),
        ]

    def system_block(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Render this stage's persona with its exact runtime tool surface."""
        tools = self.select_tools(ota_context, context)
        return render_stage_persona([tool.tool_name for tool in tools], template=self.persona).strip()

    def select_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[Any]:
        """Return presentation tools plus the cognitive handoff control."""
        return [*super().select_tools(ota_context, context), switch_tool]

    async def assemble_messages(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[Message]:
        """Assemble every presentation stage with its exact runtime tool surface."""
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.context_blocks(ota_context, context)
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = self.assemble_system(
            ota_context,
            context,
            self.system_block(ota_context, context),
            umbrella,
        )

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(ota_context, context)
        return messages

    async def legality_check(self, call: StepToolCall, ota_context: Optional[AmphiOTAContext], context: AmphiContext) -> Optional[str]:
        """Keep reports and stage handoffs aligned with the production cursor."""
        tool_name = getattr(call, "tool", None)
        if tool_name not in {"report_presentation_step", "switch"}:
            return None
        if ota_context is None or not isinstance(ota_context.think_status, PresentationStageState):
            return "presentation control rejected: no presentation pipeline is active."
        state = ota_context.think_status
        steps = PRESENTATION_STAGE_STEPS.get(state.stage, ())
        if tool_name == "report_presentation_step":
            if not steps:
                return "presentation step report rejected: this stage has no reportable production steps."
            if state.step_index >= len(steps):
                return "presentation step report rejected: this stage has no unfinished step."
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


class PresentationBriefThink(PresentationThink):
    """Establish the deck's communication contract before planning slides."""

    persona = PRESENTATION_BRIEF_PERSONA
    allowed_tools = PresentationThink.allowed_tools - {"report_presentation_step"}


class PresentationPlanThink(PresentationThink):
    """Create the evidence, visual direction, chapters, and slide map."""

    persona = PRESENTATION_PLAN_PERSONA


class PresentationComposeThink(PresentationThink):
    """Build the live deck from the approved production contract."""

    persona = PRESENTATION_COMPOSE_PERSONA


class PresentationReviewThink(PresentationThink):
    """Inspect and revise the deck before returning control to Main."""

    persona = PRESENTATION_REVIEW_PERSONA


__all__ = [
    "PRESENTATION_STAGE_ARTIFACTS",
    "PRESENTATION_STAGE_ORDER",
    "PRESENTATION_STAGE_STEPS",
    "PresentationBriefThink",
    "PresentationComposeThink",
    "PresentationPlanThink",
    "PresentationReviewThink",
    "PresentationStep",
    "PresentationThink",
]
