import asyncio
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from typing import AsyncIterator, ClassVar, Dict, List, Optional, Tuple

from sqlalchemy import UniqueConstraint, delete
from sqlalchemy.exc import IntegrityError
from sqlmodel import Field, SQLModel, select

from ._base import Repository
from ._session import SessionRecord
from ._user import _utcnow


class WorkflowNameConflictError(ValueError):
    """Raised when a user already owns a Workflow with the requested name."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"Workflow name already exists: {name}")


class Workflow(SQLModel, table=True):
    __tablename__ = "workflows"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="ux_workflows_user_name"),
        UniqueConstraint("user_id", "source_turn_id", name="ux_workflows_source_turn"),
    )

    id: str = Field(primary_key=True, description="Workflow id, e.g. 'wf_ab12...'.")
    user_id: str = Field(foreign_key="users.id", index=True)
    name: str
    description: Optional[str] = Field(default=None)
    domain: Optional[str] = Field(default=None)
    workflow_dir: str = Field(description="Materialized Workflow package root.")
    source_session_id: Optional[str] = Field(default=None, index=True)
    source_turn_id: Optional[str] = Field(
        default=None,
        description="Session Turn whose workflow confirmation created this row.",
    )
    created_at: datetime = Field(default_factory=_utcnow)


class SessionWorkflow(SQLModel, table=True):
    """Durable association between a Session and a referenced Workflow."""

    __tablename__ = "session_workflows"

    session_id: str = Field(foreign_key="sessions.id", primary_key=True)
    workflow_id: str = Field(foreign_key="workflows.id", primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    created_at: datetime = Field(default_factory=_utcnow)


class WorkflowRepository(Repository[Workflow]):
    """Persisted Workflows scoped by owner."""

    _source_locks: ClassVar[Dict[Tuple[int, str, str], asyncio.Lock]] = {}

    @classmethod
    @asynccontextmanager
    async def source_guard(cls, user_id: str, workflow_id: str) -> AsyncIterator[None]:
        """Serialize saved-source mutation and Run snapshots in one daemon loop."""
        loop_key = id(asyncio.get_running_loop())
        lock = cls._source_locks.setdefault((loop_key, user_id, workflow_id), asyncio.Lock())
        async with lock:
            yield

    @staticmethod
    def new_id() -> str:
        """Create a new Workflow identifier before filesystem materialization."""
        return f"wf_{secrets.token_hex(8)}"

    async def create(
        self,
        user_id: str,
        *,
        workflow_id: Optional[str] = None,
        name: str,
        description: Optional[str],
        domain: Optional[str],
        workflow_dir: str,
        source_session_id: Optional[str] = None,
        source_turn_id: Optional[str] = None,
    ) -> Workflow:
        """Create and return one Workflow."""
        workflow_id = workflow_id or self.new_id()
        try:
            async with self._session() as s:
                workflow = Workflow(
                    id=workflow_id,
                    user_id=user_id,
                    name=name,
                    description=description,
                    domain=domain,
                    workflow_dir=workflow_dir,
                    source_session_id=source_session_id,
                    source_turn_id=source_turn_id,
                )
                s.add(workflow)
                if source_session_id:
                    s.add(SessionWorkflow(
                        session_id=source_session_id,
                        workflow_id=workflow_id,
                        user_id=user_id,
                    ))
                await s.commit()
                await s.refresh(workflow)
                return workflow
        except IntegrityError as exc:
            if await self.get_by_name(user_id, name) is not None:
                raise WorkflowNameConflictError(name) from exc
            raise

    async def get(self, user_id: str, workflow_id: str) -> Optional[Workflow]:
        """Return one workflow, ownership-gated (``None`` → 404)."""
        async with self._session() as s:
            return await self._get_owned(s, Workflow, workflow_id, user_id)

    async def list_for_user(self, user_id: str) -> List[Workflow]:
        """Return every workflow owned by ``user_id``, newest first."""
        async with self._session() as s:
            return await self._list_owned(
                s, Workflow, user_id, order_by=Workflow.created_at.desc(),
            )

    async def list_for_session(self, user_id: str, session_id: str) -> List[Workflow]:
        """Return Workflows associated with one owned Session, newest first."""
        async with self._session() as session:
            owner = await self._get_owned(session, SessionRecord, session_id, user_id)
            if owner is None:
                return []
            return await self._scalars(
                session,
                select(Workflow)
                .join(SessionWorkflow, SessionWorkflow.workflow_id == Workflow.id)
                .where(
                    SessionWorkflow.session_id == session_id,
                    SessionWorkflow.user_id == user_id,
                    Workflow.user_id == user_id,
                )
                .order_by(SessionWorkflow.created_at.desc()),
            )

    async def associate(self, user_id: str, session_id: str, workflow_id: str) -> bool:
        """Associate an owned Workflow with an owned Session idempotently."""
        async with self._session() as session:
            owner = await self._get_owned(session, SessionRecord, session_id, user_id)
            workflow = await self._get_owned(session, Workflow, workflow_id, user_id)
            if owner is None or workflow is None:
                return False
            existing = await session.get(SessionWorkflow, (session_id, workflow_id))
            if existing is None:
                session.add(SessionWorkflow(
                    session_id=session_id,
                    workflow_id=workflow_id,
                    user_id=user_id,
                ))
                await session.commit()
            return True

    async def copy_session_associations(
        self,
        user_id: str,
        source_session_id: str,
        dest_session_id: str,
    ) -> int:
        """Copy a Session's Workflow associations to another owned Session."""
        async with self._session() as session:
            source = await self._get_owned(
                session, SessionRecord, source_session_id, user_id,
            )
            dest = await self._get_owned(
                session, SessionRecord, dest_session_id, user_id,
            )
            if source is None or dest is None:
                return 0
            rows = await self._scalars(
                session,
                select(SessionWorkflow).where(
                    SessionWorkflow.session_id == source_session_id,
                    SessionWorkflow.user_id == user_id,
                ),
            )
            for row in rows:
                session.add(SessionWorkflow(
                    session_id=dest_session_id,
                    workflow_id=row.workflow_id,
                    user_id=user_id,
                    created_at=row.created_at,
                ))
            await session.commit()
            return len(rows)

    async def dissociate_session(self, user_id: str, session_id: str) -> None:
        """Delete every Workflow projection owned by one Session."""
        async with self._session() as session:
            await session.execute(delete(SessionWorkflow).where(
                SessionWorkflow.session_id == session_id,
                SessionWorkflow.user_id == user_id,
            ))
            await session.commit()

    async def get_by_source_turn(self, user_id: str, source_turn_id: str) -> Optional[Workflow]:
        """Return the workflow created by one confirmation Turn, if any."""
        async with self._session() as s:
            return await self._get_by(s, Workflow, user_id=user_id, source_turn_id=source_turn_id)

    async def get_by_name(self, user_id: str, name: str) -> Optional[Workflow]:
        """Return the Workflow using ``name`` within one user's library."""
        async with self._session() as s:
            return await self._get_by(s, Workflow, user_id=user_id, name=name)

    async def create_from_turn(
        self,
        user_id: str,
        *,
        workflow_id: str,
        workflow_dir: str,
        source_session_id: str,
        source_turn_id: str,
        name: str,
        description: Optional[str],
        domain: Optional[str],
    ) -> Tuple[Workflow, bool]:
        """Create one confirmed workflow atomically or return its existing row.

        Parameters
        ----------
        user_id : str
            Owner of the workflow.
        workflow_id : str
            Preallocated id shared with the materialized directory.
        workflow_dir : str
            Managed directory containing the complete Workflow package.
        source_session_id : str
            Session that produced the build.
        source_turn_id : str
            Confirmation Turn used as the idempotency key.
        name : str
            User-visible workflow name.
        description : Optional[str]
            User-visible workflow summary.
        domain : Optional[str]
            Optional workflow domain.

        Returns
        -------
        Tuple[Workflow, bool]
            Workflow row and whether this call created it.
        """
        try:
            workflow = await self.create(
                user_id,
                workflow_id=workflow_id,
                name=name,
                description=description,
                domain=domain,
                workflow_dir=workflow_dir,
                source_session_id=source_session_id,
                source_turn_id=source_turn_id,
            )
            return workflow, True
        except (IntegrityError, WorkflowNameConflictError):
            existing = await self.get_by_source_turn(user_id, source_turn_id)
            if existing is not None:
                return existing, False
            raise

    async def update_content(self, user_id: str, workflow_id: str, *, workflow_dir: str, description: Optional[str], session_id: str) -> Optional[Workflow]:
        """Update one Workflow's package metadata while preserving its identity."""
        async with self._session() as session:
            workflow = await self._get_owned(session, Workflow, workflow_id, user_id)
            owner = await self._get_owned(session, SessionRecord, session_id, user_id)
            if workflow is None or owner is None:
                return None
            workflow.workflow_dir = workflow_dir
            workflow.description = description
            association = await session.get(SessionWorkflow, (session_id, workflow_id))
            if association is None:
                session.add(SessionWorkflow(
                    session_id=session_id,
                    workflow_id=workflow_id,
                    user_id=user_id,
                ))
            session.add(workflow)
            await session.commit()
            return workflow

    async def rename(self, user_id: str, workflow_id: str, name: str) -> Optional[Workflow]:
        """Rename one owned Workflow without changing its identity or source package."""
        try:
            async with self._session() as session:
                workflow = await self._get_owned(session, Workflow, workflow_id, user_id)
                if workflow is None:
                    return None
                workflow.name = name
                session.add(workflow)
                await session.commit()
                await session.refresh(workflow)
                return workflow
        except IntegrityError as exc:
            raise WorkflowNameConflictError(name) from exc

    async def delete(self, user_id: str, workflow_id: str) -> bool:
        """Delete a Workflow; ownership-gated.

        Returns ``True`` when a row existed, ``False`` otherwise (→ 404).
        """
        async with self._session() as s:
            row = await self._get_owned(s, Workflow, workflow_id, user_id)
            if row is None:
                return False
            await s.execute(delete(SessionWorkflow).where(
                SessionWorkflow.workflow_id == workflow_id,
                SessionWorkflow.user_id == user_id,
            ))
            await s.delete(row)
            await s.commit()
            return True


__all__ = ["Workflow", "WorkflowNameConflictError", "WorkflowRepository"]
