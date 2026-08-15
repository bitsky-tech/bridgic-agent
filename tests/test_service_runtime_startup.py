"""Service lifecycle ordering for Agent-owned runtime preparation."""

import asyncio
import threading
from types import SimpleNamespace
from typing import Awaitable, Callable, Optional

import pytest

import src.amphi_agent._skills as skills_module
import src.amphi_service._app as app_module
from src.amphi_agent import AppEnvironmentStatus
from src.amphi_service._app import ServiceApp
from src.amphi_service.runtime import AgentEnvironmentSupervisor


class _LifecyclePeer:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    async def prepare(self) -> None:
        self._events.append("invocations.prepare")

    async def recover(self) -> None:
        self._events.append("invocations.recover")

    async def shutdown(self) -> None:
        self._events.append("invocations.shutdown")

    async def start(self) -> None:
        self._events.append("scheduler.start")

    async def stop(self) -> None:
        self._events.append("scheduler.stop")


class _BrowserHostPeer:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    async def shutdown(self) -> None:
        self._events.append("browser.close")


def _service(
    events: list[str],
    *,
    prepare: Optional[Callable[[], Awaitable[None]]] = None,
    status: AppEnvironmentStatus = AppEnvironmentStatus("ready"),
) -> ServiceApp:
    invocations = _LifecyclePeer(events)
    service = object.__new__(ServiceApp)
    service.state = SimpleNamespace(
        invocations=invocations,
        scheduler=_LifecyclePeer(events),
        browser_host=_BrowserHostPeer(events),
        # A long backoff keeps a deliberately failing attempt from spinning
        # for the rest of the test.
        agent_env=AgentEnvironmentSupervisor(
            prepare or invocations.prepare,
            lambda: status,
            delays=(3600.0,),
            steady_delay=3600.0,
        ),
    )
    return service


def _stub_lifecycle(monkeypatch: pytest.MonkeyPatch, events: list[str]) -> None:
    async def init_schema() -> None:
        events.append("repository.init_schema")

    async def close_repository() -> None:
        events.append("repository.close")

    async def seed_local_user() -> None:
        events.append("user.seed")

    async def get_current_user():
        events.append("user.load")
        return SimpleNamespace(id="local", api_key=None)

    class SkillLibrary:
        def __init__(self, user_id: str) -> None:
            assert user_id == "local"

        async def sync_builtins(self) -> None:
            events.append("skills.sync")

    monkeypatch.setattr(app_module.Repository, "init_schema", init_schema)
    monkeypatch.setattr(app_module.Repository, "close", close_repository)
    monkeypatch.setattr(app_module, "seed_local_user", seed_local_user)
    monkeypatch.setattr(app_module, "get_current_user", get_current_user)
    monkeypatch.setattr(skills_module, "SkillLibrary", SkillLibrary)


async def test_lifespan_never_waits_for_agent_resource_preparation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Preparation runs beside startup, not in front of it.

    Nothing in the startup sequence needs the shared bases, and holding the
    daemon behind a five-minute file lock is the difference between a slow
    launch and a launch that never finishes.
    """
    events: list[str] = []
    _stub_lifecycle(monkeypatch, events)

    assert not hasattr(app_module, "app_command_environment")

    async with _service(events)._lifespan(None):
        assert events == [
            "repository.init_schema",
            "user.seed",
            "user.load",
            "skills.sync",
            "invocations.recover",
            "scheduler.start",
        ]
        await asyncio.sleep(0)
        assert "invocations.prepare" in events

    assert events[-4:] == [
        "scheduler.stop",
        "invocations.shutdown",
        "browser.close",
        "repository.close",
    ]


async def test_lifespan_starts_degraded_when_agent_resources_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The daemon must come up even with no usable command environment.

    This is the production failure: a handle held on the Python base after an
    app update reached uvicorn as "Application startup failed. Exiting.", and
    nothing retried, so the app never opened again without a manual restart.
    """
    events: list[str] = []
    _stub_lifecycle(monkeypatch, events)

    async def fail_prepare() -> None:
        events.append("invocations.prepare")
        raise PermissionError("Access is denied")

    service = _service(
        events,
        prepare=fail_prepare,
        status=AppEnvironmentStatus("preparing", "Access is denied"),
    )

    async with service._lifespan(None):
        await asyncio.sleep(0)
        assert "invocations.prepare" in events
        assert "repository.init_schema" in events
        assert service.state.agent_env.status().state == "preparing"

    assert events[-4:] == [
        "scheduler.stop",
        "invocations.shutdown",
        "browser.close",
        "repository.close",
    ]


