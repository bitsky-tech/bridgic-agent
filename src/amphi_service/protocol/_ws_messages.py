from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class WsHelloMessage(BaseModel):
    """Auth + identity handshake. Mandatory FIRST inbound message."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["hello"] = "hello"
    token: str = Field(description="Bearer token from ``runtime.json``.")
    client_id: Optional[str] = Field(
        default=None,
        description="Stable identifier for this client (browser tab or CLI invocation).",
    )
    client_type: str = Field(
        default="unknown",
        description="Free-form client label; current clients use gui / cli / tray / unknown.",
    )
    locale: Optional[str] = Field(
        default=None,
        description=(
            "The client's display language (an ``Accept-Language``-shaped value; "
            "unsupported ones fall back to the product default). Carried in the frame "
            "rather than a header because the browser WebSocket API cannot set request "
            "headers, so a GUI's handshake header reflects the OS language, not the "
            "language the user picked in the app. Absent = fall back to the header."
        ),
    )


class WsSetLocaleMessage(BaseModel):
    """Retarget this connection's display language after the user switches UI language.

    A dedicated frame rather than a reconnect: the socket carries a live token stream, and
    dropping it mid-turn to re-handshake would abort the reply the user is reading.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["set_locale"] = "set_locale"
    locale: str


class WsSubscribeMessage(BaseModel):
    """Add the listed topics to this connection's subscription set."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["subscribe"] = "subscribe"
    topics: List[str] = Field(
        description='Topic names; e.g. ``"session:abc"`` or ``"system"``.',
        min_length=1,
    )


class WsUnsubscribeMessage(BaseModel):
    """Remove the listed topics from this connection's subscription set."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["unsubscribe"] = "unsubscribe"
    topics: List[str] = Field(min_length=1)


