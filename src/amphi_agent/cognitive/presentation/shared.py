"""Shared presentation steps, artifacts, and views of recorded tool results."""

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Tuple
from uuid import uuid4


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
            "Design the chapter narrative and its editable page blueprint together: every slide's purpose, key message, content, and source links. Call `request_presentation_outline_confirm` alone and wait for the user to confirm; then call `report_presentation_step` without resubmitting chapters to advance.",
        ),
        PresentationStep(
            "design_visual_direction",
            "After outline confirmation, call `ppt_rag` with `limit=8`, read its result, then call `request_presentation_template_confirm` alone with the returned `search_id` and wait for the user's template decision. Then define the visual system from the selected template or explicit skip decision, and record the selected template id, version, and materialization reference in the plan.",
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
    "ppt_brief": ".ppt/brief.md",
    "ppt_plan": ".ppt/plan.md",
    "ppt_review": ".ppt/review.md",
}


def tool_results(records: Iterable[Any]):
    """Read successful results in execution order without changing their payloads."""
    from ..._context import _view

    for record in records:
        for step in _view(_view(record, "action_result"), "results") or []:
            if _view(step, "success") is False:
                continue
            payload = _view(step, "tool_result")
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except ValueError:
                    continue
            if isinstance(payload, dict):
                yield _view(step, "tool_name"), payload


def presentation_records(ota_context: Any, context: Any = None) -> list[Any]:
    """Use preceding Turns plus only the rounds supplied by the caller."""
    session = getattr(context, "session", None)
    records = [record for turn in session.get_all() for record in turn.ota_records] if session else []
    return [*records, *ota_context.ota_record]


def presentation_outputs(records: Iterable[Any]) -> dict[str, Any]:
    """Find the current presentation's receipts; a new entry or rewind resets its scope."""
    outputs: dict[str, Any] = {"reports": []}
    for name, payload in tool_results(records):
        if name == "request_presentation":
            outputs = {"goal": payload.get("goal"), "reports": []}
        elif name == "switch" and payload.get("stage") in {"ppt_brief", "ppt_plan"}:
            for key in ("sources", "outline", "template"):
                outputs.pop(key, None)
            outputs["reports"] = []
        elif name == "report_presentation_step":
            outputs["reports"].append(payload)
            if payload.get("step_id") == "collect_evidence":
                outputs["sources"] = payload
                outputs.pop("outline", None)
                outputs.pop("template", None)
            # Legacy reports also carried the outline interaction.
            if payload.get("outline_confirmation_id"):
                outputs["outline"] = payload
        elif name == "request_presentation_outline_confirm":
            outputs["outline"] = payload
            outputs.pop("template", None)
        elif name in {"request_presentation_template_confirm", "ppt_rag"} and payload.get("template_selection_id"):
            outputs["template"] = payload
    return outputs


def presentation_view(records: Iterable[Any]) -> dict[str, Any]:
    """Project the existing client fields from tool receipts, never from cognitive state."""
    outputs = presentation_outputs(records)
    outline = outputs.get("outline") or {}
    template = outputs.get("template") or {}
    status = template.get("status")
    return {
        "presentation_goal": outputs.get("goal"),
        "presentation_reports": [
            {key: report.get(key) for key in ("stage", "step_id", "summary", "evidence")}
            for report in outputs["reports"]
        ],
        "presentation_sources": (outputs.get("sources", {}).get("data") or {}).get("sources") or [],
        "presentation_outline": outline.get("chapters") or [],
        "presentation_outline_confirmed": outline.get("status") == "confirmed",
        "presentation_outline_confirmation_id": outline.get("outline_confirmation_id") if outline.get("status") == "awaiting_outline_confirmation" else None,
        "presentation_template_candidates": (template.get("candidates") or []) if status in {"awaiting_template_selection", "selected", "skipped"} else [],
        "presentation_template_selection_id": template.get("template_selection_id") if status == "awaiting_template_selection" else None,
        "presentation_template_selection_status": "pending" if status == "awaiting_template_selection" else status if status in {"selected", "skipped"} else "idle",
        "presentation_template_selection_error": template.get("retrieval_error") if status == "awaiting_template_selection" else None,
        "presentation_selected_template": template.get("selected_template") if status == "selected" else None,
    }


def write_artifact(context: Any, kind: str, data: dict[str, Any]) -> str:
    """Write a distinct confirmed output so a later confirmation cannot overwrite it."""
    if context.workspace is None:
        raise RuntimeError("Presentation artifacts require a Session workspace.")
    root = context.workspace.work_dir / ".ppt"
    if root.is_symlink():
        raise RuntimeError("Presentation artifact directory must not be a symlink.")
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{kind}-{uuid4().hex}.json"
    with path.open("x", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.write("\n")
    return str(path.relative_to(context.workspace.work_dir))


def read_artifact(context: Any, relative: str) -> dict[str, Any]:
    """Read a receipt-owned artifact inside this Session's .ppt directory."""
    if context.workspace is None:
        raise RuntimeError("Presentation artifacts require a Session workspace.")
    root = context.workspace.work_dir / ".ppt"
    path = context.workspace.work_dir / relative
    if root.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Presentation artifact must belong to this Session's .ppt directory.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Presentation artifact must contain an object.")
    return payload


def confirmed_artifact(outputs: dict[str, Any], kind: str, context: Any) -> dict[str, Any]:
    """Resolve only an artifact referenced by the supplied execution history."""
    receipt = outputs.get(kind) or {}
    expected = {"outline": {"confirmed"}, "template": {"selected", "skipped"}}
    if kind in expected and receipt.get("status") not in expected[kind]:
        raise ValueError(f"The {kind} has not been confirmed; call its human-interaction tool first.")
    path = receipt.get("artifact")
    if not isinstance(path, str) or not path:
        raise ValueError(f"The {kind} has no recorded artifact.")
    return read_artifact(context, path)
