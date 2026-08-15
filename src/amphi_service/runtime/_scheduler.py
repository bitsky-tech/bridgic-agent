"""In-process cron scheduler (path A / D11).

One asyncio supervisor loop inside the daemon fires each due schedule as a
scheduled Session (``kind=SCHEDULED``, ``execution_mode='full'``) whose goal is
the schedule's ``desc``. No OS-level cron — the daemon must be alive (a
launchd agent on macOS or a login-started detached process on Windows keeps it
available for unattended use; Windows login autostart does not restart crashes
while the Desktop is closed).

Invariants:
* Overlap is fixed to 'overlap' (fire again as usual): every due tick fires, even if a prior
  run is still running or parked ``AWAITING`` — a stuck run never blocks the
  schedule. ``_running`` is a *set* per schedule so concurrent runs are tracked.
* Missed fires while the daemon was down are dropped (D9) — on start each
  schedule's next fire is computed forward from *now*.
* 6-field cron is ``sec min hour dom mon dow`` (seconds first), matching the GUI
  (``lib/cron.ts``); croniter is told ``second_at_beginning=True``.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, Literal, Optional, Set

from croniter import croniter

from ...amphi_store import (
    ScheduleRecord,
    ScheduleRepository,
    SessionKind,
    SessionRepository,
    SessionStatus,
    UserRepository,
)
from ..i18n import DEFAULT_LOCALE, Locale, backend_i18n, detect_locale, use_locale
from ..protocol import ScheduleNotifyEvent
from ._notify import notify
from ._system_events import SystemEventBroker


def _supported_locale(value: Optional[str]) -> Optional[Locale]:
    """Narrow a persisted locale string to a supported Locale, else ``None``."""
    return value if value in ("zh", "en") else None  # type: ignore[return-value]
from ._sessions import SessionService

if TYPE_CHECKING:
    from ...amphi_agent import AgentInvocation

logger = logging.getLogger(__name__)

_DEFAULT_TICK_SECONDS = 30.0
_MIN_SLEEP_SECONDS = 0.5


def _now() -> datetime:
    """Daemon-local wall clock for all schedule time math — cron is interpreted
    in local time ('9am' means 9am here)."""
    return datetime.now()


class SchedulerService:
    """Owns the cron supervisor loop and each schedule's in-flight run.

    Parameters
    ----------
    invocations : AgentInvocation
        The process-wide ``AgentInvocation`` used to drive each run's turn.
    sessions : SessionService
        Root Session lifecycle used for each scheduled run.
    system_events : SystemEventBroker
        Process-wide bus used to hand post-run notifications to a connected
        desktop client (gui-tagged subscriber) instead of the OS notifier.
    tick_seconds : float
        Upper bound on the supervisor's sleep between passes, so newly created
        or edited schedules are noticed within this window.
    """

    def __init__(
        self,
        invocations: "AgentInvocation",
        sessions: SessionService,
        *,
        system_events: SystemEventBroker,
        tick_seconds: float = _DEFAULT_TICK_SECONDS,
    ) -> None:
        self._invocations = invocations
        self._session_service = sessions
        self._system_events = system_events
        self._tick = tick_seconds
        self._schedules = ScheduleRepository()
        self._sessions = SessionRepository()
        self._loop_task: Optional[asyncio.Task[None]] = None
        # schedule_id -> the in-flight run tasks (owned by AgentInvocation) THIS
        # scheduler launched; used for occupancy + kill. A SET, not a single
        # task: overlap policy='overlap' and run-now can each launch a run while
        # a prior one is still in flight — a scalar would drop the older handle
        # (unkillable, never cleaned up).
        self._running: Dict[str, Set[asyncio.Task[Any]]] = {}
        # post-run notification tasks, kept referenced so they aren't GC'd.
        self._settling: Set[asyncio.Task[Any]] = set()

    # ---------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        """Prime next-fire times and start the supervisor loop. Idempotent."""
        if self._loop_task is not None and not self._loop_task.done():
            return
        await self._prime_next_runs()
        self._loop_task = asyncio.create_task(self._supervise(), name="scheduler-supervisor")
        logger.info("scheduler started")

    async def stop(self) -> None:
        """Stop the supervisor and drop run tracking. No-op-safe.

        In-flight agent runs are owned by ``AgentInvocation`` and torn down by
        its own ``shutdown()`` (called next in the daemon lifespan), so we don't
        cancel them here."""
        task = self._loop_task
        self._loop_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._running.clear()
        for settling in list(self._settling):
            settling.cancel()
        self._settling.clear()
        logger.info("scheduler stopped")

    # ------------------------------------------------------------------- cron
    def compute_next(self, cron: str, base: Optional[datetime] = None) -> Optional[datetime]:
        """Next fire strictly after ``base`` (now if omitted); ``None`` (logged)
        on a bad cron so one malformed schedule never sinks the loop. Public so
        the REST layer can prime ``next_run_at`` on create / edit."""
        try:
            return croniter(cron, base or _now(), second_at_beginning=True).get_next(datetime)
        except Exception:  # noqa: BLE001
            logger.warning("scheduler: bad cron %r; skipped", cron)
            return None

    # --------------------------------------------------------------- supervisor
    async def _prime_next_runs(self) -> None:
        now = _now()
        for sched in await self._schedules.list_all_enabled():
            nxt = self.compute_next(sched.cron, now)
            if nxt is not None:
                await self._schedules.set_run_times(sched.id, next_run_at=nxt)

    async def _supervise(self) -> None:
        while True:
            try:
                delay = await self._tick_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — one bad pass must not kill the loop
                logger.exception("scheduler: supervisor pass failed")
                delay = self._tick
            await asyncio.sleep(max(delay, _MIN_SLEEP_SECONDS))

    async def _tick_once(self) -> float:
        """Fire everything due; return seconds to sleep until the next fire."""
        now = _now()
        soonest: Optional[datetime] = None
        for sched in await self._schedules.list_all_enabled():
            nxt = sched.next_run_at or self.compute_next(sched.cron, now)
            if nxt is None:
                continue
            if nxt <= now:
                await self._fire(sched)
                nxt = self.compute_next(sched.cron, now)
                if nxt is None:
                    continue
                await self._schedules.set_run_times(sched.id, next_run_at=nxt)
            elif sched.next_run_at is None:
                await self._schedules.set_run_times(sched.id, next_run_at=nxt)
            soonest = nxt if soonest is None else min(soonest, nxt)
        if soonest is None:
            return self._tick
        return min((soonest - _now()).total_seconds(), self._tick)

    # ------------------------------------------------------------------ firing
    def is_running(self, schedule_id: str) -> bool:
        """Whether this scheduler has any in-flight run for ``schedule_id``."""
        return bool(self._running.get(schedule_id))

    async def run_now(self, schedule: ScheduleRecord) -> None:
        """Fire a schedule immediately (manual override)."""
        await self._fire(schedule)

    async def kill(self, schedule_id: str) -> bool:
        """Cancel every in-flight run for ``schedule_id`` (best-effort). Returns
        whether at least one run was cancelled; the agent turn handles
        cancellation cooperatively (persists a cancelled turn)."""
        cancelled = False
        for run_task in list(self._running.get(schedule_id, ())):
            if not run_task.done():
                run_task.cancel()
                cancelled = True
        return cancelled

    async def _fire(self, sched: ScheduleRecord) -> None:
        # Overlap policy is fixed to 'overlap' (fire again as usual): every due tick fires a run
        # regardless of a previous run still running / parked awaiting a human — so a
        # stuck run never blocks the schedule forever. No occupancy gate.
        user = await UserRepository().load(sched.user_id)
        if user is None:
            logger.warning("scheduler: schedule %s owner %s missing; skipped", sched.id, sched.user_id)
            return
        try:
            record = await self._session_service.create_root(
                user.id,
                model=user.current_model,
                kind=SessionKind.SCHEDULED,
                schedule_id=sched.id,
            )
        except Exception:  # noqa: BLE001
            logger.exception("scheduler: failed to create session for %s", sched.id)
            return

        await self._schedules.set_run_times(sched.id, last_run_at=_now())
        declared_locale = _supported_locale(sched.locale)
        try:
            # The run task copies the current context, so the creator's declared
            # locale becomes the turn's ambient fallback (detect_locale on the
            # turn's own text still takes precedence inside the agent).
            with use_locale(declared_locale or DEFAULT_LOCALE):
                run_task = await self._invocations.arun(record.id, sched.desc, execution_mode="full")
        except Exception:  # noqa: BLE001
            logger.exception("scheduler: failed to start run for %s", sched.id)
            return

        self._running.setdefault(sched.id, set()).add(run_task)
        name = sched.name
        desc = sched.desc
        session_id = record.id
        schedule_id = sched.id

        def _on_done(task: asyncio.Task[Any]) -> None:
            live = self._running.get(schedule_id)
            if live is not None:
                live.discard(task)
                if not live:
                    self._running.pop(schedule_id, None)
            settling = asyncio.create_task(
                self._after_run(
                    name, session_id, task, desc,
                    locale=declared_locale, schedule_id=schedule_id,
                ),
            )
            self._settling.add(settling)
            settling.add_done_callback(self._settling.discard)

        run_task.add_done_callback(_on_done)
        logger.info("scheduler: fired %s (session %s)", sched.id, record.id)

    async def _after_run(
        self,
        schedule_name: str,
        session_id: str,
        run_task: asyncio.Task[Any],
        desc: str,
        *,
        locale: Optional[Locale] = None,
        schedule_id: str = "",
    ) -> None:
        """OS-notify (D7 / A2) if the run failed or parked awaiting a human.

        A schedule fires with no client attached, so the declared ``locale``
        captured when the creator was connected is the primary signal. Guessing
        from ``desc`` is only the fallback for rows without one: ``desc`` is a
        model-authored tool argument, and a one-word or path-heavy description
        carries no language signal at all.
        """
        if run_task.cancelled():
            return
        try:
            failed = run_task.exception() is not None
        except Exception:  # noqa: BLE001
            failed = True
        session = await self._sessions.load_by_id(session_id)
        awaiting = session is not None and session.status is SessionStatus.AWAITING
        if not failed and not awaiting:
            return
        kind: Literal["failed", "action_required"]
        with use_locale(locale or detect_locale(desc) or DEFAULT_LOCALE):
            if failed:
                kind = "failed"
                title = backend_i18n.text("scheduler.notification.failed_title")
                body = backend_i18n.text("scheduler.notification.failed_body", name=schedule_name)
            else:
                kind = "action_required"
                title = backend_i18n.text("scheduler.notification.action_required_title")
                body = backend_i18n.text("scheduler.notification.action_required_body", name=schedule_name)
        # A connected desktop client renders the toast (proper app identity +
        # click-to-open); the OS notifier is only the nobody-listening fallback.
        # publish_counting is atomic — the gui count reflects exactly who had
        # the event enqueued, so the two paths are mutually exclusive.
        delivered = await self._system_events.publish_counting(
            ScheduleNotifyEvent(
                kind=kind,
                title=title,
                body=body,
                session_id=session_id,
                schedule_id=schedule_id,
                schedule_name=schedule_name,
            ),
            tag="gui",
        )
        if delivered == 0:
            # to_thread: notify() shells out with a 5s timeout; calling it
            # inline would block the event loop for that long.
            await asyncio.to_thread(notify, title, body)


__all__ = ["SchedulerService"]
