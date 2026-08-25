"""Protocols this service speaks — both directions.

Two flavours of "protocol" live under here:

* **Downward** (L1 clients ↔ this service) — the HTTP + WebSocket
  wire format: Pydantic request/response models (:mod:`._schemas`),
  turn/system event dataclasses (:mod:`._events`), and the inbound
  WebSocket envelope schemas (:mod:`._ws_messages`). Chat used to
  flow over SSE in Phase 1; Phase 4 retired that path in favour of
  the multiplexed ``/ws`` channel — the ``_events`` dataclasses are
  still here because their wire ``name``s double as WS frame
  ``type``s.

* **Upward** (this service ↔ upstream LLM providers) — under
  :mod:`.llms`. Different providers need different init flows
  (api-key, OAuth, ...); the sub-package converges them all on a
  uniform ``bridgic.llms`` object.

Anything that lives **only** inside the server process (DB rows,
in-memory caches, agent aggregates) belongs in :mod:`..store` or
:mod:`...amphi_agent` instead.
"""

from __future__ import annotations

from ._events import (
    AcceptRuleRequestEvent,
    BuildConfirmRequestEvent,
    CancelledEvent,
    ErrorEvent,
    FinalEvent,
    HumanRequestEvent,
    ModelRetryEvent,
    SubAgentEvent,
    PermissionRequestEvent,
    LoopAbortEvent,
    ReasoningEvent,
    StageEvent,
    ScheduleNotifyEvent,
    SessionCompletedEvent,
    SystemEvent,
    SystemShutdownEvent,
    TaskConfirmRequestEvent,
    TitleEvent,
    TokenEvent,
    ToolEvent,
    ToolResultEvent,
    TurnEvent,
    UsageEvent,
    WorkflowConfirmRequestEvent,
    WorkflowProgressEvent,
    WorkflowResultEvent,
)
from ._schemas import (
    AddProviderRequest,
    CreateMemoryRequest,
    CreateScheduleRequest,
    CreateSessionRequest,
    PatchScheduleRequest,
    RenameSessionRequest,
    RenameWorkflowRequest,
    CreateMountRequest,
    CredentialsRequest,
    FetchModelsRequest,
    ModelLimits,
    SetActiveModelRequest,
    SetExecutionModeRequest,
    SetModelRequest,
    TestProviderRequest,
    ToggleProviderRequest,
    ToggleSkillRequest,
    WorkflowFile,
    WorkflowProgram,
)
from ._ws_messages import (
    WsAcceptRuleMessage,
    WsBuildConfirmMessage,
    WsChatMessage,
    WsChoiceAnswerItem,
    WsChoiceAnswerMessage,
    WsClientMessage,
    WsHelloMessage,
    WsMessageError,
    WsPermissionAnswer,
    WsSetLocaleMessage,
    WsSubscribeMessage,
    WsTaskConfirmMessage,
    WsUnsubscribeMessage,
    WsWorkflowConfirmMessage,
    parse_client_message,
)

__all__ = [
    # Per-turn events (one session's stream)
    "TurnEvent",
    "TokenEvent",
    "ReasoningEvent",
    "ModelRetryEvent",
    "ToolEvent",
    "ToolResultEvent",
    "LoopAbortEvent",
    "UsageEvent",
    "StageEvent",
    "WorkflowProgressEvent",
    "WorkflowResultEvent",
    "TitleEvent",
    "HumanRequestEvent",
    "PermissionRequestEvent",
    "TaskConfirmRequestEvent",
    "AcceptRuleRequestEvent",
    "BuildConfirmRequestEvent",
    "WorkflowConfirmRequestEvent",
    "FinalEvent",
    "CancelledEvent",
    "ErrorEvent",
    # System (process-wide) events
    "SubAgentEvent",
    "ScheduleNotifyEvent",
    "SessionCompletedEvent",
    "SystemEvent",
    "SystemShutdownEvent",
    # Request models (input validation)
    "CreateSessionRequest",
    "RenameSessionRequest",
    "RenameWorkflowRequest",
    "CreateMountRequest",
    "SetExecutionModeRequest",
    "SetModelRequest",
    "CredentialsRequest",
    "CreateMemoryRequest",
    # Schedules
    "CreateScheduleRequest",
    "PatchScheduleRequest",
    # Providers (multi-provider)
    "AddProviderRequest",
    "ModelLimits",
    "SetActiveModelRequest",
    "ToggleProviderRequest",
    "TestProviderRequest",
    "FetchModelsRequest",
    # skills
    "ToggleSkillRequest",
    # Workflows
    "WorkflowFile",
    "WorkflowProgram",
    # WS envelope (client → server)
    "WsHelloMessage",
    "WsSetLocaleMessage",
    "WsSubscribeMessage",
    "WsUnsubscribeMessage",
    "WsChatMessage",
    "WsAcceptRuleMessage",
    "WsBuildConfirmMessage",
    "WsTaskConfirmMessage",
    "WsWorkflowConfirmMessage",
    "WsPermissionAnswer",
    "WsChoiceAnswerItem",
    "WsChoiceAnswerMessage",
    "WsClientMessage",
    "WsMessageError",
    "parse_client_message",
]