class WsTextBlock(BaseModel):
    """A run of plain text in the composer input."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["text"] = "text"
    value: str


class WsMentionBlock(BaseModel):
    """An @-referenced entity. For mounts, ``id`` is the per-session mount id
    resolved to a real local path. ``group`` also identifies non-file entities
    such as Schedules so their stable ids survive prompt rendering.

    ``path`` (optional) is a POSIX-style path *relative to the mount root*,
    pointing at a file/folder INSIDE a mounted folder; empty = the mount root
    itself (the pre-``path`` wire shape, unchanged).

    Why mount-id + relative path instead of letting the client send an
    absolute path directly:

    - Mentions semantically reference *the session's mounted set*. Resolution
      goes through the mount table (ownership-gated per session + user, see
      ``Workspace.reference_map``); an absolute path would let any client with a
      token splice arbitrary host paths into the prompt, making the mount
      table meaningless for mentions and breaking this API family's
      fail-closed design (cf. the mounts handler's path validation).
    - Lifecycle: removing a mount today degrades its stale mentions to a clean
      ``@label`` (unknown id → no inline path). id + relative inherits that;
      an absolute path would keep resolving forever after the mount is gone.
    - Cost: the client must carry ``id`` anyway (history badge rendering), so
      relative-vs-absolute is the same one field — going relative just keeps
      validation on the daemon side.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["mention"] = "mention"
    id: str
    label: str
    group: str = ""
    path: str = ""


class WsSlashBlock(BaseModel):
    """A fixed command or executable resource selected from the ``/`` menu."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["slash"] = "slash"
    id: str
    label: str
    resource: Optional[Literal["workflow", "schedule"]] = None


# Discriminated by ``type`` so a raw dict validates into the right block class.
WsChatBlock = Annotated[
    Union[WsTextBlock, WsMentionBlock, WsSlashBlock],
    Field(discriminator="type"),
]


class WsChatMessage(BaseModel):
    """Kick off one chat turn on ``session_id``.

    The server-side handler launches a daemon-owned agent task (via
    :meth:`AgentInvocation.arun`); events flow back over this WS iff this
    connection is subscribed to ``session:<session_id>``.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["chat"] = "chat"
    session_id: str
    # Clean flattened display text (``@label`` / ``/id`` form) — used for the
    # history title, the stored user message, and the LLM's history rounds.
    input: str
    # Structured input truth: ordered text / @mention / /slash blocks. The
    # observation hook walks these to inline-resolve @mention paths in place
    # (preserving the user's ordering); GUI history rebuilds badges from them.
    blocks: List[WsChatBlock] = Field(default_factory=list)


class WsBuildConfirmMessage(BaseModel):
    """Resume Main after the user accepts or declines a Build proposal."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["build_confirm"] = "build_confirm"
    session_id: str
    request_id: str
    action: Literal["confirm", "cancel"]


class WsWorkflowConfirmMessage(BaseModel):
    """Choose how to save or cancel a parked Workflow Build."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["workflow_confirm"] = "workflow_confirm"
    session_id: str
    request_id: str
    action: Literal["confirm", "save_as_new", "cancel"]
    name: Optional[str] = None


class WsTaskConfirmMessage(BaseModel):
    """Resume Clarify after the user reviews the rendered task contract."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["task_confirm"] = "task_confirm"
    session_id: str
    request_id: str
    action: Literal["confirm", "revise"]
    feedback: Optional[str] = None


class WsAcceptRuleMessage(BaseModel):
    """Resume Clarify with one decision and optional replacement per proposed rule."""

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["accept_rule"] = "accept_rule"
    session_id: str
    request_id: str
    mode: Literal["criteria", "execution_only"] = "criteria"
    decisions: List[Literal["accept", "reject"]] = Field(default_factory=list, max_length=12)
    feedback: List[str] = Field(default_factory=list, max_length=12)
    supplement: str = Field(default="", max_length=2_000)

    @model_validator(mode="after")
    def validate_mode(self) -> "WsAcceptRuleMessage":
        if self.mode == "criteria" and not self.decisions:
            raise ValueError("criteria mode requires one decision per proposed rule")
        if self.feedback and len(self.feedback) != len(self.decisions):
            raise ValueError("feedback must align with the proposed rule decisions")
        if any(len(item) > 1_000 for item in self.feedback):
            raise ValueError("rule feedback must not exceed 1000 characters")
        if self.mode == "execution_only" and (self.decisions or self.feedback or self.supplement.strip()):
            raise ValueError("execution_only mode cannot include decisions, feedback, or a supplement")
        return self


class WsChoiceAnswerItem(BaseModel):
    """One question's resolved answer. ``index`` is the question's position in the
    card's ``questions`` list. Exactly one of ``option_id`` (a clicked option's
    stable backend-owned id) / ``text`` (free-typed "other" input) carries the
    answer; ids resolve to actions on the daemon, free text folds back to the
    model — display copy never travels back over the wire."""

    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0)
    option_id: Optional[str] = None
    text: Optional[str] = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def validate_answer(self) -> "WsChoiceAnswerItem":
        if not (self.option_id or (self.text or "").strip()):
            raise ValueError("a choice answer needs an option_id or non-empty text")
        return self


class WsChoiceAnswerMessage(BaseModel):
    """Resume a parked choice card (build conflict / run choice / human choice)
    with the selected option ids.

    Control traffic like ``permission_answer``: NOT user-authored chat content,
    never appears as a chat message. ``request_id`` must match the parked
    interaction; a stale answer is ignored (idempotent). Replaces the legacy
    label-echo chat reply so the daemon never string-matches display copy.
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["choice_answer"] = "choice_answer"
    session_id: str
    request_id: str
    answers: List[WsChoiceAnswerItem] = Field(min_length=1, max_length=12)


class WsPermissionAnswerItem(BaseModel):
    """One held ASK call's decision. ``call_index`` = the call's position in the
    parked round's full ``tool_calls`` (StepToolCall has no id, so the round-local
    index is the stable key the daemon aligns answers by). ``instruction`` (optional)
    is a per-call constraint stamped onto the approved call's observation."""

    model_config = ConfigDict(extra="forbid")

    call_index: int = Field(ge=0)
    decision: Literal["allow", "deny"]
    instruction: Optional[str] = None


