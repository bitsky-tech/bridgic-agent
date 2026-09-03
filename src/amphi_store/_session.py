import time
import uuid
from datetime import datetime
from enum import Enum
from typing import List, Optional

from sqlalchemy import update
from sqlmodel import Field, SQLModel, func, select

from ._base import Repository
from ._user import _utcnow

__all__ = [
    "SessionKind",
    "SubAgentMode",
    "SessionStatus",
    "SessionRecord",
    "SessionRepository",
    "new_session_id",
]


def new_session_id() -> str:
    return f"session_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


class SessionStatus(str, Enum):
    """User-facing state projected from the latest top-level Session Turn."""

    FINISH = "finish"
    COMPLETED = "completed"
    AWAITING = "awaiting"


class SessionKind(str, Enum):
    """How a Session was originated. ``SCHEDULED`` marks a scheduler-fired run
    (its ``schedule_id`` points at the owning schedule); child/subagent Sessions
    are identified orthogonally by ``parent_session_id`` and stay ``USER``."""

    USER = "user"
    SCHEDULED = "scheduled"


class SubAgentMode(str, Enum):
    """How a Child Session participates in its parent conversation."""

    BACKGROUND = "background"
    BLOCKING = "blocking"
    RPC = "rpc"


class SessionRecord(SQLModel, table=True):
    """Durable container for one independent Agent conversation.

    A root Session is user-created. A child Session owns an isolated Agent
    history while retaining the immediate caller and sharing its workspace.
    """

    __tablename__ = "sessions"

    # Identify
    id: str = Field(primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    parent_session_id: Optional[str] = Field(default=None, foreign_key="sessions.id", index=True)
    parent_call_id: Optional[str] = Field(default=None, index=True)
    subagent_mode: Optional[SubAgentMode] = Field(default=None, index=True)

    # Context
    workspace_root: str
    title: Optional[str] = Field(default=None)
    status: SessionStatus = Field(default=SessionStatus.FINISH, nullable=False)
    kind: SessionKind = Field(default=SessionKind.USER, nullable=False)
    schedule_id: Optional[str] = Field(
        default=None, index=True,
        description="Owning schedule when kind == 'scheduled'; else None.",
    )
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    # Informational, denormalized for list/summary reads.
    last_used_model: Optional[str] = Field(default=None)
    last_answer: Optional[str] = Field(default=None)


class SessionRepository(Repository[SessionRecord]):
    """Persistence for session metadata and denormalized UI projections."""

    async def save(self, record: SessionRecord) -> None:
        """Upsert Session metadata and query projections."""
        async with self._session() as s:
            existing = await s.get(SessionRecord, record.id)
            if existing is None:
                s.add(record)
            else:
                existing.user_id = record.user_id
                existing.parent_session_id = record.parent_session_id
                existing.parent_call_id = record.parent_call_id
                existing.subagent_mode = record.subagent_mode
                existing.workspace_root = record.workspace_root
                existing.last_used_model = record.last_used_model
                existing.last_answer = record.last_answer
                existing.title = record.title
                existing.status = record.status
                existing.updated_at = _utcnow()
            await s.commit()

    async def update_turn_projection(
        self,
        session_id: str,
        user_id: str,
        *,
        status: SessionStatus,
        model: Optional[str],
        last_answer: Optional[str],
    ) -> bool:
        """Update fields projected from the latest top-level Session Turn.

        Parameters
        ----------
        session_id : str
            Session receiving the latest-turn projection.
        user_id : str
            Owner used to gate the update.
        status : SessionStatus
            Sidebar read and interaction state.
        model : Optional[str]
            Model used by the latest invocation attempt.
        last_answer : Optional[str]
            Latest user-facing answer, if any.

        Returns
        -------
        bool
            Whether the owned session exists and was updated.
        """
        async with self._session() as session:
            row = await self._get_owned(
                session,
                SessionRecord,
                session_id,
                user_id,
            )
            if row is None:
                return False
            row.status = status
            row.last_used_model = model
            row.last_answer = last_answer
            row.updated_at = _utcnow()
            await session.commit()
            return True

    async def reset(self, session_id: str, user_id: str) -> bool:
        """Clear Session projections and restore its idle state."""
        async with self._session() as session:
            row = await self._get_owned(
                session,
                SessionRecord,
                session_id,
                user_id,
            )
            if row is None:
                return False
            row.status = SessionStatus.FINISH
            row.last_used_model = None
            row.last_answer = None
            row.updated_at = _utcnow()
            await session.commit()
            return True

    async def load(self, session_id: str, user_id: str) -> Optional[SessionRecord]:
        """Fetch a session row by id, ownership-gated (``None`` → 404)."""
        async with self._session() as s:
            return await self._get_owned(s, SessionRecord, session_id, user_id)

    async def load_by_id(self, session_id: str) -> Optional[SessionRecord]:
        """Fetch a Session for an already-authorized runtime call."""
        async with self._session() as session:
            return await session.get(SessionRecord, session_id)

    async def count_awaiting_scheduled(self, schedule_id: str) -> int:
        """Count scheduled runs for ``schedule_id`` parked in ``AWAITING`` (waiting
        for a human). Drives both D8 overlap detection (``> 0`` ⇒ occupied; B1: a
        suspended run is non-terminal even though its asyncio task finished) and
        the GUI ``needs_action`` badge."""
        async with self._session() as s:
            stmt = select(SessionRecord.id).where(
                SessionRecord.schedule_id == schedule_id,
                SessionRecord.status == SessionStatus.AWAITING,
            )
            return len((await s.execute(stmt)).all())

    async def count_awaiting_scheduled_bulk(
        self, schedule_ids: List[str],
    ) -> dict[str, int]:
        """AWAITING run counts for many schedules in ONE query.

        The schedule list endpoint previously called
        :meth:`count_awaiting_scheduled` per row — 1+N queries per listing.
        Missing ids simply have no row here; callers default to 0.
        """
        if not schedule_ids:
            return {}
        async with self._session() as s:
            stmt = (
                select(SessionRecord.schedule_id, func.count())
                .where(
                    SessionRecord.schedule_id.in_(schedule_ids),
                    SessionRecord.status == SessionStatus.AWAITING,
                )
                .group_by(SessionRecord.schedule_id)
            )
            return {row[0]: int(row[1]) for row in (await s.execute(stmt)).all()}

    async def list_scheduled(self, schedule_id: str) -> List[SessionRecord]:
        """Return every run (Session) of one schedule, newest first — the run
        history surfaced in the schedule detail."""
        async with self._session() as s:
            return await self._scalars(
                s,
                select(SessionRecord)
                .where(SessionRecord.schedule_id == schedule_id)
                .order_by(SessionRecord.created_at.desc()),
            )

    async def create_child(
        self,
        user_id: str,
        *,
        parent_session_id: str,
        parent_call_id: Optional[str],
        subagent_mode: SubAgentMode,
        session_id: Optional[str] = None,
        workspace_root: Optional[str] = None,
        title: Optional[str] = None,
    ) -> SessionRecord:
        """Create an isolated child Session sharing its parent's workspace.

        Parameters
        ----------
        user_id : str
            Owner used to authorize the parent Session.
        parent_session_id : str
            Immediate caller Session.
        parent_call_id : Optional[str]
            Tool or workflow call that created the child.
        subagent_mode : SubAgentMode
            Child interaction and presentation mode.
        session_id : Optional[str]
            Explicit child id, primarily for deterministic integrations.
        workspace_root : Optional[str]
            Managed execution root; omitted to share the parent's workspace.
        title : Optional[str]
            Initial user-facing title, normally the delegated goal.

        Returns
        -------
        SessionRecord
            Newly persisted child Session.

        Raises
        ------
        ValueError
            If the parent Session is missing or not owned by ``user_id``.
        """
        async with self._session() as session:
            parent = await self._get_owned(
                session,
                SessionRecord,
                parent_session_id,
                user_id,
            )
            if parent is None:
                raise ValueError(f"parent Session {parent_session_id!r} is missing")
            record = SessionRecord(
                id=session_id or new_session_id(),
                user_id=user_id,
                parent_session_id=parent.id,
                parent_call_id=parent_call_id,
                subagent_mode=subagent_mode,
                workspace_root=workspace_root or parent.workspace_root,
                last_used_model=parent.last_used_model,
                title=title,
            )
            session.add(record)
            await session.commit()
            await session.refresh(record)
            return record

    async def list_for_user(self, user_id: str) -> List[SessionRecord]:
        """Root *user* Sessions owned by ``user_id``, most recently updated first.

        Scheduled runs (``kind == SCHEDULED``) are root Sessions too, but they
        belong to their schedule's run history — surfacing them here would flood
        the conversation sidebar (a per-minute schedule = dozens of rows/hour).
        They stay reachable by id via ``load_by_id`` / the message endpoints, so
        the schedule detail can still open them.
        """
        async with self._session() as s:
            return await self._scalars(
                s,
                select(SessionRecord)
                .where(
                    SessionRecord.user_id == user_id,
                    SessionRecord.parent_session_id.is_(None),
                    SessionRecord.kind == SessionKind.USER,
                )
                .order_by(SessionRecord.updated_at.desc()),
            )

    async def list_sidebar(
        self,
        user_id: str,
        *,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> List[SessionRecord]:
        """Return root user Sessions and their visible background children.

        A bare call returns the full list. With ``limit``, pagination applies to
        ROOT sessions (clamped to 200); each page carries its roots' visible
        children along — a child never lands on a different page than its
        parent, so the sidebar tree renders whole per page.
        """
        async with self._session() as session:
            rows = await self._scalars(
                session,
                select(SessionRecord)
                .where(
                    SessionRecord.user_id == user_id,
                    SessionRecord.kind == SessionKind.USER,
                )
                .order_by(SessionRecord.updated_at.desc()),
            )

        roots = [record for record in rows if record.parent_session_id is None]
        start = max(0, offset)
        if limit is not None:
            roots = roots[start:start + max(1, min(limit, 200))]
        elif start:
            roots = roots[start:]
        visible_ids = {record.id for record in roots}
        pending = [
            record for record in rows
            if record.subagent_mode is SubAgentMode.BACKGROUND
        ]
        while pending:
            discovered = [
                record for record in pending
                if record.parent_session_id in visible_ids
            ]
            if not discovered:
                break
            visible_ids.update(record.id for record in discovered)
            discovered_ids = {record.id for record in discovered}
            pending = [record for record in pending if record.id not in discovered_ids]
        return [record for record in rows if record.id in visible_ids]

    async def list_children(self, user_id: str, parent_session_id: str) -> List[SessionRecord]:
        """Return the direct Child Sessions of one owned parent."""
        async with self._session() as session:
            return await self._scalars(
                session,
                select(SessionRecord)
                .where(
                    SessionRecord.user_id == user_id,
                    SessionRecord.parent_session_id == parent_session_id,
                )
                .order_by(SessionRecord.created_at.asc()),
            )

    async def list_tree(
        self,
        user_id: str,
        root_session_id: str,
    ) -> List[SessionRecord]:
        """Return an owned Session tree in parent-before-child order."""
        async with self._session() as session:
            root = await self._get_owned(
                session,
                SessionRecord,
                root_session_id,
                user_id,
            )
            if root is None:
                return []
            records = await self._scalars(
                session,
                select(SessionRecord)
                .where(SessionRecord.user_id == user_id)
                .order_by(SessionRecord.created_at.asc()),
            )

        children: dict[str, List[SessionRecord]] = {}
        for record in records:
            if record.parent_session_id is not None:
                children.setdefault(record.parent_session_id, []).append(record)
        ordered: List[SessionRecord] = []
        pending = [root]
        while pending:
            record = pending.pop(0)
            ordered.append(record)
            pending[0:0] = children.get(record.id, [])
        return ordered

    async def root(self, session_id: str, user_id: str) -> Optional[SessionRecord]:
        """Resolve an owned Session to the root of its caller chain."""
        async with self._session() as session:
            record = await self._get_owned(
                session,
                SessionRecord,
                session_id,
                user_id,
            )
            seen: set[str] = set()
            while record is not None and record.parent_session_id is not None:
                if record.id in seen:
                    return None
                seen.add(record.id)
                record = await self._get_owned(
                    session,
                    SessionRecord,
                    record.parent_session_id,
                    user_id,
                )
            return record

    async def delete(self, session_id: str, user_id: str) -> bool:
        """Delete a session by id; ownership-gated. ``True`` iff a row was deleted."""
        from ._workflow import WorkflowRepository
        from ._workflow_run import WorkflowRunRepository

        await WorkflowRepository().dissociate_session(user_id, session_id)
        await WorkflowRunRepository().dissociate_session(user_id, session_id)
        async with self._session() as s:
            deleted = await self._delete_owned(s, SessionRecord, session_id, user_id)
            if deleted:
                await s.commit()
            return deleted

    async def rename(self, session_id: str, user_id: str, title: str) -> bool:
        """Set a session's display ``title``; ownership-gated, column-only.

        Deliberately NOT a full :meth:`save` — re-serialising the history of an
        in-flight turn would be wasteful and racy.
        """
        async with self._session() as s:
            row = await self._get_owned(s, SessionRecord, session_id, user_id)
            if row is None:
                return False
            row.title = title
            row.updated_at = _utcnow()
            await s.commit()
            return True

    async def rename_if_title(self, session_id: str, user_id: str, expected_title: Optional[str], title: str) -> bool:
        """Set ``title`` only while the owned Session still has ``expected_title``.

        The conditional update is atomic so a generated title cannot overwrite a
        user rename that commits while the model request is in flight.
        """
        title_matches = (
            SessionRecord.title.is_(None)
            if expected_title is None
            else SessionRecord.title == expected_title
        )
        async with self._session() as session:
            result = await session.execute(
                update(SessionRecord)
                .where(
                    SessionRecord.id == session_id,
                    SessionRecord.user_id == user_id,
                    title_matches,
                )
                .values(title=title, updated_at=_utcnow())
            )
            await session.commit()
            return bool(result.rowcount)

    async def mark_read(self, session_id: str, user_id: str) -> bool:
        """Clear a session's unread mark: flip ``completed`` → ``finish``;
        ownership-gated, column-only.

        The read receipt for the GUI's per-session unread dot. Idempotent — a
        session that isn't ``completed`` is left untouched. Returns False only
        when the session doesn't exist / isn't owned.
        """
        async with self._session() as s:
            row = await self._get_owned(s, SessionRecord, session_id, user_id)
            if row is None:
                return False
            if row.status is SessionStatus.COMPLETED:
                row.status = SessionStatus.FINISH
                row.updated_at = _utcnow()
                await s.commit()
            return True

    async def mark_interaction_handled(self, session_id: str, user_id: str) -> bool:
        """Move an answered Session from ``awaiting`` back to ``finish``."""
        async with self._session() as s:
            row = await self._get_owned(s, SessionRecord, session_id, user_id)
            if row is None:
                return False
            if row.status is SessionStatus.AWAITING:
                row.status = SessionStatus.FINISH
                row.updated_at = _utcnow()
                await s.commit()
            return True
