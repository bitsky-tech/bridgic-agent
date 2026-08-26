"""Bridgic Agent execution layer (L3).

The core agent stack is built on the bridgic-amphibious two-loop framework:

* **contexts** (:mod:`._context`) — ``AmphiOTAContext`` (small loop, one
  observe-think-act run) + ``AmphiContext`` (big loop, cross-turn knowledge);
* **cognitive workers** (:mod:`._cognitive`) — the autonomous ``MainThink``
  cycle plus the build pipeline's per-stage workers;
* **agent** (:mod:`._agent`) — ``AmphiAgent`` orchestrates the workers over the
  contexts via ``on_agent``;
* **invocation** (:mod:`._invocation`) — Session-scoped Agent initialization,
  execution, persistence, and normalized outcomes;
* **data structures** (:mod:`._session`, :mod:`._memory`, :mod:`._schedules`,
  :mod:`._skills`, :mod:`._workflows`) — the fields ``AmphiContext`` holds, each owning its
  Agent-facing behavior.

The L2 service layer schedules this package through :class:`AgentInvocation`;
it does not construct or run :class:`AmphiAgent` directly. Provider clients are
still built and cached by the service, then injected into the invocation entry.
"""

from __future__ import annotations

from ._agent import DEFAULT_MAX_ROUNDS, AmphiAgent
from ._browser import BrowserHost
from ._cognitive import MainThink
from ._prompt import AGENT_NAME
from ._context import (
    AmphiContext,
    AmphiOTAContext,
    ContextUsageBreakdown,
    ContextUsageSnapshot,
)
from ._invocation import (
    AgentInvocation,
    AppEnvironmentStatus,
    InvocationBusyError,
    InvocationDisposition,
    InvocationNotFoundError,
    InvocationOutcome,
    InvocationRunResult,
    InvocationStaleAnswerError,
    InvocationStateError,
    InvocationTraceLimitError,
)
from ._session import Session
from ._memory import DEFAULT_RECALL_LIMIT, Memory, MemoryItem
from ._llm_provider import LlmProvider
from ._schedules import Schedule, ScheduleLibrary
from ._skills import Skill, SkillGroup, SkillSource, SkillLibrary
from ._workflow_run import WorkflowRun, WorkflowRunLibrary
from ._workflows import WorkflowLibrary, WorkflowPackage

__all__ = [
    # contexts
    "AmphiOTAContext",
    "AmphiContext",
    "ContextUsageBreakdown",
    "ContextUsageSnapshot",
    # cognitive / agent
    "MainThink",
    "AGENT_NAME",
    "AmphiAgent",
    "BrowserHost",
    "AgentInvocation",
    "AppEnvironmentStatus",
    "InvocationBusyError",
    "InvocationDisposition",
    "InvocationNotFoundError",
    "InvocationOutcome",
    "InvocationRunResult",
    "InvocationStaleAnswerError",
    "InvocationStateError",
    "InvocationTraceLimitError",
    "DEFAULT_MAX_ROUNDS",
    # conversation session
    "Session",
    # long-term memory
    "MemoryItem",
    "Memory",
    "DEFAULT_RECALL_LIMIT",
    # model provider
    "LlmProvider",
    # schedules
    "Schedule",
    "ScheduleLibrary",
    # skills
    "Skill",
    "SkillGroup",
    "SkillSource",
    "SkillLibrary",
    # workflows
    "WorkflowPackage",
    "WorkflowLibrary",
    "WorkflowRun",
    "WorkflowRunLibrary",
]
