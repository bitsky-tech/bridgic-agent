"""Shared presentation stage definitions and production steps."""

from dataclasses import dataclass
from typing import Dict, Tuple


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
            "collect_evidence",
            "Use supplied files and conversation first; one sufficient source is enough, otherwise collect only the 3–5 high-quality sources needed in one bounded non-browser research pass, without routine delegation.",
        ),
        PresentationStep(
            "map_slides",
            "Design the chapter narrative and its editable page blueprint together: every slide's purpose, key message, content, and source links.",
        ),
        PresentationStep(
            "design_visual_direction",
            "After outline confirmation, call `ppt_rag` with `limit=8` by itself and wait for the user's template decision. Then define the visual system from the selected template or explicit skip decision, and record the selected template id, version, and materialization reference in the plan.",
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
