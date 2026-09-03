import secrets
from datetime import datetime
from enum import Enum
from typing import List, Optional, Tuple

from sqlalchemy import Column, Text, cast, delete, func, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import Field, SQLModel, select

from ._base import Repository
from ._session import SessionRecord
from ._session_turn import UserInput, UserInputType
from ._user import _utcnow


class WorkflowRunStatus(str, Enum):
    """Terminal state of one globally published Workflow result."""

    COMPLETED = "completed"
    FAILED = "failed"

    @property
    def is_terminal(self) -> bool:
        return True

    @property
    def is_published(self) -> bool:
        return True


class WorkflowRun(SQLModel, table=True):
    __tablename__ = "workflow_runs"

    id: str = Field(primary_key=True, description="Workflow run id, e.g. 'wfr_ab12...'.")
    user_id: str = Field(foreign_key="users.id", index=True)
    workflow_id: str = Field(index=True, description="Historical Workflow identity at execution time.")
    workflow_name: str = Field(description="Workflow name captured when this run started.")
    source_session_id: str = Field(
        index=True,
        description="Historical Session that produced this published result.",
    )
    workflow_input: UserInput = Field(sa_column=Column(UserInputType, nullable=False))
    status: WorkflowRunStatus = Field(default=WorkflowRunStatus.COMPLETED, index=True)
    run_dir: str = Field(description="Canonical global result directory.")
    created_at: datetime = Field(default_factory=_utcnow, index=True)
    finished_at: Optional[datetime] = Field(default=None)


