"""Global durable database storage for the Bridgic Agent application.

Each module co-locates one SQLModel record family with its Repository. The
package is independent of both the Service transport and Agent cognition.
Process-local caches remain under :mod:`src.amphi_service.cache`.
"""

from __future__ import annotations

from ._base import Repository
from ._memory import Memory, MemoryRepository
from ._provider import ProviderCredential, ProviderRepository
from ._schedule import ScheduleRecord, ScheduleRepository
from ._session import (
    SessionKind,
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SubAgentMode,
    new_session_id,
)
from ._session_mount import SessionMountRecord, SessionMountRepository
from ._session_turn import (
    SessionTurnRecord,
    SessionTurnRepository,
    SessionTurnSummary,
    TurnStatus,
    UserInput,
)
from ._skill import Skill, SkillRepository
from ._user import User, UserRepository
from ._workflow import Workflow, WorkflowNameConflictError, WorkflowRepository
from ._workflow_run import (
    SessionWorkflowRun,
    WorkflowRun,
    WorkflowRunRepository,
    WorkflowRunStatus,
)

__all__ = [
    "Repository",
    "User",
    "UserRepository",
    "TurnStatus",
    "SessionKind",
    "SubAgentMode",
    "SessionStatus",
    "SessionRecord",
    "SessionRepository",
    "ScheduleRecord",
    "ScheduleRepository",
    "SessionTurnRecord",
    "SessionTurnRepository",
    "SessionTurnSummary",
    "new_session_id",
    "UserInput",
    "SessionMountRecord",
    "SessionMountRepository",
    "Memory",
    "MemoryRepository",
    "ProviderCredential",
    "ProviderRepository",
    "Skill",
    "SkillRepository",
    "Workflow",
    "WorkflowNameConflictError",
    "WorkflowRepository",
    "WorkflowRun",
    "SessionWorkflowRun",
    "WorkflowRunRepository",
    "WorkflowRunStatus",
]
