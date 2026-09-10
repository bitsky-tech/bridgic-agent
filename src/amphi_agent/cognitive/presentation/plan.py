"""Cognitive worker for the presentation plan stage."""

import json
from typing import TYPE_CHECKING, Any, List, Optional
from uuid import uuid4

from bridgic.amphibious import OTARecord

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
from ..base import render_input
from ....amphi_store import SessionTurnRecord, TurnStatus


if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="presentation", stage="ppt_plan", order=20)
class PresentationPlanThink(PresentationThink):
    """Create the evidence, visual direction, chapters, and slide map."""

    persona = PRESENTATION_PLAN_PERSONA

    ############################################################################
    # The agent design
    ############################################################################
    async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: Optional[SessionTurnRecord], agent: "AmphiAgent") -> None:
        """Restore Plan's outline or template decision from the pending Turn."""
        if previous_turn is None or previous_turn.status is not TurnStatus.AWAITING_HUMAN:
            await super().init_state(ota_context, context, previous_turn, agent)
            return
        interaction = (previous_turn.agent_state or {}).get("interaction") or {}
        if not (
            interaction.get("presentation_outline_confirm") is True
            or interaction.get("presentation_template_selection") is True
        ):
            await super().init_state(ota_context, context, previous_turn, agent)
            return

        async def _resume_presentation_outline_confirm(ota_context: AmphiOTAContext, context: AmphiContext, pending_turn: SessionTurnRecord, original_user_input: Any) -> None:
            """Resume Plan with the user's edited and confirmed slide outline."""
            def field(name: str) -> Any:
                if isinstance(ota_context.user_input, dict):
                    return ota_context.user_input.get(name)
                return getattr(ota_context.user_input, name, None)

            pending = AwaitingPresentationOutlineConfirm.model_validate(
                pending_turn.agent_state.get("interaction") or {},
            )
            input_type = field("type")
            if input_type not in {None, "chat", "presentation_outline_confirm"}:
                raise RuntimeError("This Session is waiting for a presentation outline confirmation.")
            direct_reply = input_type != "presentation_outline_confirm"
            if not direct_reply and field("request_id") != pending.request_id:
                raise RuntimeError("This presentation outline confirmation does not match the pending request.")

            state = ota_context.think_status
            if not isinstance(state, PresentationStageState) or state.stage != "ppt_plan":
                raise RuntimeError("Presentation outline confirmation requires the active Plan stage.")
            feedback = render_input(ota_context.user_input).strip() if direct_reply else ""
            if direct_reply:
                reports = [
                    report for report in state.reports
                    if not (report.stage == "ppt_plan" and report.step_id == "map_slides")
                ]
                state = state.model_copy(update={
                    "step_index": 1,
                    "reports": reports,
                    "outline_confirmed": False,
                    "outline_confirmation_id": None,
                })
                message = (
                    "The user replied while reviewing the editable presentation outline. "
                    f"Revise the chapter and slide map around this feedback:\n\n{feedback}"
                )
            else:
                chapters = field("chapters")
                state = state.apply_plan_step_data("map_slides", {"chapters": chapters}).model_copy(update={
                    "outline_confirmed": True,
                    "outline_confirmation_id": None,
                })
                message = (
                    "The user confirmed the editable chapter and slide outline. Continue with "
                    "the visual direction step using this confirmed runtime outline as the source of truth."
                )

            ota_context.ota_record = [OTARecord.model_validate(record) for record in pending_turn.ota_records]

            def update_confirmation_result(status: str) -> None:
                for record in reversed(ota_context.ota_record):
                    steps = (record.action_result or {}).get("results") or []
                    for step in reversed(steps):
                        if step.get("tool_name") != "report_presentation_step":
                            continue
                        payload = step.get("tool_result")
                        if (
                            not isinstance(payload, dict)
                            or payload.get("outline_confirmation_id") != pending.request_id
                        ):
                            continue
                        payload.update({"status": status, "feedback": feedback or None})
                        return

            update_confirmation_result("revision_requested" if direct_reply else "confirmed")
            record = ota_context.ota_record[-1] if ota_context.ota_record else None
            if record is None:
                ota_context.ota_record.append(OTARecord(observation_result=message))
            else:
                existing = getattr(record, "observation_result", None)
                record.observation_result = f"{existing}\n{message}" if existing else message
            ota_context.transition_think(state)
            ota_context.transition_interaction(None)
            context.session = context.session.without_last()
            ota_context.user_input = original_user_input

        async def _resume_presentation_template_selection(ota_context: AmphiOTAContext, context: AmphiContext, pending_turn: SessionTurnRecord, original_user_input: Any) -> None:
            """Resume Plan after the user selects, skips, or refreshes templates."""
            def field(name: str) -> Any:
                if isinstance(ota_context.user_input, dict):
                    return ota_context.user_input.get(name)
                return getattr(ota_context.user_input, name, None)

            pending = AwaitingPresentationTemplateSelection.model_validate(
                pending_turn.agent_state.get("interaction") or {},
            )
            input_type = field("type")
            if input_type not in {None, "chat", "presentation_template_selection"}:
                raise RuntimeError("This Session is waiting for a presentation template selection.")
            direct_reply = input_type != "presentation_template_selection"
            if not direct_reply and field("request_id") != pending.request_id:
                raise RuntimeError("This presentation template selection does not match the pending request.")

            state = ota_context.think_status
            if not isinstance(state, PresentationStageState) or state.stage != "ppt_plan" or state.step_index != 2:
                raise RuntimeError("Presentation template selection requires Plan's visual-direction step.")
            feedback = render_input(ota_context.user_input).strip() if direct_reply else ""
            action = "feedback" if direct_reply else str(field("action") or "")
            selected_template: Optional[PresentationTemplateCandidate] = None
            if action == "select":
                template_id = str(field("template_id") or "")
                selected_template = next(
                    (candidate for candidate in state.template_candidates if candidate.template_id == template_id),
                    None,
                )
                if selected_template is None:
                    raise RuntimeError("The selected presentation template is not part of this shortlist.")
                state = state.model_copy(update={
                    "template_selection_id": None,
                    "template_selection_status": "selected",
                    "template_selection_error": None,
                    "selected_template": selected_template,
                })
                selected_context = selected_template.agent_context()
                message = (
                    "The user selected this verified PowerPoint template. Treat its id, version, "
                    "materialization reference, and structural evidence as the visual-direction source of truth:\n\n"
                    + json.dumps(selected_context, ensure_ascii=False, indent=2)
                )
            elif action == "skip":
                state = state.model_copy(update={
                    "template_selection_id": None,
                    "template_selection_status": "skipped",
                    "template_selection_error": None,
                    "selected_template": None,
                })
                message = "The user explicitly chose not to use a retrieved template. Continue with a custom visual system."
            elif action == "refresh":
                excluded = (
                    list(dict.fromkeys([
                        *state.template_excluded_ids,
                        *(candidate.template_id for candidate in state.template_candidates),
                    ]))
                    if state.template_candidates
                    else []
                )
                state = state.model_copy(update={
                    "template_candidates": [],
                    "template_selection_id": None,
                    "template_selection_status": "idle",
                    "template_selection_error": None,
                    "selected_template": None,
                    "template_excluded_ids": excluded,
                })
                message = (
                    "The user requested another template batch. Call `ppt_rag` again by itself; "
                    "the previous candidate ids are excluded by runtime state."
                )
            elif direct_reply:
                state = state.model_copy(update={
                    "template_candidates": [],
                    "template_selection_id": None,
                    "template_selection_status": "idle",
                    "template_selection_error": None,
                    "selected_template": None,
                })
                message = (
                    "The user replied while reviewing template candidates. Re-run template retrieval "
                    f"around this feedback:\n\n{feedback}"
                )
            else:
                raise RuntimeError("Presentation template selection requires action `select`, `skip`, or `refresh`.")

            ota_context.ota_record = [OTARecord.model_validate(record) for record in pending_turn.ota_records]

            def update_selection_result() -> None:
                for record in reversed(ota_context.ota_record):
                    steps = (record.action_result or {}).get("results") or []
                    for step in reversed(steps):
                        if step.get("tool_name") != "ppt_rag":
                            continue
                        payload = step.get("tool_result")
                        if not isinstance(payload, dict) or payload.get("template_selection_id") != pending.request_id:
                            continue
                        search_id = payload.get("search_id")
                        payload.clear()
                        payload.update({
                            "search_id": search_id,
                            "template_selection_id": pending.request_id,
                            "status": (
                                "selected" if action == "select"
                                else "skipped" if action == "skip"
                                else "refresh_requested" if action == "refresh"
                                else "revision_requested"
                            ),
                            "selected_template_id": selected_template.template_id if selected_template else None,
                            "feedback": feedback or None,
                        })
                        return

            update_selection_result()
            record = ota_context.ota_record[-1] if ota_context.ota_record else None
            if record is None:
                ota_context.ota_record.append(OTARecord(observation_result=message))
            else:
                existing = getattr(record, "observation_result", None)
                record.observation_result = f"{existing}\n{message}" if existing else message
            ota_context.transition_think(state)
            ota_context.transition_interaction(None)
            context.session = context.session.without_last()
            ota_context.user_input = original_user_input

        if interaction.get("presentation_outline_confirm") is True:
            await _resume_presentation_outline_confirm(
                ota_context, context, previous_turn, agent._renderable_user_input(previous_turn.user_input),
            )
        elif interaction.get("presentation_template_selection") is True:
            await _resume_presentation_template_selection(
                ota_context, context, previous_turn, agent._renderable_user_input(previous_turn.user_input),
            )

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
