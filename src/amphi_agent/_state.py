from ast import literal_eval
from typing import Annotated, Any, Dict, List, Literal, Optional, TypeAlias, Union
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator, model_serializer, model_validator

__all__ = [
    "InStage", "NormalStageState", "BuildStageState", "PresentationStageState",
    "PresentationChapterOutline", "PresentationSlideOutline", "PresentationSource",
    "PresentationStepRecord", "PresentationTemplateCandidate", "WorkflowStageState",
    "InteractionState", "AwaitingFeedback", "AwaitingPermission", "AwaitingTaskConfirm",
    "AwaitingWorkflowConfirm", "AwaitingBuildConfirm",
    "AwaitingBuildConflict", "AwaitingPresentationOutlineConfirm", "AwaitingPresentationTemplateSelection", "AwaitingWorkflowRunChoice",
    "SubAgentCall", "AwaitingSubAgent", "SubAgentResult", "SubAgentsCompleted", "AgentResult",
    "AgentState", "ContextCompactionState", "TurnCompactionState",
    "CallVerdict", "RoundPermission",
]


################################################################################################################
# Think Status
################################################################################################################
class NormalStageState(BaseModel):
    """The dispatchable Main position in normal chat mode."""

    mode: Literal["normal"] = "normal"
    stage: Literal["main"] = "main"


class BuildStageState(BaseModel):
    """The current cognitive stage inside the Session's unfinished Build."""

    mode: Literal["build"] = "build"
    stage: str = Field(min_length=1)
    workflow_id: Optional[str] = Field(default=None, min_length=1)

    @model_serializer(mode="wrap")
    def _serialize(self, handler: Any) -> Dict[str, Any]:
        payload = handler(self)
        if self.workflow_id is None:
            payload.pop("workflow_id", None)
        return payload


class PresentationStepRecord(BaseModel):
    """One completed production step retained across presentation stages and turns."""

    stage: Literal["ppt_brief", "ppt_plan", "ppt_compose", "ppt_review"]
    step_id: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    evidence: List[str] = Field(default_factory=list)

    @classmethod
    def normalize_evidence(cls, value: Any) -> List[str]:
        """Accept legacy string-shaped tool arguments without splitting them into characters."""
        def parse_list(text: str) -> Optional[List[Any]]:
            if not (text.startswith("[") and text.endswith("]")):
                return None
            try:
                parsed = literal_eval(text)
            except (SyntaxError, ValueError):
                return None
            return list(parsed) if isinstance(parsed, (list, tuple)) else None

        if value is None:
            return []
        if isinstance(value, str):
            text = value.strip()
            value = parse_list(text) or ([text] if text else [])
        elif isinstance(value, (list, tuple)):
            items = list(value)
            if items and all(isinstance(item, str) and len(item) == 1 for item in items):
                joined = "".join(items).strip()
                value = parse_list(joined) or items
            else:
                value = items
        else:
            value = [value]

        normalized: List[str] = []
        for item in value:
            text = str(item).strip()
            if text and text not in normalized:
                normalized.append(text)
        return normalized

    @field_validator("evidence", mode="before")
    @classmethod
    def _validate_evidence(cls, value: Any) -> List[str]:
        return cls.normalize_evidence(value)


class PresentationSource(BaseModel):
    """One selected source shown in the presentation research surface."""

    id: str = Field(min_length=1)
    kind: Literal["web", "file", "conversation"]
    title: str = Field(min_length=1, max_length=300)
    locator: Optional[str] = Field(default=None, max_length=2_000)
    excerpt: Optional[str] = Field(default=None, max_length=2_000)
    usage: Optional[str] = Field(default=None, max_length=1_000)


class PresentationSlideOutline(BaseModel):
    """One editable page inside the presentation outline."""

    id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=300)
    purpose: Optional[str] = Field(default=None, max_length=1_000)
    key_message: Optional[str] = Field(default=None, max_length=2_000)
    content_outline: List[str] = Field(default_factory=list, max_length=8)
    source_ids: List[str] = Field(default_factory=list, max_length=30)


