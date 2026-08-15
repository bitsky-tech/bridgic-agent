"""HTTP handlers for cron schedules.

``/schedules`` CRUD + ``run-now`` / ``kill``. Read shapes are derived: a
schedule's ``status`` / ``running`` / ``needs_action`` come from the live
``SchedulerService`` (in-flight runs) and the scheduled Sessions (parked
``AWAITING`` runs), never stored on the row. Run history reuses the Session
endpoints — the detail only lists each run's Session id + status.
"""
import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from fastapi import HTTPException, Response, status

from ..i18n import backend_i18n
from ..protocol import CreateScheduleRequest, PatchScheduleRequest
from ...amphi_store import (
    ScheduleRecord,
    ScheduleRepository,
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SessionTurnRepository,
    WorkflowRepository,
)
from ._base import BaseHandler


def _to_local_iso(dt: datetime) -> str:
    """Render a datetime as **local** wall-clock ISO (no tz suffix), matching a
    schedule's own local times (last/next_run). A scheduled run's time comes from
    ``session.created_at``, stored UTC (naive on SQLite round-trip) — label it UTC
    then convert to local, else the run history's time column shows UTC (8h off from
    last/next run) while everything else is local."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone().replace(tzinfo=None).isoformat()


def _parse_refs(refs_json: Optional[str]) -> list:
    """Parse ``refs_json`` → ``list[str]``, tolerant of legacy / malformed values.

    ``create_schedule`` once double-encoded a stringified list (the model passed
    ``refs`` as a JSON string, not a list), leaving a non-list ``json.loads``
    result. Anything that isn't a list degrades to ``[]`` so the GUI never sees a
    non-array ``refs``.
    """
    if not refs_json:
        return []
    try:
        value = json.loads(refs_json)
    except (json.JSONDecodeError, TypeError):
        return []
    return value if isinstance(value, list) else []


class SchedulePresenter:
    """Serialize a schedule + its derived run-state for the HTTP API."""

    @staticmethod
    def status(*, enabled: bool, running: bool, needs_action: int) -> str:
        """Display status, highest-priority first (mirrors the GUI's
        ``ScheduleStatus``): needs-action > running > paused > active."""
        if needs_action > 0:
            return "needsAction"
        if running:
            return "running"
        if not enabled:
            return "paused"
        return "active"

    @staticmethod
    def summary(sched: ScheduleRecord, *, running: bool, needs_action: int) -> dict:
        return {
            "id": sched.id,
            "name": sched.name,
            "desc": sched.desc,
            "cron": sched.cron,
            "enabled": sched.enabled,
            "status": SchedulePresenter.status(
                enabled=sched.enabled, running=running, needs_action=needs_action,
            ),
            # Flat alongside ``status`` on purpose: ``status`` is mutually exclusive, so a
            # schedule with parked AWAITING runs reports ``needsAction`` and would hide the
            # fact that runs are still in flight. Clients need both to reason about it.
            "running": running,
            "needs_action": needs_action,
            "refs": _parse_refs(sched.refs_json),
            "last_run_at": sched.last_run_at.isoformat() if sched.last_run_at else None,
            "next_run_at": sched.next_run_at.isoformat() if sched.next_run_at else None,
            "created_at": sched.created_at.isoformat(),
        }

    @staticmethod
    def run(session: SessionRecord, *, running: bool, can_continue: bool) -> dict:
        """One run = one scheduled Session; full detail is the Session itself.

        ``running`` covers the root and every active Child invocation. A Run may
        continue only after its root Turn is durably terminal and the whole tree
        is idle; ``SessionStatus`` alone cannot distinguish that boundary.
        """
        stat = session.status
        return {
            "session_id": session.id,
            "status": stat.value if hasattr(stat, "value") else stat,
            "running": running,
            "can_continue": can_continue,
            "created_at": _to_local_iso(session.created_at),
            "last_answer": session.last_answer,
        }


async def _summarize(
    state: Any,
    sched: ScheduleRecord,
    needs_action: int | None = None,
    workflow_names: Mapping[str, str] | None = None,
) -> dict:
    """Build a schedule summary, gathering live run-state (running + needs_action).

    Pass ``needs_action`` when listing many rows — the bulk count avoids the
    1+N per-row queries this helper otherwise issues.
    """
    running = state.scheduler.is_running(sched.id)
    if needs_action is None:
        needs_action = await SessionRepository().count_awaiting_scheduled(sched.id)
    if workflow_names is None:
        workflows = await WorkflowRepository().list_for_user(sched.user_id)
        workflow_names = {workflow.id: workflow.name for workflow in workflows}
    summary = SchedulePresenter.summary(sched, running=running, needs_action=needs_action)
    summary["refs"] = [
        workflow_names.get(reference, reference)
        if isinstance(reference, str) else reference
        for reference in summary["refs"]
    ]
    return summary


class SchedulesHandler(BaseHandler):
    """Bind: ``GET /schedules`` (list), ``POST`` (create)."""

    tags = ["schedules"]

    async def get(self, limit: Optional[int] = None, offset: int = 0) -> Response:
        user = await self.require_user()
        # Pagination is optional; passing no parameters returns everything.
        rows, workflows = await asyncio.gather(
            ScheduleRepository().list_for_user(user.id, limit=limit, offset=offset),
            WorkflowRepository().list_for_user(user.id),
        )
        workflow_names = {workflow.id: workflow.name for workflow in workflows}
        # One GROUP BY for every row's badge count instead of a query per row.
        needs = await SessionRepository().count_awaiting_scheduled_bulk(
            [row.id for row in rows],
        )
        return self.response([
            await _summarize(
                self.state,
                row,
                needs_action=needs.get(row.id, 0),
                workflow_names=workflow_names,
            )
            for row in rows
        ])

    async def post(self, body: CreateScheduleRequest) -> Response:
        user = await self.require_user()
        next_run = self.state.scheduler.compute_next(body.cron)
        if next_run is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Invalid cron expression: {body.cron!r}",
            )
        sched = await ScheduleRepository().create(
            user.id,
            name=body.name,
            desc=body.desc,
            cron=body.cron,
            refs_json=json.dumps(body.refs, ensure_ascii=False) if body.refs else None,
            enabled=body.enabled,
            next_run_at=next_run,
            # The creating client is connected right now — persist its display
            # locale so run-time notifications don't have to guess from desc.
            locale=backend_i18n.current_locale(),
        )
        return self.response(await _summarize(self.state, sched), status_code=status.HTTP_201_CREATED)


class ScheduleItemHandler(BaseHandler):
    """Bind: ``GET`` / ``PATCH`` / ``DELETE`` on ``/schedules/{schedule_id}``."""

    tags = ["schedules"]

    async def get(self, schedule_id: str) -> Response:
        user = await self.require_user()
        sched = await ScheduleRepository().get(user.id, schedule_id)
        if sched is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="schedule not found")
        summary = await _summarize(self.state, sched)
        sessions = await SessionRepository().list_scheduled(schedule_id)
        turn_summaries, *child_groups = await asyncio.gather(
            SessionTurnRepository().load_summaries(sessions),
            *(SessionRepository().list_children(user.id, session.id) for session in sessions),
        )
        runs = []
        for session, children in zip(sessions, child_groups):
            running = any(
                self.invocations.is_running(record.id)
                for record in (session, *children)
            )
            latest_status = turn_summaries[session.id].latest_status
            finished = session.status in {SessionStatus.COMPLETED, SessionStatus.FINISH}
            runs.append(SchedulePresenter.run(
                session,
                running=running,
                can_continue=(
                    finished
                    and latest_status is not None
                    and latest_status.is_terminal
                    and not running
                ),
            ))
        return self.response({**summary, "runs": runs})

    async def patch(self, schedule_id: str, body: PatchScheduleRequest) -> Response:
        user = await self.require_user()
        repo = ScheduleRepository()
        existing = await repo.get(user.id, schedule_id)
        if existing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="schedule not found")
        next_run: Optional[Any] = None
        if body.cron is not None:
            next_run = self.state.scheduler.compute_next(body.cron)
            if next_run is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"Invalid cron expression: {body.cron!r}",
                )
        # Re-enabling recomputes next_run from the effective cron: a next_run_at
        # frozen while paused is now in the past and would otherwise trigger an
        # immediate catch-up fire (D9 says missed fires are dropped).
        if body.enabled is True and next_run is None:
            next_run = self.state.scheduler.compute_next(body.cron or existing.cron)
        await repo.update(
            user.id, schedule_id,
            name=body.name, desc=body.desc, cron=body.cron,
            enabled=body.enabled, next_run_at=next_run,
            locale=backend_i18n.current_locale(),
        )
        sched = await repo.get(user.id, schedule_id)
        if sched is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="schedule not found")
        return self.response(await _summarize(self.state, sched))

    async def delete(self, schedule_id: str) -> Response:
        user = await self.require_user()
        if not await ScheduleRepository().delete(user.id, schedule_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="schedule not found")
        # Deletion also cancels any run already in flight, so a stuck/long run
        # never outlives its schedule; kill is a no-op when nothing is running.
        await self.state.scheduler.kill(schedule_id)
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class ScheduleRunNowHandler(BaseHandler):
    """Bind: ``POST /schedules/{schedule_id}/run-now`` — fire immediately."""

    tags = ["schedules"]

    async def post(self, schedule_id: str) -> Response:
        user = await self.require_user()
        sched = await ScheduleRepository().get(user.id, schedule_id)
        if sched is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="schedule not found")
        await self.state.scheduler.run_now(sched)
        return self.response({"ok": "pending"}, status_code=status.HTTP_202_ACCEPTED)


class ScheduleKillHandler(BaseHandler):
    """Bind: ``POST /schedules/{schedule_id}/kill`` — cancel the in-flight run."""

    tags = ["schedules"]

    async def post(self, schedule_id: str) -> Response:
        user = await self.require_user()
        if await ScheduleRepository().get(user.id, schedule_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="schedule not found")
        killed = await self.state.scheduler.kill(schedule_id)
        return self.response({"ok": True, "killed": killed}, status_code=status.HTTP_202_ACCEPTED)


__all__ = [
    "SchedulesHandler",
    "ScheduleItemHandler",
    "ScheduleRunNowHandler",
    "ScheduleKillHandler",
]
