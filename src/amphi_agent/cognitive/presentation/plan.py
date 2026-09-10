"""Cognitive worker for the presentation plan stage."""

import json
from typing import TYPE_CHECKING, List
from uuid import uuid4

from ..._context import AmphiContext, AmphiOTAContext
from ..._state import (
    AwaitingPresentationOutlineConfirm,
    AwaitingPresentationTemplateSelection,
    PresentationStageState,
    PresentationTemplateCandidate,
)
from ...prompts.presentation.plan import PRESENTATION_PLAN_PERSONA

from ..register import cognitive_stage
from .base import PresentationThink


if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="presentation", stage="ppt_plan", order=20)
class PresentationPlanThink(PresentationThink):
    """Create the evidence, visual direction, chapters, and slide map."""

    persona = PRESENTATION_PLAN_PERSONA

    ############################################################################
    # The agent design
    ############################################################################
    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Pause Plan for outline confirmation and template selection."""
        await super().handle_action_result(ota_context, context, agent)
        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            if step.tool_name == "ppt_rag":
                def reject(message: str) -> None:
                    step.success = False
                    step.error = message
                    step.tool_result = None

                current_status = ota_context.think_status
                payload = step.tool_result
                if (
                    isinstance(payload, dict)
                    and payload.get("status") == "awaiting_template_selection"
                    and isinstance(current_status, PresentationStageState)
                    and current_status.template_selection_id == payload.get("template_selection_id")
                ):
                    continue
                try:
                    payload = json.loads(payload) if isinstance(payload, str) else payload
                except (TypeError, ValueError) as exc:
                    reject(f"PPT template retrieval returned invalid JSON: {exc}")
                    continue
                if not isinstance(payload, dict):
                    reject("PPT template retrieval returned an invalid result object.")
                    continue
                if not isinstance(current_status, PresentationStageState) or current_status.stage != "ppt_plan" or current_status.step_index != 2:
                    reject("PPT template retrieval is only valid during Plan's visual-direction step.")
                    continue

                candidates: List[PresentationTemplateCandidate] = []
                invalid_candidates: List[str] = []
                raw_candidates = payload.get("candidates")
                for index, candidate in enumerate(raw_candidates[:8] if isinstance(raw_candidates, list) else []):
                    try:
                        candidates.append(PresentationTemplateCandidate.model_validate(candidate))
                    except (TypeError, ValueError) as exc:
                        invalid_candidates.append(f"candidate {index + 1}: {exc}")
                retrieval_failed = payload.get("status") == "retrieval_failed"
                retrieval_error = str(payload.get("retrieval_error") or "").strip()[:1_000]
                if retrieval_failed and not retrieval_error:
                    retrieval_error = "Template retrieval did not return an actionable result."
                if not candidates and not retrieval_failed:
                    detail = f" ({invalid_candidates[0]})" if invalid_candidates else ""
                    reject("PPT template retrieval returned no selectable candidates." + detail)
                    continue

                request_id = f"presentation_template_{uuid4().hex}"
                next_status = current_status.model_copy(update={
                    "template_candidates": candidates,
                    "template_selection_id": request_id,
                    "template_selection_status": "pending",
                    "template_selection_error": retrieval_error or None,
                    "selected_template": None,
                })
                ota_context.transition_think(next_status)
                ota_context.transition_interaction(AwaitingPresentationTemplateSelection(request_id=request_id))
                step.tool_result = {
                    "search_id": payload.get("search_id"),
                    "index_id": payload.get("index_id"),
                    "retrieval_mode": payload.get("retrieval_mode"),
                    "template_selection_id": request_id,
                    "status": "awaiting_template_selection",
                    "candidate_count": len(candidates),
                    "candidate_ids": [candidate.template_id for candidate in candidates],
                    **({"retrieval_error": retrieval_error} if retrieval_error else {}),
                    **({"discarded_candidate_count": len(invalid_candidates)} if invalid_candidates else {}),
                }
                if ota_context.stream is not None:
                    agent._publish_stage(ota_context, next_status)
            elif step.tool_name == "report_presentation_step":
                payload = step.tool_result
                current_status = ota_context.think_status
                if (
                    isinstance(payload, dict)
                    and payload.get("stage") == "ppt_plan"
                    and payload.get("step_id") == "map_slides"
                    and payload.get("status") != "awaiting_outline_confirmation"
                    and isinstance(current_status, PresentationStageState)
                    and current_status.stage == "ppt_plan"
                ):
                    request_id = f"presentation_outline_{uuid4().hex}"
                    next_status = current_status.model_copy(update={
                        "outline_confirmed": False,
                        "outline_confirmation_id": request_id,
                    })
                    ota_context.transition_interaction(AwaitingPresentationOutlineConfirm(
                        request_id=request_id,
                    ))
                    ota_context.transition_think(next_status)
                    payload.update({
                        "outline_confirmation_id": next_status.outline_confirmation_id,
                        "status": "awaiting_outline_confirmation",
                    })
                    if ota_context.stream is not None:
                        agent._publish_stage(ota_context, next_status)