class PresentationChapterOutline(BaseModel):
    """One editable chapter and its ordered presentation pages."""

    id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=300)
    summary: Optional[str] = Field(default=None, max_length=2_000)
    slides: List[PresentationSlideOutline] = Field(default_factory=list, max_length=80)


class PresentationTemplateCandidate(BaseModel):
    """One verified template candidate retained while Plan waits for selection."""

    template_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=300)
    aspect_ratio: Optional[str] = None
    slide_count: Optional[int] = Field(default=None, ge=1)
    semantic_tags: List[str] = Field(default_factory=list, max_length=40)
    strengths: List[str] = Field(default_factory=list, max_length=40)
    colors: List[str] = Field(default_factory=list, max_length=12)
    fonts: List[str] = Field(default_factory=list, max_length=12)
    preview_paths: List[str] = Field(default_factory=list, max_length=6)
    role_coverage: Optional[float] = Field(default=None, ge=0, le=1)
    agentic_fit: Optional[Literal["strong", "usable", "weak"]] = None
    agentic_reason: Optional[str] = Field(default=None, max_length=1_000)
    agentic_use_for_roles: List[str] = Field(default_factory=list, max_length=20)
    agentic_risks: List[str] = Field(default_factory=list, max_length=20)
    structural_evidence: Dict[str, Any] = Field(default_factory=dict)
    materialize_ref: Dict[str, Any] = Field(default_factory=dict)

    def agent_context(self) -> Dict[str, Any]:
        """Project a selected template without renderer-only preview assets."""
        structural_keys = (
            "overview",
            "visual_style",
            "best_for",
            "signature_elements",
            "overview_source",
            "density_level",
            "role_counts",
            "layout_summary",
            "brand_scope",
            "license_scope",
        )
        return {
            "template_id": self.template_id,
            "version": self.version,
            "title": self.title,
            "aspect_ratio": self.aspect_ratio,
            "slide_count": self.slide_count,
            "strengths": self.strengths,
            "colors": self.colors,
            "fonts": self.fonts,
            "agentic_reason": self.agentic_reason,
            "agentic_use_for_roles": self.agentic_use_for_roles,
            "agentic_risks": self.agentic_risks,
            "structural_evidence": {
                key: self.structural_evidence.get(key)
                for key in structural_keys
                if key in self.structural_evidence
            },
            "materialize_ref": self.materialize_ref,
        }


