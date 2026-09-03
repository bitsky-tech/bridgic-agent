from dataclasses import dataclass
from typing import Any, ClassVar, Dict, List, Literal, Mapping, Optional

# Base
@dataclass(frozen=True)
class TurnEvent:
    """Abstract base for an event in one turn's stream.

    Subclasses set ``name`` as a ``ClassVar`` and override
    :meth:`payload` to define the JSON body sent over the wire.
    """

    name: ClassVar[str] = ""

    def payload(self) -> Dict[str, Any]:
        """Return the wire JSON body as a plain dict.

        Returns
        -------
        Dict[str, Any]
            A JSON-serialisable mapping. Default implementation returns
            an empty dict; subclasses override to include their fields.
        """
        return {}


# Concrete events
@dataclass(frozen=True)
class TokenEvent(TurnEvent):
    """One streaming text chunk from the LLM."""

    name: ClassVar[str] = "token"

    text: str

    def payload(self) -> Dict[str, Any]:
        return {"text": self.text}


@dataclass(frozen=True)
class ReasoningEvent(TurnEvent):
    """One streaming reasoning/thinking chunk from the LLM.

    Separate from :class:`TokenEvent` so clients can render the model's
    chain-of-thought distinctly from the answer text. Only emitted when
    the provider exposes ``reasoning_content`` / ``reasoning`` deltas.
    """

    name: ClassVar[str] = "reasoning"

    text: str

    def payload(self) -> Dict[str, Any]:
        return {"text": self.text}


@dataclass(frozen=True)
class ModelRetryEvent(TurnEvent):
    """Transient model reconnect status for the active Turn."""

    name: ClassVar[str] = "model_retry"

    active: bool
    attempt: int = 0
    max_retries: int = 0
    delay_seconds: float = 0.0
    discard_text_chars: int = 0
    discard_reasoning_chars: int = 0

    def payload(self) -> Dict[str, Any]:
        return {
            "active": self.active,
            "attempt": self.attempt,
            "max_retries": self.max_retries,
            "delay_seconds": self.delay_seconds,
            "discard_text_chars": self.discard_text_chars,
            "discard_reasoning_chars": self.discard_reasoning_chars,
        }


@dataclass(frozen=True)
class ToolEvent(TurnEvent):
    """A tool call is about to be dispatched.

    Mirrors the agent's ``on_tool`` callback - one event per call,
    surfaced before the framework dispatcher actually runs the tool.
    """

    name: ClassVar[str] = "tool"

    tool_name: str
    arguments: Mapping[str, Any]
    tool_id: str = ""

    def payload(self) -> Dict[str, Any]:
        return {"tool_id": self.tool_id, "name": self.tool_name, "arguments": dict(self.arguments)}


@dataclass(frozen=True)
class ToolResultEvent(TurnEvent):
    """A tool call finished - success or failure.

    Mirrors the agent's ``on_tool_result`` callback.
    """

    name: ClassVar[str] = "tool_result"

    success: bool
    tool_id: str = ""
    error: Optional[str] = None
    output: str = ""
    # Wall-clock of the act phase that ran this call, in ms (the agent's
    # action_tool_call times super()). For the common single-tool round this is
    # that tool's real duration; a concurrent multi-tool round shares the round
    # total across its results. 0 when timing wasn't available.
    duration_ms: int = 0

    def payload(self) -> Dict[str, Any]:
        return {
            "tool_id": self.tool_id,
            "success": self.success,
            "error": self.error,
            "output": self.output,
            "duration_ms": self.duration_ms,
        }


@dataclass(frozen=True)
class LoopAbortEvent(TurnEvent):
    """The duplicate-call loop guard tripped.

    Mirrors the agent's ``on_loop_abort`` callback. The OTC loop will
    exit on the next dispatcher iteration via the ThinkUnit ``until=``
    predicate.
    """

    name: ClassVar[str] = "loop_abort"

    reason: str

    def payload(self) -> Dict[str, Any]:
        return {"reason": self.reason}


@dataclass(frozen=True)
class ContextUsageEvent(TurnEvent):
    """One model call's input occupancy, composition, and cache-read count."""

    name: ClassVar[str] = "context_usage"

    model_id: str
    input_tokens: int
    output_tokens: int
    cached_input_tokens: Optional[int]
    used_tokens: int
    usable_tokens: Optional[int]
    percentage: Optional[float]
    source: Literal["provider", "estimated"]
    breakdown: Dict[str, int]

    def payload(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "used_tokens": self.used_tokens,
            "usable_tokens": self.usable_tokens,
            "percentage": self.percentage,
            "source": self.source,
            "breakdown": self.breakdown,
        }