async def test_lifespan_cancels_agent_resource_preparation_on_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A preparation attempt must not outlive the daemon that scheduled it."""
    events: list[str] = []
    _stub_lifecycle(monkeypatch, events)
    cancelled = asyncio.Event()

    async def prepare_forever() -> None:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    async with _service(events, prepare=prepare_forever)._lifespan(None):
        await asyncio.sleep(0)

    assert cancelled.is_set()


async def test_lifespan_repository_failure_still_shuts_down_service_peers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    _stub_lifecycle(monkeypatch, events)

    async def fail_init_schema() -> None:
        events.append("repository.init_schema")
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(app_module.Repository, "init_schema", fail_init_schema)

    with pytest.raises(RuntimeError, match="database unavailable"):
        async with _service(events)._lifespan(None):
            pytest.fail("lifespan yielded after database initialization failed")

    assert events == [
        "repository.init_schema",
        "scheduler.stop",
        "invocations.shutdown",
        "browser.close",
        "repository.close",
    ]


@pytest.mark.parametrize(
    ("peer_name", "method_name", "event"),
    [
        ("scheduler", "stop", "scheduler.stop"),
        ("invocations", "shutdown", "invocations.shutdown"),
        ("browser_host", "shutdown", "browser.close"),
    ],
)
async def test_lifespan_cleanup_failure_does_not_skip_later_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    peer_name: str,
    method_name: str,
    event: str,
) -> None:
    events: list[str] = []
    _stub_lifecycle(monkeypatch, events)
    service = _service(events)

    async def fail_cleanup() -> None:
        events.append(event)
        raise RuntimeError(f"{event} failed")

    peer = getattr(service.state, peer_name)
    monkeypatch.setattr(peer, method_name, fail_cleanup)

    with pytest.raises(RuntimeError, match=rf"{event} failed"):
        async with service._lifespan(None):
            pass

    assert events[-4:] == [
        "scheduler.stop",
        "invocations.shutdown",
        "browser.close",
        "repository.close",
    ]


async def test_prepare_environment_runs_where_interpreter_exit_cannot_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The venv build must never hold the exiting daemon process open.

    ``asyncio.to_thread`` borrows the default executor, and interpreter exit
    joins that executor's threads. A build that is mid-flight when the daemon
    shuts down then keeps the process alive past the CLI's stop timeout, which
    escalates a clean shutdown into taskkill. Daemon threads are abandoned at
    exit instead; the interrupted build's staging directory is reclaimed by
    the next start.
    """
    from src.amphi_agent._workspace import Workspace
    from src.amphi_agent.runtime._environment import WorkspaceEnvironment

    seen: dict[str, bool] = {}

    def record() -> None:
        seen["daemon"] = threading.current_thread().daemon

    monkeypatch.setattr(
        WorkspaceEnvironment, "prepare_app_environment", staticmethod(record)
    )

    await Workspace.prepare_environment()

    assert seen["daemon"] is True


async def test_prepare_environment_still_propagates_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The thread swap must not swallow what the supervisor classifies on."""
    from src.amphi_agent._workspace import Workspace
    from src.amphi_agent.runtime._environment import WorkspaceEnvironment

    def explode() -> None:
        raise RuntimeError("prepare failed")

    monkeypatch.setattr(
        WorkspaceEnvironment, "prepare_app_environment", staticmethod(explode)
    )

    with pytest.raises(RuntimeError, match="prepare failed"):
        await Workspace.prepare_environment()