class PresentationStageState(BaseModel):
    """The current cognitive stage inside the Session's presentation pipeline."""

    mode: Literal["presentation"] = "presentation"
    stage: Literal["ppt_brief", "ppt_plan", "ppt_compose", "ppt_review"] = "ppt_brief"
    step_index: int = Field(default=0, ge=0)
    goal: Optional[str] = Field(default=None, min_length=1)
    reports: List[PresentationStepRecord] = Field(default_factory=list)
    sources: List[PresentationSource] = Field(default_factory=list, max_length=80)
    outline: List[PresentationChapterOutline] = Field(default_factory=list, max_length=20)
    outline_confirmed: bool = False
    outline_confirmation_id: Optional[str] = Field(default=None, min_length=1)
    template_candidates: List[PresentationTemplateCandidate] = Field(default_factory=list, max_length=8)
    template_selection_id: Optional[str] = Field(default=None, min_length=1)
    template_selection_status: Literal["idle", "pending", "selected", "skipped"] = "idle"
    template_selection_error: Optional[str] = Field(default=None, max_length=1_000)
    selected_template: Optional[PresentationTemplateCandidate] = None
    template_excluded_ids: List[str] = Field(default_factory=list, max_length=200)

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_plan_cursor(cls, value: Any) -> Any:
        """Collapse the former chapter-only Plan step when hydrating saved sessions."""
        if not isinstance(value, dict) or value.get("stage") != "ppt_plan":
            return value
        reports = value.get("reports")
        if not isinstance(reports, list):
            return value

        def step_id(report: Any) -> Optional[str]:
            if isinstance(report, dict):
                return report.get("step_id")
            return getattr(report, "step_id", None)

        if not any(step_id(report) == "shape_chapters" for report in reports):
            return value
        migrated = dict(value)
        migrated["reports"] = [report for report in reports if step_id(report) != "shape_chapters"]
        migrated["step_index"] = max(1, int(value.get("step_index") or 0) - 1)
        return migrated

    def apply_plan_step_data(self, step_id: str, data: Any) -> "PresentationStageState":
        """Validate one Plan result and assign runtime-owned stable identities."""
        def required_text(item: Dict[str, Any], name: str, label: str) -> str:
            value = str(item.get(name) or "").strip()
            if not value:
                raise ValueError(f"{label} requires non-empty `{name}`.")
            return value

        def optional_text(item: Dict[str, Any], name: str) -> Optional[str]:
            value = str(item.get(name) or "").strip()
            return value or None

        def raw_items(name: str) -> List[Dict[str, Any]]:
            if not isinstance(data, dict) or not isinstance(data.get(name), list) or not data[name]:
                raise ValueError(f"Plan step `{step_id}` requires a non-empty `{name}` list in `data`.")
            items: List[Dict[str, Any]] = []
            for item in data[name]:
                if isinstance(item, BaseModel):
                    items.append(item.model_dump(mode="python"))
                elif isinstance(item, dict):
                    items.append(item)
                else:
                    raise ValueError(f"Plan step `{step_id}` requires every `{name}` item to be an object.")
            return items

        if step_id == "collect_evidence":
            sources: List[PresentationSource] = []
            for index, item in enumerate(raw_items("sources"), start=1):
                kind = str(item.get("kind") or "").strip()
                if kind not in {"web", "file", "conversation"}:
                    raise ValueError(f"source {index} requires kind `web`, `file`, or `conversation`.")
                locator = optional_text(item, "locator")
                if kind in {"web", "file"} and locator is None:
                    raise ValueError(f"source {index} of kind `{kind}` requires `locator`.")
                sources.append(PresentationSource(
                    id=f"source-{index:03d}",
                    kind=kind,
                    title=required_text(item, "title", f"source {index}"),
                    locator=locator,
                    excerpt=optional_text(item, "excerpt"),
                    usage=optional_text(item, "usage"),
                ))
            return self.model_copy(update={"sources": sources})

        if step_id not in {"shape_chapters", "map_slides"}:
            return self

        known_sources = {source.id for source in self.sources}
        chapters: List[PresentationChapterOutline] = []
        slide_number = 0
        for chapter_index, item in enumerate(raw_items("chapters"), start=1):
            slides: List[PresentationSlideOutline] = []
            raw_slides = item.get("slides") or []
            if step_id == "map_slides" and not isinstance(raw_slides, list):
                raise ValueError(f"chapter {chapter_index} requires a `slides` list.")
            for slide_index, raw_slide in enumerate(raw_slides, start=1):
                if not isinstance(raw_slide, dict):
                    raise ValueError(f"chapter {chapter_index} slide {slide_index} must be an object.")
                slide_number += 1
                raw_source_ids = raw_slide.get("source_ids") or []
                if not isinstance(raw_source_ids, list):
                    raise ValueError(
                        f"chapter {chapter_index} slide {slide_index} requires `source_ids` to be a list."
                    )
                source_ids = list(dict.fromkeys(
                    str(source_id).strip()
                    for source_id in raw_source_ids
                    if str(source_id).strip()
                ))
                unknown = [source_id for source_id in source_ids if source_id not in known_sources]
                if unknown:
                    raise ValueError(
                        f"chapter {chapter_index} slide {slide_index} references unknown source ids: "
                        + ", ".join(unknown)
                    )
                raw_content_outline = raw_slide.get("content_outline") or []
                if not isinstance(raw_content_outline, list):
                    raise ValueError(
                        f"chapter {chapter_index} slide {slide_index} requires `content_outline` to be a list."
                    )
                content_outline = list(dict.fromkeys(
                    str(item).strip()
                    for item in raw_content_outline
                    if str(item).strip()
                ))
                if step_id == "map_slides" and not content_outline:
                    raise ValueError(
                        f"chapter {chapter_index} slide {slide_index} requires a non-empty `content_outline`."
                    )
                slides.append(PresentationSlideOutline(
                    id=f"slide-{slide_number:03d}",
                    title=required_text(raw_slide, "title", f"chapter {chapter_index} slide {slide_index}"),
                    purpose=optional_text(raw_slide, "purpose"),
                    key_message=optional_text(raw_slide, "key_message"),
                    content_outline=content_outline,
                    source_ids=source_ids,
                ))
            chapters.append(PresentationChapterOutline(
                id=f"chapter-{chapter_index:03d}",
                title=required_text(item, "title", f"chapter {chapter_index}"),
                summary=optional_text(item, "summary"),
                slides=slides,
            ))
        if step_id == "map_slides" and not any(chapter.slides for chapter in chapters):
            raise ValueError("Plan step `map_slides` requires at least one slide.")
        return self.model_copy(update={
            "outline": chapters,
            "outline_confirmed": False,
            "template_candidates": [],
            "template_selection_id": None,
            "template_selection_status": "idle",
            "template_selection_error": None,
            "selected_template": None,
            "template_excluded_ids": [],
        })