@dataclass(frozen=True)
class ContextCompactionEvent(TurnEvent):
    """Transient lifecycle status for one Turn's context compaction."""

    name: ClassVar[str] = "context_compaction"

    active: bool

    def payload(self) -> Dict[str, Any]:
        return {"active": self.active}


@dataclass(frozen=True)
class StageEvent(TurnEvent):
    """The turn's thinking position moved — the two-layer think loop's position.

    Emitted by ``on_agent`` each time it aims a think unit. ``mode`` is the loop
    (``"normal"`` plain chat | ``"build"`` the pipeline); ``stage`` is the unit
    within it (``"main"`` for normal; ``"clarify"`` | ``"explore"`` |
    ``"generate"`` | ``"verify"`` for build; ``null`` on the close frame a clean
    build exit emits on its way back to normal). A client
    drives its focus-mode rail off this: show the rail while ``mode == "build"``,
    highlight ``stage``. Stage names ARE the wire names (no ``_think`` suffix).
    """

    name: ClassVar[str] = "stage"

    mode: str
    stage: Optional[str] = None
    workflow_id: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        payload = {"mode": self.mode, "stage": self.stage}
        if self.workflow_id:
            payload["workflow_id"] = self.workflow_id
        return payload


@dataclass(frozen=True)
class WorkflowProgressEvent(TurnEvent):
    """One Workflow section's current runtime status."""

    name: ClassVar[str] = "workflow_progress"

    workflow_id: str
    generation: str
    workflow_name: str
    phase: str
    step_index: int
    step_count: int
    title: str
    status: str
    summary: Optional[str] = None
    execution_steps: Optional[List[str]] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "workflow_id": self.workflow_id,
            "generation": self.generation,
            "workflow_name": self.workflow_name,
            "phase": self.phase,
            "step_index": self.step_index,
            "step_count": self.step_count,
            "title": self.title,
            "status": self.status,
            "summary": self.summary,
            "execution_steps": self.execution_steps or [],
        }


@dataclass(frozen=True)
class WorkflowResultEvent(TurnEvent):
    """One globally published terminal Workflow result."""

    name: ClassVar[str] = "workflow_result"

    run_id: str
    workflow_id: str
    workflow_name: str
    status: str
    created_at: str
    result_file_count: int
    summary: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "workflow_id": self.workflow_id,
            "workflow_name": self.workflow_name,
            "status": self.status,
            "created_at": self.created_at,
            "result_file_count": self.result_file_count,
            "summary": self.summary,
        }


@dataclass(frozen=True)
class TitleEvent(TurnEvent):
    """A model-generated session title is ready.

    Emitted on the session's stream as soon as the opening-message title is
    ready, in parallel with the first Agent turn. The GUI updates the session's
    sidebar entry live; the title is also persisted, so a client that misses the
    frame still sees it on the next fetch.
    """

    name: ClassVar[str] = "title"

    title: str

    def payload(self) -> Dict[str, Any]:
        return {"title": self.title}


@dataclass(frozen=True)
class HumanRequestEvent(TurnEvent):
    """The agent asks the user to pick from a fixed set of options.

    Emitted when ``request_human_choice`` runs — the only HITL interaction kind;
    free-text questions are ordinary conversation (the agent just asks in its
    reply). The ask ENDS the turn (a normal :class:`FinalEvent` follows, not a
    suspend); the user's pick is simply the session's next chat message.
    For ``request_human_choice``, ``prompt`` carries the required shared Markdown
    context explaining why the interaction is necessary. Legacy or system-owned
    choice cards may omit it. ``questions`` carries the short structured decisions
    (each ``{question, header?, layout?, options:
    [{label, description?, preview?}], multiSelect?, allowOther?, allowEmpty?,
    minSelections?, maxSelections?}``).
    """

    name: ClassVar[str] = "human_request"

    kind: str = "choose"
    prompt: str = ""
    questions: Optional[List[Dict[str, Any]]] = None
    request_id: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        payload = {
            "kind": self.kind,
            "questions": self.questions or [],
            "request_id": self.request_id,
        }
        if self.prompt:
            payload["prompt"] = self.prompt
        return payload


