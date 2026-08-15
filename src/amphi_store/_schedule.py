"""Persisted cron schedules — one row per user-created scheduled task.

A schedule is a natural-language task (``desc``) + a 6-field cron + display-only
``refs`` to the workflows/skills it mentions. Each fire creates a scheduled
Session (``SessionRecord.kind == 'scheduled'``) that runs ``desc`` as the goal;
run history / HITL / events all reuse the Session machinery. Ownership-scoped by
``user_id``, mirroring :mod:`._workflow`.
"""

import secrets
from datetime import datetime
from typing import List, Optional

from sqlmodel import Field, SQLModel, select

from ._base import Repository


def _local_now() -> datetime:
    """Daemon-local wall clock. A schedule's ``created_at`` must share the same
    naive-local basis as ``last_run_at`` / ``next_run_at`` (set by the scheduler
    from ``datetime.now()``), because the GUI renders all three by slicing the
    ISO string with NO timezone conversion — mixing a UTC ``created_at`` with
    local run times would show the created-at time offset by the local UTC delta."""
    return datetime.now()


class ScheduleRecord(SQLModel, table=True):
    __tablename__ = "schedules"

    id: str = Field(primary_key=True, description="Schedule id, e.g. 'sched_ab12...'.")
    user_id: str = Field(foreign_key="users.id", index=True)
    name: str
    desc: str = Field(description="Natural-language task; the run-time goal.")
    cron: str = Field(description="6-field cron (sec min hour dom mon dow).")
    timezone: Optional[str] = Field(
        default=None,
        description="IANA tz for cron interpretation; None → daemon local time.",
    )
    locale: Optional[str] = Field(
        default=None,
        description="Creator's display locale at create/update time; a schedule "
        "fires with no client attached, so this is the declared language signal "
        "notifications fall back on before guessing from ``desc``.",
    )
    refs_json: Optional[str] = Field(
        default=None,
        description="Display-only JSON of referenced workflow/skill ids "
        "(D4: capabilities are global-scope, not a runtime binding).",
    )
    enabled: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=_local_now)
    last_run_at: Optional[datetime] = Field(default=None)
    next_run_at: Optional[datetime] = Field(default=None)


class ScheduleRepository(Repository[ScheduleRecord]):
    """Ownership-scoped CRUD for cron schedules.

    Runtime-only mutations (``set_run_times``, ``list_all_enabled``) are NOT
    ownership-gated: the in-process ``SchedulerService`` owns them.
    """

    @staticmethod
    def new_id() -> str:
        """Create a new Schedule identifier."""
        return f"sched_{secrets.token_hex(8)}"

    async def create(
        self,
        user_id: str,
        *,
        name: str,
        desc: str,
        cron: str,
        timezone: Optional[str] = None,
        refs_json: Optional[str] = None,
        enabled: bool = True,
        schedule_id: Optional[str] = None,
        next_run_at: Optional[datetime] = None,
        locale: Optional[str] = None,
    ) -> ScheduleRecord:
        """Create a schedule row and return it."""
        async with self._session() as s:
            record = ScheduleRecord(
                id=schedule_id or self.new_id(),
                user_id=user_id,
                name=name,
                desc=desc,
                cron=cron,
                timezone=timezone,
                refs_json=refs_json,
                enabled=enabled,
                next_run_at=next_run_at,
                locale=locale,
            )
            s.add(record)
            await s.commit()
            await s.refresh(record)
            return record

    async def get(self, user_id: str, schedule_id: str) -> Optional[ScheduleRecord]:
        """Return one schedule, ownership-gated (``None`` → 404)."""
        async with self._session() as s:
            return await self._get_owned(s, ScheduleRecord, schedule_id, user_id)

    async def list_for_user(
        self, user_id: str, *, limit: Optional[int] = None, offset: int = 0,
    ) -> List[ScheduleRecord]:
        """Owned schedules, newest first. A bare call returns the full list."""
        async with self._session() as s:
            stmt = (
                select(ScheduleRecord)
                .where(ScheduleRecord.user_id == user_id)
                .order_by(ScheduleRecord.created_at.desc())
            )
            if limit is not None:
                stmt = stmt.limit(max(1, min(limit, 200)))
            if offset > 0:
                stmt = stmt.offset(offset)
            return await self._scalars(s, stmt)

    async def list_all_enabled(self) -> List[ScheduleRecord]:
        """Return every enabled schedule across all users (scheduler startup)."""
        async with self._session() as s:
            return await self._scalars(
                s, select(ScheduleRecord).where(ScheduleRecord.enabled.is_(True)),
            )

    async def update(
        self,
        user_id: str,
        schedule_id: str,
        *,
        name: Optional[str] = None,
        desc: Optional[str] = None,
        cron: Optional[str] = None,
        enabled: Optional[bool] = None,
        next_run_at: Optional[datetime] = None,
        locale: Optional[str] = None,
    ) -> Optional[ScheduleRecord]:
        """Partial-update mutable fields; ownership-gated. ``None`` → 404.

        Only non-``None`` arguments are applied — callers send just the changed
        fields (PATCH semantics).
        """
        async with self._session() as s:
            row = await self._get_owned(s, ScheduleRecord, schedule_id, user_id)
            if row is None:
                return None
            if name is not None:
                row.name = name
            if desc is not None:
                row.desc = desc
            if cron is not None:
                row.cron = cron
            if enabled is not None:
                row.enabled = enabled
            if next_run_at is not None:
                row.next_run_at = next_run_at
            if locale is not None:
                row.locale = locale
            await s.commit()
            await s.refresh(row)
            return row

    async def set_run_times(
        self,
        schedule_id: str,
        *,
        last_run_at: Optional[datetime] = None,
        next_run_at: Optional[datetime] = None,
    ) -> None:
        """Runtime-only update of last/next fire timestamps (not ownership-gated).

        Called by the ``SchedulerService`` around each fire; a missing row is a
        no-op (the schedule was deleted mid-flight).
        """
        async with self._session() as s:
            row = await s.get(ScheduleRecord, schedule_id)
            if row is None:
                return
            if last_run_at is not None:
                row.last_run_at = last_run_at
            if next_run_at is not None:
                row.next_run_at = next_run_at
            await s.commit()

    async def delete(self, user_id: str, schedule_id: str) -> bool:
        """Delete a schedule; ownership-gated. ``True`` iff a row existed."""
        async with self._session() as s:
            deleted = await self._delete_owned(s, ScheduleRecord, schedule_id, user_id)
            if deleted:
                await s.commit()
            return deleted


__all__ = ["ScheduleRecord", "ScheduleRepository"]