class SessionWorkflowRun(SQLModel, table=True):
    """Durable association between a Session and a published Workflow Run."""

    __tablename__ = "session_workflow_runs"

    session_id: str = Field(foreign_key="sessions.id", primary_key=True)
    run_id: str = Field(foreign_key="workflow_runs.id", primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    created_at: datetime = Field(default_factory=_utcnow)


class WorkflowRunRepository(Repository[WorkflowRun]):
    """Persist terminal Workflow results and their original structured input."""

    @staticmethod
    def new_id() -> str:
        return f"wfr_{secrets.token_hex(8)}"

    async def create_or_confirm_terminal(
        self,
        user_id: str,
        *,
        result_id: str,
        workflow_id: str,
        workflow_name: str,
        source_session_id: str,
        result_dir: str,
        workflow_input: UserInput,
        status: WorkflowRunStatus,
    ) -> Tuple[WorkflowRun, bool]:
        """Create one terminal result or confirm an identical prior creation.

        Parameters
        ----------
        user_id : str
            Owner of the terminal result.
        result_id : str
            Preallocated id shared with the materialized result directory.
        workflow_id : str
            Historical identity of the executed Workflow.
        workflow_name : str
            Workflow name captured for the result.
        source_session_id : str
            Session whose Workspace produced the result.
        result_dir : str
            Canonical global Workflow result directory.
        workflow_input : UserInput
            Original structured request that started the Run.
        status : WorkflowRunStatus
            Published terminal status, either completed or failed.
        Returns
        -------
        Tuple[WorkflowRun, bool]
            Terminal row and whether this call created it.
        """
        if not status.is_published:
            raise ValueError("Workflow Run persistence accepts terminal results only")
        stored_input = UserInput.from_runtime(workflow_input)
        finished_at = _utcnow()
        try:
            async with self._session() as session:
                run = WorkflowRun(
                    id=result_id,
                    user_id=user_id,
                    workflow_id=workflow_id,
                    workflow_name=workflow_name,
                    source_session_id=source_session_id,
                    workflow_input=stored_input,
                    status=status,
                    run_dir=result_dir,
                    created_at=finished_at,
                    finished_at=finished_at,
                )
                session.add(run)
                session.add(SessionWorkflowRun(
                    session_id=source_session_id,
                    run_id=result_id,
                    user_id=user_id,
                    created_at=finished_at,
                ))
                await session.commit()
                await session.refresh(run)
                return run, True
        except IntegrityError:
            existing = await self.get(user_id, result_id)
            if existing is None:
                raise
            if self._matches_terminal(
                existing,
                workflow_id=workflow_id,
                workflow_name=workflow_name,
                source_session_id=source_session_id,
                result_dir=result_dir,
                workflow_input=stored_input,
                status=status,
            ):
                await self.associate_session(user_id, source_session_id, result_id)
                return existing, False
            raise

    @staticmethod
    def _matches_terminal(
        run: WorkflowRun,
        *,
        workflow_id: str,
        workflow_name: str,
        source_session_id: str,
        result_dir: str,
        workflow_input: UserInput,
        status: WorkflowRunStatus,
    ) -> bool:
        return (
            run.finished_at is not None
            and run.workflow_id == workflow_id
            and run.workflow_name == workflow_name
            and run.source_session_id == source_session_id
            and run.run_dir == result_dir
            and UserInput.from_runtime(run.workflow_input).model_dump(mode="json")
            == workflow_input.model_dump(mode="json")
            and run.status is status
        )

    async def get(self, user_id: str, run_id: str) -> Optional[WorkflowRun]:
        async with self._session() as session:
            return await self._get_owned(session, WorkflowRun, run_id, user_id)

    async def list_for_user(
        self, user_id: str, *, limit: int = 50, offset: int = 0,
    ) -> List[WorkflowRun]:
        async with self._session() as session:
            stmt = (
                select(WorkflowRun)
                .where(
                    WorkflowRun.user_id == user_id,
                    WorkflowRun.status.in_([
                        WorkflowRunStatus.COMPLETED,
                        WorkflowRunStatus.FAILED,
                    ]),
                )
                .order_by(WorkflowRun.created_at.desc())
                .limit(max(1, min(limit, 200)))
                .offset(max(0, offset))
            )
            return await self._scalars(session, stmt)

    async def list_for_workflow(
        self, user_id: str, workflow_id: str, *, limit: int = 50, offset: int = 0,
    ) -> List[WorkflowRun]:
        async with self._session() as session:
            stmt = (
                select(WorkflowRun)
                .where(
                    WorkflowRun.user_id == user_id,
                    WorkflowRun.workflow_id == workflow_id,
                    WorkflowRun.status.in_([
                        WorkflowRunStatus.COMPLETED,
                        WorkflowRunStatus.FAILED,
                    ]),
                )
                .order_by(WorkflowRun.created_at.desc())
                .limit(max(1, min(limit, 200)))
                .offset(max(0, offset))
            )
            return await self._scalars(session, stmt)

    async def list_for_source_session(
        self,
        user_id: str,
        source_session_id: str,
        *,
        workflow_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[WorkflowRun]:
        """List published results produced by one Session."""
        async with self._session() as session:
            stmt = select(WorkflowRun).where(
                WorkflowRun.user_id == user_id,
                WorkflowRun.source_session_id == source_session_id,
                WorkflowRun.status.in_([
                    WorkflowRunStatus.COMPLETED,
                    WorkflowRunStatus.FAILED,
                ]),
            )
            if workflow_id:
                stmt = stmt.where(WorkflowRun.workflow_id == workflow_id)
            stmt = (
                stmt.order_by(WorkflowRun.created_at.desc())
                .limit(max(1, min(limit, 200)))
                .offset(max(0, offset))
            )
            return await self._scalars(session, stmt)

    async def list_for_session(
        self,
        user_id: str,
        session_id: str,
        *,
        workflow_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[WorkflowRun]:
        """List published results associated with one owned Session."""
        async with self._session() as session:
            owner = await self._get_owned(session, SessionRecord, session_id, user_id)
            if owner is None:
                return []
            stmt = (
                select(WorkflowRun)
                .join(SessionWorkflowRun, SessionWorkflowRun.run_id == WorkflowRun.id)
                .where(
                    SessionWorkflowRun.session_id == session_id,
                    SessionWorkflowRun.user_id == user_id,
                    WorkflowRun.user_id == user_id,
                    WorkflowRun.status.in_([
                        WorkflowRunStatus.COMPLETED,
                        WorkflowRunStatus.FAILED,
                    ]),
                )
            )
            if workflow_id:
                stmt = stmt.where(WorkflowRun.workflow_id == workflow_id)
            stmt = (
                stmt.order_by(WorkflowRun.created_at.desc())
                .limit(max(1, min(limit, 200)))
                .offset(max(0, offset))
            )
            return await self._scalars(session, stmt)

    async def associate_session(self, user_id: str, session_id: str, run_id: str) -> bool:
        """Associate an owned published Run with an owned Session idempotently."""
        async with self._session() as session:
            owner = await self._get_owned(session, SessionRecord, session_id, user_id)
            run = await self._get_owned(session, WorkflowRun, run_id, user_id)
            if owner is None or run is None or not run.status.is_published:
                return False
            existing = await session.get(SessionWorkflowRun, (session_id, run_id))
            if existing is None:
                session.add(SessionWorkflowRun(
                    session_id=session_id,
                    run_id=run_id,
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
        """Copy a Session's Workflow Run associations to another owned Session."""
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
                select(SessionWorkflowRun).where(
                    SessionWorkflowRun.session_id == source_session_id,
                    SessionWorkflowRun.user_id == user_id,
                ),
            )
            copied = 0
            for row in rows:
                existing = await session.get(
                    SessionWorkflowRun,
                    (dest_session_id, row.run_id),
                )
                if existing is not None:
                    continue
                session.add(SessionWorkflowRun(
                    session_id=dest_session_id,
                    run_id=row.run_id,
                    user_id=user_id,
                    created_at=row.created_at,
                ))
                copied += 1
            if copied:
                await session.commit()
            return copied

    async def dissociate_session(self, user_id: str, session_id: str) -> None:
        """Delete every Workflow Run projection owned by one Session."""
        async with self._session() as session:
            await session.execute(delete(SessionWorkflowRun).where(
                SessionWorkflowRun.session_id == session_id,
                SessionWorkflowRun.user_id == user_id,
            ))
            await session.commit()

    async def search(
        self,
        user_id: str,
        query: str,
        *,
        workflow_id: Optional[str] = None,
        source_session_id: Optional[str] = None,
        session_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[WorkflowRun]:
        """Search owned runs before applying the result limit."""
        needle = query.strip().casefold()
        if not needle:
            if session_id:
                return await self.list_for_session(
                    user_id,
                    session_id,
                    workflow_id=workflow_id,
                    limit=limit,
                    offset=offset,
                )
            if source_session_id:
                return await self.list_for_source_session(
                    user_id,
                    source_session_id,
                    workflow_id=workflow_id,
                    limit=limit,
                    offset=offset,
                )
            if workflow_id:
                return await self.list_for_workflow(
                    user_id, workflow_id, limit=limit, offset=offset,
                )
            return await self.list_for_user(user_id, limit=limit, offset=offset)
        async with self._session() as session:
            stmt = select(WorkflowRun).where(
                WorkflowRun.user_id == user_id,
                WorkflowRun.status.in_([
                    WorkflowRunStatus.COMPLETED,
                    WorkflowRunStatus.FAILED,
                ]),
                or_(
                    func.lower(WorkflowRun.id).contains(needle, autoescape=True),
                    func.lower(WorkflowRun.workflow_name).contains(needle, autoescape=True),
                    func.lower(cast(WorkflowRun.workflow_input, Text)).contains(needle, autoescape=True),
                ),
            )
            if workflow_id:
                stmt = stmt.where(WorkflowRun.workflow_id == workflow_id)
            if source_session_id:
                stmt = stmt.where(WorkflowRun.source_session_id == source_session_id)
            if session_id:
                owner = await self._get_owned(session, SessionRecord, session_id, user_id)
                if owner is None:
                    return []
                stmt = stmt.join(
                    SessionWorkflowRun,
                    SessionWorkflowRun.run_id == WorkflowRun.id,
                ).where(
                    SessionWorkflowRun.session_id == session_id,
                    SessionWorkflowRun.user_id == user_id,
                )
            stmt = (
                stmt.order_by(WorkflowRun.created_at.desc())
                .limit(max(1, min(limit, 200)))
                .offset(max(0, offset))
            )
            return await self._scalars(session, stmt)

    async def delete(self, user_id: str, run_id: str) -> bool:
        """Delete one owned Workflow run record."""
        async with self._session() as session:
            run = await self._get_owned(session, WorkflowRun, run_id, user_id)
            if run is None:
                return False
            await session.execute(delete(SessionWorkflowRun).where(
                SessionWorkflowRun.run_id == run_id,
                SessionWorkflowRun.user_id == user_id,
            ))
            await session.delete(run)
            await session.commit()
            return True


__all__ = [
    "WorkflowRun",
    "WorkflowRunRepository",
    "WorkflowRunStatus",
    "SessionWorkflowRun",
]