@dataclass(frozen=True)
class PermissionRequestEvent(TurnEvent):
    """The agent asks the user to approve / deny held tool calls — the permission gate.

    Emitted when ``before_action`` holds a round because the tool-permission policy
    returned ASK on one or more calls. Reuses the request_human_choice payload
    contract — one allow/deny ``question`` per held ASK call — so the GUI's multi-tab
    banner renders it; the user's pick is the session's next chat message. The ask
    ENDS the turn (a normal :class:`FinalEvent` follows); on resume the agent runs the
    approved calls and folds the denied.
    """

    name: ClassVar[str] = "permission_request"

    kind: str = "choose"
    questions: Optional[List[Dict[str, Any]]] = None
    # The criteria for each pending (ASK) call, used by the GUI to render the approval
    # card (risk color / category icon / "why you are being asked"):
    # ``{call_index, tool, arguments, capability, boundary, label, summary}`` plus five
    # objective criteria flags (``sensitive`` / ``deletion`` / ``regenerable`` /
    # ``uncertain_destruction`` / ``touches_risk_surface``), in one-to-one correspondence
    # with ``questions``. The frontend decides the risk level by **reading only these
    # flags** — on the auto path ``label`` is free-form Chinese text generated by the
    # classifier, and substring matching on it reaches the opposite conclusion.
    # ``call_index`` = the index of that call among all of this round's tool_calls; the
    # GUI uses it to align item by item when sending back ``permission_answer``
    # (StepToolCall has no id, so the positional index is the only stable key).
    items: Optional[List[Dict[str, Any]]] = None
    # Stable correlation for this park (generated when parking, persisted); sent back by
    # the GUI with ``permission_answer``.
    request_id: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "questions": self.questions or [],
            "items": self.items or [],
            "request_id": self.request_id,
        }


@dataclass(frozen=True)
class TaskConfirmRequestEvent(TurnEvent):
    """The build clarify stage asks the user to review ``task.md``."""

    name: ClassVar[str] = "task_confirm_request"

    request_id: str
    task_markdown: str
    previous_task_markdown: Optional[str] = None
    operation: str = "create"
    workflow_id: Optional[str] = None
    original_task_markdown: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "request_id": self.request_id,
            "task_markdown": self.task_markdown,
            "previous_task_markdown": self.previous_task_markdown,
            "operation": self.operation,
            "workflow_id": self.workflow_id,
            "original_task_markdown": self.original_task_markdown,
        }


@dataclass(frozen=True)
class BuildConfirmRequestEvent(TurnEvent):
    """Main asks whether the current task should enter Workflow Build."""

    name: ClassVar[str] = "build_confirm_request"

    request_id: str
    goal: str
    reason: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "request_id": self.request_id,
            "goal": self.goal,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class WorkflowConfirmRequestEvent(TurnEvent):
    """The build verify stage asks the user to name and confirm the workflow."""

    name: ClassVar[str] = "workflow_confirm_request"

    request_id: str
    default_name: str
    summary: Optional[str] = None
    operation: str = "create"
    workflow_id: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "request_id": self.request_id,
            "default_name": self.default_name,
            "summary": self.summary,
            "operation": self.operation,
            "workflow_id": self.workflow_id,
        }


@dataclass(frozen=True)
class FinalEvent(TurnEvent):
    """The arun call returned cleanly - the turn is done.

    ``tokens_spent`` is the turn total (``input_tokens + output_tokens``);
    the split is carried alongside so a client can attribute prompt vs
    generation cost.
    """

    name: ClassVar[str] = "final"

    answer: Optional[str]
    tokens_spent: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0
    completed_at: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "answer": self.answer,
            "tokens_spent": self.tokens_spent,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "duration_ms": self.duration_ms,
            "completed_at": self.completed_at,
        }


@dataclass(frozen=True)
class CancelledEvent(TurnEvent):
    """The active turn was explicitly cancelled."""

    name: ClassVar[str] = "cancelled"


@dataclass(frozen=True)
class ErrorEvent(TurnEvent):
    """The arun call raised - the turn aborted with an exception."""

    name: ClassVar[str] = "error"

    message: str

    def payload(self) -> Dict[str, Any]:
        return {"message": self.message}

# System events — process-wide broadcast (Phase 3+)
@dataclass(frozen=True)
class SystemEvent:
    """Abstract base for process-wide broadcast events.

    Distinct from :class:`TurnEvent`: a TurnEvent belongs to one
    Session topic and is fan-out through :class:`SessionEventBroker`.
    A SystemEvent targets every connected
    client regardless of session, via the single process-wide
    :class:`SystemEventBroker` (a runtime peer).

    Wire-format names live in the ``system.*`` namespace to keep them
    unambiguous against turn events on the same WS connection.
    """

    name: ClassVar[str] = ""

    def payload(self) -> Dict[str, Any]:
        return {}