class WsPermissionAnswer(BaseModel):
    """Resume a parked permission turn with the user's per-call decisions.

    The dedicated approval channel (replaces overloading ``chat``): the GUI sends this
    after the user acts on the permission card, so the decision is control traffic — NOT
    user-authored chat content, and never appears as a chat message. ``request_id`` must
    match the currently-parked ``AwaitingPermission``; a stale/duplicate answer (no
    matching parked request) is ignored (idempotent).
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    type: Literal["permission_answer"] = "permission_answer"
    session_id: str
    request_id: str
    answers: List[WsPermissionAnswerItem] = Field(default_factory=list)


# Discriminated union over the ``type`` field. ``parse_client_message``
# below is the single entry-point that converts a raw dict into one
# of these typed instances.
WsClientMessage = Union[
    WsHelloMessage,
    WsSetLocaleMessage,
    WsSubscribeMessage,
    WsUnsubscribeMessage,
    WsChatMessage,
    WsBuildConfirmMessage,
    WsAcceptRuleMessage,
    WsTaskConfirmMessage,
    WsWorkflowConfirmMessage,
    WsPermissionAnswer,
    WsChoiceAnswerMessage,
]


_BY_TYPE: Dict[str, type] = {
    "hello": WsHelloMessage,
    "set_locale": WsSetLocaleMessage,
    "subscribe": WsSubscribeMessage,
    "unsubscribe": WsUnsubscribeMessage,
    "chat": WsChatMessage,
    "build_confirm": WsBuildConfirmMessage,
    "accept_rule": WsAcceptRuleMessage,
    "task_confirm": WsTaskConfirmMessage,
    "workflow_confirm": WsWorkflowConfirmMessage,
    "permission_answer": WsPermissionAnswer,
    "choice_answer": WsChoiceAnswerMessage,
}


class WsMessageError(Exception):
    """Raised when a raw inbound dict fails schema validation.

    The handler catches this and sends a ``cmd_error`` frame back to
    the client instead of closing the connection — protocol violations
    on a single message shouldn't kill the whole session.
    """

    def __init__(self, message: str, *, for_type: Optional[str] = None) -> None:
        super().__init__(message)
        self.for_type = for_type


def parse_client_message(raw: Dict[str, Any]) -> WsClientMessage:
    """Validate a raw dict into a typed client message.

    Raises :class:`WsMessageError` on any schema violation. Tag-only
    failures (missing / unknown ``type``) surface a structured error
    so the handler can echo a useful ``cmd_error`` payload back.
    """
    # Check the message type.
    if not isinstance(raw, dict):
        raise WsMessageError("Message must be a JSON object.")
    type_field = raw.get("type")
    if not isinstance(type_field, str):
        raise WsMessageError("Missing or non-string ``type`` field.")
    cls = _BY_TYPE.get(type_field)
    if cls is None:
        raise WsMessageError(
            f"Unknown message type {type_field!r}; "
            f"expected one of {sorted(_BY_TYPE)}.",
            for_type=type_field,
        )
    
    # Validate the rest of the message against the appropriate schema.
    try:
        return cls.model_validate(raw)
    except ValidationError as exc:
        raise WsMessageError(
            f"Invalid {type_field!r} message: {exc.errors()[0]['msg']}",
            for_type=type_field,
        ) from exc


__all__ = [
    "WsHelloMessage",
    "WsSetLocaleMessage",
    "WsSubscribeMessage",
    "WsUnsubscribeMessage",
    "WsTextBlock",
    "WsMentionBlock",
    "WsSlashBlock",
    "WsChatBlock",
    "WsChatMessage",
    "WsBuildConfirmMessage",
    "WsAcceptRuleMessage",
    "WsWorkflowConfirmMessage",
    "WsPermissionAnswerItem",
    "WsPermissionAnswer",
    "WsChoiceAnswerItem",
    "WsChoiceAnswerMessage",
    "WsClientMessage",
    "WsMessageError",
    "parse_client_message",
]