class WorkflowStageState(BaseModel):
    """The current execution section inside one saved Workflow run."""

    mode: Literal["run_workflow"] = "run_workflow"
    stage: Literal["execute"] = "execute"
    workflow_id: str = Field(min_length=1)
    generation: str = Field(min_length=1)
    step_index: int = Field(default=0, ge=0)


InStage = Annotated[
    Union[NormalStageState, BuildStageState, PresentationStageState, WorkflowStageState],
    Field(discriminator="mode"),
]

################################################################################################################
# Interaction Status
################################################################################################################
class AwaitingFeedback(BaseModel):
    questions: List[dict] = Field(default_factory=list)
    prompt: str = ""
    request_id: Optional[str] = None


class AwaitingPermission(BaseModel):
    permission: Optional[dict] = None
    # Stable correlation for this parked approval request: generated when parking,
    # persisted along with ``state.interaction``, rehydrated by the GUI through
    # ``pending_request`` and sent back with ``permission_answer``, used to match the
    # parked turn + for idempotency (once answered, interaction is cleared, so a
    # duplicate/stale reply finds no parked request and is ignored). Older rows default
    # to empty.
    request_id: Optional[str] = None


class AwaitingTaskConfirm(BaseModel):
    task_confirm: Dict[str, Any] = Field(default_factory=dict)


class AwaitingWorkflowConfirm(BaseModel):
    workflow_confirm: Dict[str, Any] = Field(default_factory=dict)


class AwaitingBuildConfirm(BaseModel):
    """Confirmation required before a Main request enters Workflow Build."""

    build_confirm: Literal[True] = True
    request_id: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    reason: Optional[str] = None


class AwaitingBuildConflict(BaseModel):
    """Build Think's semantic choice request for competing Build intents."""

    build_conflict: Literal[True] = True
    existing_stage: str = Field(min_length=1)
    existing_workflow_id: Optional[str] = None
    requested_workflow_id: Optional[str] = None
    reason: Optional[str] = None
    questions: List[dict] = Field(min_length=1)
    request_id: str = Field(min_length=1)


