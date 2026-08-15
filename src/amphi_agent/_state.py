from typing import Annotated, Any, Dict, List, Literal, Optional, TypeAlias, Union
from uuid import uuid4

from pydantic import BaseModel, Field, model_serializer, model_validator

__all__ = [
    "InStage", "NormalStageState", "BuildStageState", "WorkflowStageState",
    "InteractionState", "AwaitingFeedback", "AwaitingPermission", "AwaitingTaskConfirm",
    "AwaitingAcceptRule", "AwaitingWorkflowConfirm", "AwaitingBuildConfirm",
    "AwaitingBuildConflict", "AwaitingWorkflowRunChoice",
    "SubAgentCall", "AwaitingSubAgent", "SubAgentResult", "SubAgentsCompleted", "AgentResult",
    "AgentState",
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


class WorkflowStageState(BaseModel):
    """The current cognitive stage and section inside one saved Workflow run."""

    mode: Literal["run_workflow"] = "run_workflow"
    stage: Literal["execute", "validate"] = "execute"
    workflow_id: str = Field(min_length=1)
    generation: str = Field(min_length=1)
    step_index: int = Field(default=0, ge=0)


InStage = Annotated[
    Union[NormalStageState, BuildStageState, WorkflowStageState],
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


class AwaitingAcceptRule(BaseModel):
    """Acceptance-rule candidates waiting for the user's structured review."""

    accept_rule: Dict[str, Any] = Field(default_factory=dict)


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
    AwaitingAcceptRule,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingBuildConfirm,
    AwaitingBuildConflict,
    AwaitingWorkflowRunChoice,
]

AgentResult: TypeAlias = Union[
    str,
    AwaitingFeedback,
    AwaitingPermission,
    AwaitingAcceptRule,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingBuildConfirm,
    AwaitingBuildConflict,
    AwaitingWorkflowRunChoice,
    AwaitingSubAgent,
]


class AgentState(BaseModel):
    think: InStage = Field(default_factory=NormalStageState)
    interaction: Optional[InteractionState] = None
    subagents: Optional[AwaitingSubAgent] = None

    def to_think(self, state: InStage) -> None:
        """Set the think dimension outright."""
        self.think = state

    def to_interaction(self, state: Optional[InteractionState]) -> None:
        """Set the interaction dimension (None = no longer waiting)."""
        self.interaction = state

    def to_subagents(self, state: Optional[AwaitingSubAgent]) -> None:
        """Set the parent Agent's pending Child calls."""
        self.subagents = state
