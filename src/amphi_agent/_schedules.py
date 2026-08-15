import json
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Optional, Tuple

from croniter import croniter

from ..amphi_store import ScheduleRecord, ScheduleRepository
from ..amphi_service.i18n import backend_i18n


@dataclass(frozen=True)
class Schedule:
    """One persisted scheduled task exposed to the Agent layer."""

    schedule_id: str
    name: str
    description: str
    cron: str
    enabled: bool
    refs: Tuple[str, ...]
    created_at: datetime
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None


class ScheduleLibrary:
    """``AmphiContext.schedules`` - the Agent-facing schedule catalogue.

    Parameters
    ----------
    user_id : str
        Owner used for every schedule lookup and mutation.
    mutable : bool
        Whether this Session may create or update schedules.
    """

    def __init__(self, user_id: str, *, mutable: bool = True) -> None:
        self._user_id = user_id
        self._mutable = mutable
        self._repo = ScheduleRepository()
        self._schedules: Dict[str, Schedule] = {}

    async def load(self) -> "ScheduleLibrary":
        """Load every schedule owned by this user."""
        rows = await self._repo.list_for_user(self._user_id)
        self._schedules = {
            row.id: self._from_row(row)
            for row in rows
        }
        return self

    def is_empty(self) -> bool:
        """Return whether the user has no schedules."""
        return not self._schedules

    def data(self) -> Dict[str, Schedule]:
        """Return loaded schedules keyed by stable id."""
        return self._schedules

    def get(self, schedule_id: str) -> Optional[Schedule]:
        """Return one loaded schedule by id."""
        return self._schedules.get(schedule_id)

    def search(self, query: str = "", *, enabled: Optional[bool] = None) -> Tuple[Schedule, ...]:
        """Return loaded schedules matching optional text and enabled filters."""
        needle = query.strip().lower()
        schedules = (
            schedule
            for schedule in self._schedules.values()
            if enabled is None or schedule.enabled is enabled
        )
        if needle:
            schedules = (
                schedule
                for schedule in schedules
                if needle in schedule.schedule_id.lower()
                or needle in schedule.name.lower()
                or needle in schedule.description.lower()
            )
        return tuple(sorted(schedules, key=lambda schedule: schedule.created_at, reverse=True))

    async def create(self, name: str, description: str, cron: str, refs: object = None) -> Schedule:
        """Validate and persist a new scheduled task.

        Parameters
        ----------
        name : str
            Short display name.
        description : str
            Complete natural-language goal for every scheduled run.
        cron : str
            Six-field, seconds-first cron expression.
        refs : object, optional
            Workflow IDs or Skill names retained for display.

        Returns
        -------
        Schedule
            The persisted Agent-facing schedule.
        """
        self._ensure_mutable()
        name = (name or "").strip()
        description = (description or "").strip()
        cron = (cron or "").strip()
        if not name or not description or not cron:
            raise ValueError(backend_i18n.text("agent.schedule.required_fields"))
        normalized_refs = self._normalize_refs(refs)
        row = await self._repo.create(
            self._user_id,
            name=name,
            desc=description,
            cron=cron,
            refs_json=json.dumps(normalized_refs, ensure_ascii=False) if normalized_refs else None,
            next_run_at=self._next_run(cron),
            # The creator is connected right now — persist their display locale
            # so run-time notifications don't have to guess it from ``desc``.
            locale=backend_i18n.current_locale(),
        )
        schedule = self._from_row(row)
        self._schedules[schedule.schedule_id] = schedule
        return schedule

    async def update(
        self,
        schedule_id: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        cron: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> Schedule:
        """Apply a partial update to one existing scheduled task.

        Parameters
        ----------
        schedule_id : str
            Stable schedule identifier.
        name, description, cron, enabled : optional
            Only supplied fields are changed.

        Returns
        -------
        Schedule
            The updated Agent-facing schedule.
        """
        self._ensure_mutable()
        schedule_id = (schedule_id or "").strip()
        current = self.get(schedule_id)
        if not schedule_id or current is None:
            raise ValueError(backend_i18n.text("agent.schedule.not_found", schedule_id=schedule_id))

        normalized_cron = (cron or "").strip() or None
        next_run = self._next_run(normalized_cron) if normalized_cron else None
        if enabled is True and next_run is None:
            next_run = self._next_run(current.cron)
        await self._repo.update(
            self._user_id,
            schedule_id,
            name=(name or "").strip() or None,
            desc=(description or "").strip() or None,
            locale=backend_i18n.current_locale(),
            cron=normalized_cron,
            enabled=enabled,
            next_run_at=next_run,
        )
        row = await self._repo.get(self._user_id, schedule_id)
        if row is None:
            raise ValueError(backend_i18n.text("agent.schedule.not_found", schedule_id=schedule_id))
        schedule = self._from_row(row)
        self._schedules[schedule.schedule_id] = schedule
        return schedule

    async def delete(self, schedule_id: str) -> Schedule:
        """Delete one existing scheduled task and return the removed record.

        Parameters
        ----------
        schedule_id : str
            Stable schedule identifier.

        Returns
        -------
        Schedule
            The Agent-facing schedule that was removed (for a confirmation).
        """
        self._ensure_mutable()
        schedule_id = (schedule_id or "").strip()
        current = self.get(schedule_id)
        if not schedule_id or current is None:
            raise ValueError(backend_i18n.text("agent.schedule.not_found", schedule_id=schedule_id))
        await self._repo.delete(self._user_id, schedule_id)
        self._schedules.pop(schedule_id, None)
        return current

    def _ensure_mutable(self) -> None:
        if not self._mutable:
            raise ValueError(backend_i18n.text("agent.schedule.mutation_blocked"))

    @staticmethod
    def _next_run(cron: str) -> datetime:
        try:
            return croniter(cron, datetime.now(), second_at_beginning=True).get_next(datetime)
        except Exception as exc:
            raise ValueError(backend_i18n.text("agent.schedule.invalid_cron", cron=cron)) from exc

    @staticmethod
    def _normalize_refs(refs: object) -> Tuple[str, ...]:
        if not refs:
            return ()
        if isinstance(refs, str):
            try:
                parsed = json.loads(refs)
            except (json.JSONDecodeError, TypeError):
                parsed = refs
            refs = parsed if isinstance(parsed, list) else [refs]
        if not isinstance(refs, (list, tuple)):
            return ()
        return tuple(dict.fromkeys(str(value).strip() for value in refs if str(value).strip()))

    @staticmethod
    def _from_row(row: ScheduleRecord) -> Schedule:
        try:
            refs = json.loads(row.refs_json) if row.refs_json else []
        except (json.JSONDecodeError, TypeError):
            refs = []
        return Schedule(
            schedule_id=row.id,
            name=row.name,
            description=row.desc,
            cron=row.cron,
            enabled=row.enabled,
            refs=tuple(str(value) for value in refs) if isinstance(refs, list) else (),
            created_at=row.created_at,
            last_run_at=row.last_run_at,
            next_run_at=row.next_run_at,
        )


__all__ = ["Schedule", "ScheduleLibrary"]