class AwaitingWorkflowRunChoice(BaseModel):
    """Main's semantic choice request for one unfinished private Run."""

    workflow_run_choice: Literal[True] = True
    existing_workflow_id: str = Field(min_length=1)
    requested_workflow_id: str = Field(min_length=1)
    reason: Optional[str] = None
    questions: List[dict] = Field(min_length=1)
    request_id: str = Field(min_length=1)


class AwaitingPresentationOutlineConfirm(BaseModel):
    """The Plan outline is editable and must be confirmed before visual design."""

    presentation_outline_confirm: Literal[True] = True
    request_id: str = Field(min_length=1)


class AwaitingPresentationTemplateSelection(BaseModel):
    """The template shortlist is ready and waits for an explicit user decision."""

    presentation_template_selection: Literal[True] = True
    request_id: str = Field(min_length=1)


class CallVerdict(BaseModel):
    """One tool call's permission outcome within a round.

    ``verdict`` is a ``Permission`` value ("allow" / "deny" / "ask"). ``reason`` is set
    only when the call is blocked, and is surfaced to the model as the failed step's error.
    Carries ``tool`` / ``arguments`` directly (not the StepToolCall) — all the act phase
    needs to render a denied step.

    ``id`` is the denied step's ``tool_id`` and MUST be unique: two same-tool denials
    (e.g. two ``edit_file``) once shared the static ``deny_<tool>`` id, and the LLM API
    rejected the history with "Duplicate value for 'tool_call_id'". Defaulted via a
    factory so old persisted rows without it still load with a fresh unique id.
    """
    id: str = Field(default_factory=lambda: f"deny_{uuid4().hex}")
    tool: str
    arguments: dict = Field(default_factory=dict)
    verdict: str
    reason: Optional[str] = None
    # The policy category the classifier matched ("Data Exfiltration", …). Model- and
    # audit-facing only: it comes from user-overridable policy data with no localized form,
    # so putting it on the approval card showed Chinese users an English category name.
    rule: str = ""
    # The judgement's catalog label id ("security.label.execute_command", …). ``reason``
    # is that label rendered in the REQUEST locale at park time; the id survives so the
    # classifier's decision ledger can re-render it in English (its prompt language)
    # instead of feeding it a Chinese enum value. Older persisted rows default to "".
    label_id: str = ""
    # Criteria surfaced to the frontend approval card: capability (read/write/network/
    # execute…) and boundary (inside the workspace / a mount / out of bounds). The
    # frontend derives the risk color / category icon / high-risk stripping from these.
    # Older persisted rows default to an empty string.
    capability: str = ""
    boundary: str = ""
    # The criteria flags are surfaced too — the frontend **must** read these objective
    # flags to decide the risk level, and must not parse ``reason``: on the auto path
    # reason is free-form Chinese text generated on the spot by the classifier, and
    # substring matching ("contains the word 'sensitive' ⇒ high risk") reaches the
    # opposite conclusion from the criteria (observed in practice: "this edit does not
    # involve sensitive files" was judged high risk). Older persisted rows default to
    # False; the frontend conservatively treats an all-False unknown item as medium risk
    # and excludes it from "allow all".
    sensitive: bool = False
    deletion: bool = False
    regenerable: bool = False
    uncertain_destruction: bool = False
    touches_risk_surface: bool = False


class RoundPermission(BaseModel):
    """A round's tool-permission outcome, folded onto its OTARecord as ``permission``.

    One field carries the whole picture — every call's verdict (aligned with the round's
    tool_calls) plus, for blocked calls, the reason — superseding the separate
    ``denied_steps`` / ``permission_result`` round fields. ``reviewed`` marks a round the
    user has already decided: ``permission_check`` then returns these verdicts verbatim
    instead of re-gating, so an approved/denied round never loops back into a fresh ask.
    ``execution_mode`` snapshots the effective Think-aware mode used for this round.
    """
    execution_mode: Optional[Literal["request", "auto", "full"]] = None
    reviewed: bool = False
    verdicts: List[CallVerdict] = Field(default_factory=list)
    # Render data for the terminal-state approval card: one entry per ASKed call,
    # {call_index, tool, arguments, capability, boundary, label, decision, instruction}.
    # Non-empty only on reviewed rounds, so GET messages can derive a terminal-state card
    # from a decided approval (in the same position as the pending card, and
    # persistable); older persisted rows default to empty.
    items: List[dict] = Field(default_factory=list)


