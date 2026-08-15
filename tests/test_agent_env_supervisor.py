"""Background preparation of the Agent command environment."""

import asyncio
from pathlib import Path

import pytest

from src.amphi_agent import AppEnvironmentStatus
from src.amphi_agent.runtime._environment import (
    AppCommandEnvironment,
    bundled_runtime_resources,
    bundled_uv_runtime,
)
from src.amphi_service.runtime._env_supervisor import AgentEnvironmentSupervisor


def _supervisor(prepare, status) -> AgentEnvironmentSupervisor:
    """Build a supervisor whose backoff does not slow the test down."""
    return AgentEnvironmentSupervisor(
        prepare,
        status,
        delays=(0.0, 0.0),
        steady_delay=0.0,
    )


async def test_supervisor_retries_a_transient_failure_until_it_lands() -> None:
    """A held handle clears on its own, so the daemon just keeps trying."""
    attempts: list[int] = []
    verdict = [AppEnvironmentStatus("preparing", "Access is denied")]

    async def prepare() -> None:
        attempts.append(len(attempts) + 1)
        if len(attempts) < 3:
            raise PermissionError("Access is denied")
        verdict[0] = AppEnvironmentStatus("ready")

    supervisor = _supervisor(prepare, lambda: verdict[0])
    await supervisor.run()

    assert attempts == [1, 2, 3]
    assert supervisor.status().state == "ready"


async def test_supervisor_stops_retrying_an_install_that_cannot_heal() -> None:
    """A binary the installer never wrote will not appear on attempt seven."""
    attempts: list[int] = []
    verdict = AppEnvironmentStatus("failed", "missing uv executable")

    async def prepare() -> None:
        attempts.append(len(attempts) + 1)
        raise RuntimeError("App runtime resources are incomplete")

    supervisor = _supervisor(prepare, lambda: verdict)
    await supervisor.run()

    assert attempts == [1]
    assert supervisor.status().retryable is False


async def test_supervisor_stop_cancels_an_attempt_in_flight() -> None:
    """Shutdown must not leave a preparation thread running behind the daemon."""
    cancelled = asyncio.Event()

    async def prepare() -> None:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    supervisor = _supervisor(prepare, lambda: AppEnvironmentStatus("preparing"))
    supervisor.start()
    await asyncio.sleep(0)
    await supervisor.stop()

    assert cancelled.is_set()


async def test_supervisor_start_is_idempotent() -> None:
    """A second start must not spawn a competing preparation task."""
    attempts: list[int] = []

    async def prepare() -> None:
        attempts.append(len(attempts) + 1)
        await asyncio.sleep(3600)

    supervisor = _supervisor(prepare, lambda: AppEnvironmentStatus("preparing"))
    supervisor.start()
    await asyncio.sleep(0)
    supervisor.start()
    await asyncio.sleep(0)
    await supervisor.stop()

    assert attempts == [1]


async def test_supervisor_gives_up_on_a_genuinely_incomplete_install(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The seam under test: the runtime's own verdict stops the retry loop.

    Every other case here stubs the verdict, which would keep passing if the
    two layers stopped agreeing on what "not retryable" means.
    """
    monkeypatch.setattr(bundled_runtime_resources, "directory", lambda: tmp_path)
    monkeypatch.setattr(bundled_uv_runtime, "bundled_executable", lambda: None)
    environment = AppCommandEnvironment()
    attempts: list[int] = []

    async def prepare() -> None:
        attempts.append(len(attempts) + 1)
        await asyncio.to_thread(environment.prepare)

    supervisor = _supervisor(prepare, environment.status)
    await supervisor.run()

    assert attempts == [1]
    assert supervisor.status().state == "failed"


@pytest.mark.parametrize("attempt", [0, 1, 2, 3, 4, 9])
def test_backoff_widens_then_settles(attempt: int) -> None:
    """The published schedule is 1s, 5s, 15s, 60s, then every 5 minutes."""
    supervisor = AgentEnvironmentSupervisor(None, None)

    assert supervisor._delay(attempt) == (1.0, 5.0, 15.0, 60.0, 300.0, 300.0)[
        min(attempt, 5)
    ]
