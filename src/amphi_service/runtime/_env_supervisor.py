"""Off-startup preparation of the Agent command environment.

Preparing the shared Python and Node bases touches the filesystem the app
just finished writing, so it fails for reasons that clear on their own: a
handle another process holds, a cross-process lock a sibling daemon owns.
Awaiting that during startup turned every one of them into uvicorn's
"Application startup failed. Exiting." -- with nothing left to retry, the
user was left with an app that never opened again. The daemon now starts
degraded and heals in the background instead.
"""

import asyncio
import logging
from typing import Awaitable, Callable, Optional, Sequence

from ...amphi_agent import AppEnvironmentStatus

logger = logging.getLogger(__name__)

# 1s covers the handle that is already gone; the tail keeps a daemon that
# started next to a slow installer trying for as long as that installer runs.
RETRY_DELAYS_SEC: tuple[float, ...] = (1.0, 5.0, 15.0, 60.0)
STEADY_RETRY_DELAY_SEC = 300.0


class AgentEnvironmentSupervisor:
    """Prepare the Agent command environment beside the running daemon.

    Parameters
    ----------
    prepare : callable
        Awaitable running one full preparation attempt.
    status : callable
        Returns the current readiness verdict. It also decides when to give
        up: a verdict that is not retryable describes an install no amount of
        waiting repairs.
    delays : sequence of float, optional
        Seconds to wait after each of the first attempts.
    steady_delay : float, optional
        Seconds between every attempt after ``delays`` runs out.
    """

    def __init__(
        self,
        prepare: Optional[Callable[[], Awaitable[None]]],
        status: Optional[Callable[[], AppEnvironmentStatus]],
        *,
        delays: Sequence[float] = RETRY_DELAYS_SEC,
        steady_delay: float = STEADY_RETRY_DELAY_SEC,
    ) -> None:
        self._prepare = prepare
        self._status = status
        self._delays = tuple(delays)
        self._steady_delay = steady_delay
        self._task: Optional[asyncio.Task[None]] = None

    def start(self) -> None:
        """Schedule preparation without blocking the caller."""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self.run(), name="agent-environment")

    async def stop(self) -> None:
        """Cancel preparation and wait for the task to finish unwinding."""
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def status(self) -> AppEnvironmentStatus:
        """Return the readiness the gateway status payload reports."""
        return self._status()

    async def run(self) -> None:
        """Retry preparation on a widening backoff until it lands or cannot."""
        attempt = 0
        while await self.attempt():
            await asyncio.sleep(self._delay(attempt))
            attempt += 1

    async def attempt(self) -> bool:
        """Run one attempt, returning whether another one is worth making."""
        try:
            await self._prepare()
        except Exception as exc:  # noqa: BLE001 - the daemon outlives any of these
            status = self.status()
            if not status.retryable:
                logger.error("Agent environment cannot be prepared: %s", exc)
                return False
            logger.warning("Agent environment is not ready yet: %s", exc)
            return True
        return False

    def _delay(self, attempt: int) -> float:
        """Return the wait before the attempt after ``attempt``."""
        if attempt < len(self._delays):
            return self._delays[attempt]
        return self._steady_delay