################################################################################################################
# SubAgent Status
################################################################################################################
class SubAgentCall(BaseModel):
    """One Child Session reservation plus its optional inherited execution mode."""

    tool_call_id: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    execution_mode: Optional[Literal["request", "auto", "full"]] = None

    @classmethod
    def create(
        cls,
        tool_call_id: str,
        goal: str,
        *,
        execution_mode: Optional[str] = None,
    ) -> "SubAgentCall":
        """Create one call with a stable Child Session identity."""
        return cls(
            tool_call_id=tool_call_id,
            goal=goal,
            session_id=f"session_{uuid4().hex}",
            execution_mode=execution_mode,
        )


class AwaitingSubAgent(BaseModel):
    """Child calls that park the parent Agent until every Child is terminal."""

    calls: List[SubAgentCall] = Field(min_length=1)

    @model_validator(mode="after")
    def _require_unique_identities(self) -> "AwaitingSubAgent":
        call_ids = [call.tool_call_id for call in self.calls]
        session_ids = [call.session_id for call in self.calls]
        if len(call_ids) != len(set(call_ids)):
            raise ValueError("pending Child calls contain duplicate tool call ids")
        if len(session_ids) != len(set(session_ids)):
            raise ValueError("pending Child calls contain duplicate Session ids")
        return self


class SubAgentResult(BaseModel):
    """One terminal Child result delivered during the parent join."""

    tool_call_id: str = Field(min_length=1)
    status: str = Field(min_length=1)
    answer: Optional[str] = None
    error: Optional[str] = None


class SubAgentsCompleted(BaseModel):
    """Internal input that resumes a parent after its Child batch settles."""

    results: List[SubAgentResult] = Field(min_length=1)


################################################################################################################
# AgentState
################################################################################################################
InteractionState = Union[
    AwaitingFeedback,
    AwaitingPermission,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingBuildConfirm,
    AwaitingBuildConflict,
    AwaitingPresentationOutlineConfirm,
    AwaitingPresentationTemplateSelection,
    AwaitingWorkflowRunChoice,
]

AgentResult: TypeAlias = Union[
    str,
    AwaitingFeedback,
    AwaitingPermission,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingBuildConfirm,
    AwaitingBuildConflict,
    AwaitingPresentationOutlineConfirm,
    AwaitingPresentationTemplateSelection,
    AwaitingWorkflowRunChoice,
    AwaitingSubAgent,
]


class TurnCompactionState(BaseModel):
    """One cognitive stage's compacted projection of the current Turn."""

    turn_summary: str = ""
    turn_through_round: int = Field(default=0, ge=0)


class ContextCompactionState(BaseModel):
    """Persisted prompt projection for compacted Session and current-Turn history."""

    session_summary: str = ""
    session_through_ordinal: int = Field(default=-1, ge=-1)
    turn: Dict[str, Dict[str, TurnCompactionState]] = Field(default_factory=dict)


class AgentState(BaseModel):
    think: InStage = Field(default_factory=NormalStageState)
    interaction: Optional[InteractionState] = None
    subagents: Optional[AwaitingSubAgent] = None
    context_compaction: Optional[ContextCompactionState] = None

    def to_think(self, state: InStage) -> None:
        """Set the think dimension outright."""
        self.think = state

    def to_interaction(self, state: Optional[InteractionState]) -> None:
        """Set the interaction dimension (None = no longer waiting)."""
        self.interaction = state

    def to_subagents(self, state: Optional[AwaitingSubAgent]) -> None:
        """Set the parent Agent's pending Child calls."""
        self.subagents = state
