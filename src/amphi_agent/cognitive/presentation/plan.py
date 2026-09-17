"""Cognitive worker for the presentation plan stage."""

from typing import TYPE_CHECKING, Any, Optional
from uuid import uuid4

from bridgic.amphibious import OTARecord

from ..._context import AmphiContext, AmphiOTAContext, _view
from ...prompts.presentation.plan import PRESENTATION_PLAN_PERSONA
from ...tools.ppt import RequestPresentationOutlineConfirm, RequestPresentationTemplateConfirm
from ....amphi_store import SessionTurnRecord, TurnStatus
from ..base import render_input
from ..register import cognitive_stage
from .base import PresentationThink
from .shared import presentation_outputs, presentation_records, tool_results, write_artifact
from .state import AwaitingPresentationOutlineConfirm, AwaitingPresentationTemplateSelection, PresentationPlanData, PresentationStageState, PresentationTemplateCandidate

if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="presentation", stage="ppt_plan", order=20)
class PresentationPlanThink(PresentationThink):
    """Create the evidence, visual direction, chapters, and slide map."""

    persona = PRESENTATION_PLAN_PERSONA

    async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext, previous_turn: Optional[SessionTurnRecord], agent: "AmphiAgent") -> None:
        """Write the human response to its tool receipt and materialize confirmed artifacts."""
        interaction = (previous_turn.agent_state or {}).get("interaction") or {} if previous_turn else {}
        outline_pending = interaction.get("presentation_outline_confirm") is True
        template_pending = interaction.get("presentation_template_selection") is True
        if previous_turn is None or previous_turn.status is not TurnStatus.AWAITING_HUMAN or not (outline_pending or template_pending):
            await super().init_state(ota_context, context, previous_turn, agent)
            return
        expected = "presentation_outline_confirm" if outline_pending else "presentation_template_selection"
        input_type = _view(ota_context.user_input, "type")
        if input_type not in {None, "chat", expected}:
            raise RuntimeError(f"This Session is waiting for {expected}.")
        direct_reply = input_type != expected
        request_id = interaction.get("request_id")
        if not direct_reply and _view(ota_context.user_input, "request_id") != request_id:
            raise RuntimeError("This presentation confirmation does not match the pending request.")
        state = ota_context.think_status
        if not isinstance(state, PresentationStageState) or state.stage != "ppt_plan":
            raise RuntimeError("Presentation confirmation requires the active Plan stage.")
        records = [OTARecord.model_validate(record) for record in previous_turn.ota_records]
        id_key = "outline_confirmation_id" if outline_pending else "template_selection_id"
        names = {"request_presentation_outline_confirm", "report_presentation_step"} if outline_pending else {"request_presentation_template_confirm", "ppt_rag"}
        receipt = next((payload for name, payload in reversed(list(tool_results(records))) if name in names and payload.get(id_key) == request_id), None)
        if receipt is None:
            raise RuntimeError("The pending presentation tool result is missing; request confirmation again.")
        feedback = render_input(ota_context.user_input).strip() if direct_reply else ""
        # Exclude the pending Turn from retained history before restoring its rounds.
        retained_context = context.session.without_last()
        prior = [record for turn in retained_context.get_all() for record in turn.ota_records]
        outputs = presentation_outputs([*prior, *records])
        update: dict[str, Any] = {"feedback": feedback or None}
        if outline_pending:
            if direct_reply:
                update["status"] = "revision_requested"
                message = "The user requested outline changes. Revise the outline and request confirmation again."
                # Old report-owned confirmations had already advanced this cursor.
                state = state.model_copy(update={"step_index": 1})
            else:
                sources = ((outputs.get("sources") or {}).get("data") or {}).get("sources") or []
                data = PresentationPlanData(sources=sources).apply_plan_step_data("map_slides", {"chapters": _view(ota_context.user_input, "chapters")})
                chapters = [chapter.model_dump(mode="json") for chapter in data.outline]
                update.update(status="confirmed", chapters=chapters, artifact=write_artifact(context, "outline", {"chapters": chapters}))
                message = "The user confirmed the outline. Its artifact contains the user's edits."
                message += " The map_slides step was already reported; continue with visual design." if state.step_index == 2 else " Call `report_presentation_step` without resubmitting chapters; confirmation does not advance the step."
        else:
            if state.step_index != 2:
                raise RuntimeError("Template confirmation requires Plan's visual-direction step.")
            action = "feedback" if direct_reply else _view(ota_context.user_input, "action")
            candidates = receipt.get("candidates")
            if candidates is None:
                search = next((payload for name, payload in tool_results(records) if name == "ppt_rag" and payload.get("search_id") == receipt.get("search_id") and "candidates" in payload), {})
                candidates = search.get("candidates") or []
            update["candidates"] = candidates
            if action == "select":
                template_id = _view(ota_context.user_input, "template_id")
                selected = next((item for item in candidates if item.get("template_id") == template_id), None)
                if selected is None:
                    raise RuntimeError("The selected template is not part of this tool's candidate batch.")
                selected = PresentationTemplateCandidate.model_validate(selected)
                update.update(status="selected", selected_template_id=selected.template_id, selected_template=selected.model_dump(mode="json"))
                update["artifact"] = write_artifact(context, "template", {"status": "selected", "selected_template": selected.agent_context()})
                message = "The user selected a template. Use its confirmed artifact to finish the visual plan, then call `report_presentation_step`."
            elif action == "skip":
                update.update(status="skipped", selected_template_id=None, selected_template=None)
                update["artifact"] = write_artifact(context, "template", {"status": "skipped", "selected_template": None})
                message = "The user chose to skip templates. Finish the custom visual plan, then call `report_presentation_step`."
            elif action in {"refresh", "feedback"}:
                excluded = list(dict.fromkeys([*(receipt.get("excluded_template_ids") or []), *(item["template_id"] for item in candidates)])) if action == "refresh" and candidates else []
                update.update(status="refresh_requested" if action == "refresh" else "revision_requested", excluded_template_ids=excluded)
                message = "Retrieve templates again using the user's feedback and call `request_presentation_template_confirm` with the new search_id."
            else:
                raise RuntimeError("Template selection requires select, skip, refresh, or a chat reply.")
        receipt.update(update)
        records[-1].observation_result = "\n".join(value for value in (records[-1].observation_result, message) if value)
        ota_context.ota_record = records
        ota_context.transition_think(state)
        ota_context.transition_interaction(None)
        context.session = retained_context
        ota_context.user_input = agent._renderable_user_input(previous_turn.user_input)

    async def handle_action_result(self, ota_context: AmphiOTAContext, context: AmphiContext, agent: "AmphiAgent") -> None:
        """Store pending content in the requesting tool, leaving the step unchanged."""
        await super().handle_action_result(ota_context, context, agent)
        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue
            payload = step.tool_result
            state = ota_context.think_status
            if isinstance(payload, (RequestPresentationOutlineConfirm, RequestPresentationTemplateConfirm)):
                expected_step = 1 if isinstance(payload, RequestPresentationOutlineConfirm) else 2
                if not isinstance(state, PresentationStageState) or state.stage != "ppt_plan" or state.step_index != expected_step:
                    step.success = False
                    step.error = "Presentation confirmation requires its active Plan step."
                    step.tool_result = None
                    continue
            if isinstance(payload, RequestPresentationOutlineConfirm):
                outputs = presentation_outputs(presentation_records(ota_context, context))
                sources = ((outputs.get("sources") or {}).get("data") or {}).get("sources") or []
                data = PresentationPlanData(sources=sources).apply_plan_step_data("map_slides", payload.data)
                request_id = f"presentation_outline_{uuid4().hex}"
                step.tool_result = {
                    "outline_confirmation_id": request_id, "status": "awaiting_outline_confirmation",
                    "chapters": [chapter.model_dump(mode="json") for chapter in data.outline],
                }
                ota_context.transition_interaction(AwaitingPresentationOutlineConfirm(request_id=request_id))
            elif isinstance(payload, RequestPresentationTemplateConfirm):
                def reject(message: str) -> None:
                    step.success = False
                    step.error = message
                    step.tool_result = None

                search = next((result for name, result in reversed(list(tool_results(ota_context.ota_record))) if name == "ppt_rag" and result.get("search_id") == payload.search_id), None)
                if search is None:
                    reject("search_id does not match a completed ppt_rag result in this Turn. Retrieve templates first.")
                    continue
                candidates = []
                invalid_count = 0
                raw_candidates = search.get("candidates")
                for candidate in (raw_candidates if isinstance(raw_candidates, list) else [])[:8]:
                    try:
                        candidates.append(PresentationTemplateCandidate.model_validate(candidate).model_dump(mode="json"))
                    except (TypeError, ValueError):
                        invalid_count += 1
                retrieval_error = str(search.get("retrieval_error") or "").strip()[:1000]
                if search.get("status") == "retrieval_failed":
                    retrieval_error = retrieval_error or "Template retrieval failed. Retry or skip."
                elif not candidates:
                    reject("PPT template retrieval returned no selectable candidates.")
                    continue
                outputs = presentation_outputs(presentation_records(ota_context, context))
                request_id = f"presentation_template_{uuid4().hex}"
                step.tool_result = {
                    "search_id": payload.search_id, "template_selection_id": request_id,
                    "status": "awaiting_template_selection", "candidates": candidates,
                    "candidate_count": len(candidates), "candidate_ids": [item["template_id"] for item in candidates],
                    "excluded_template_ids": (outputs.get("template") or {}).get("excluded_template_ids") or [],
                    **({"retrieval_error": retrieval_error} if retrieval_error else {}),
                    **({"discarded_candidate_count": invalid_count} if invalid_count else {}),
                }
                ota_context.transition_interaction(AwaitingPresentationTemplateSelection(request_id=request_id))
            else:
                continue
            if ota_context.stream is not None:
                agent._publish_stage(ota_context, state, context)