@dataclass(frozen=True)
class SubAgentEvent(SystemEvent):
    """One Child Session lifecycle event projected onto its parent Session."""

    name: ClassVar[str] = "subagent.event"

    session_id: str
    invocation_id: str
    parent_invocation_id: Optional[str]
    parent_tool_call_id: Optional[str]
    mode: str
    goal: str
    status: str
    phase: str
    answer: Optional[str] = None
    error: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "invocation_id": self.invocation_id,
            "parent_invocation_id": self.parent_invocation_id,
            "parent_tool_call_id": self.parent_tool_call_id,
            "mode": self.mode,
            "goal": self.goal,
            "status": self.status,
            "phase": self.phase,
            "answer": self.answer,
            "error": self.error,
        }


@dataclass(frozen=True)
class SystemShutdownEvent(SystemEvent):
    """The daemon is starting a graceful shutdown.

    Emitted exactly once per process lifetime, from
    :meth:`ServiceApp.pre_shutdown_hook` (wired into
    :class:`GracefulServer`), **before** uvicorn closes any
    connection. The hook then sleeps ``grace_seconds`` so relay tasks
    have time to put this frame on the wire before the connection
    tear-down phase begins.

    Clients should: stop accepting new user input; finalise any
    in-flight UX state; show "daemon shutting down" to the user.
    """

    name: ClassVar[str] = "system.shutdown"

    reason: Optional[str] = None
    grace_seconds: float = 0.0

    def payload(self) -> Dict[str, Any]:
        return {"reason": self.reason, "grace_seconds": self.grace_seconds}


@dataclass(frozen=True)
class SessionCompletedEvent(SystemEvent):
    """A session's turn finished — broadcast so a GUI watching ANOTHER session
    still learns that session ``session_id`` has an unread result (its sidebar
    dot). Delivered via the process-wide :class:`SystemEventBroker` precisely
    because the recipient may not be subscribed to this Session's event topic;
    the cross-session unread signal must reach every connected client. The read
    receipt (``POST /sessions/{id}/read``) clears the session's COMPLETED status.
    """

    name: ClassVar[str] = "session.completed"

    session_id: str = ""

    def payload(self) -> Dict[str, Any]:
        return {"session_id": self.session_id}


@dataclass(frozen=True)
class ScheduleNotifyEvent(SystemEvent):
    """A scheduled run needs the user's attention (failed / parked AWAITING).

    Published by the scheduler INSTEAD of the OS-level notifier whenever at
    least one ``gui``-tagged subscriber is on the system bus (atomic check via
    :meth:`SystemEventBroker.publish_counting`); with none attached the daemon
    falls back to ``runtime/_notify.py``. Exactly one of the two paths fires
    per run — a desktop client must never double-notify.

    ``title`` / ``body`` are pre-localized backend-side with the schedule's
    declared locale (single source with the OS path); clients render them
    verbatim. ``session_id`` is the scheduled run's session — clients should
    navigate there on notification click.
    """

    name: ClassVar[str] = "schedule.notify"

    kind: Literal["failed", "action_required"] = "failed"
    title: str = ""
    body: str = ""
    session_id: str = ""
    schedule_id: str = ""
    schedule_name: str = ""

    def payload(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "title": self.title,
            "body": self.body,
            "session_id": self.session_id,
            "schedule_id": self.schedule_id,
            "schedule_name": self.schedule_name,
        }


__all__ = [
    "TurnEvent",
    "TokenEvent",
    "ReasoningEvent",
    "ModelRetryEvent",
    "ToolEvent",
    "ToolResultEvent",
    "LoopAbortEvent",
    "ContextUsageEvent",
    "ContextCompactionEvent",
    "StageEvent",
    "WorkflowProgressEvent",
    "TitleEvent",
    "HumanRequestEvent",
    "PermissionRequestEvent",
    "BuildConfirmRequestEvent",
    "TaskConfirmRequestEvent",
    "WorkflowConfirmRequestEvent",
    "FinalEvent",
    "CancelledEvent",
    "ErrorEvent",
    # system family
    "SystemEvent",
    "SubAgentEvent",
    "SystemShutdownEvent",
    "SessionCompletedEvent",
    "ScheduleNotifyEvent",
]
