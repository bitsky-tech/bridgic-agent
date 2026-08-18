from __future__ import annotations

import json
import os
import stat
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest

from src.amphi_service.server._manager import (
    DEFAULT_WS_PATH,
    ServerError,
    ServerInstance,
    ServerInstanceLock,
    ServerInstanceLockHeld,
    ServerLockState,
    ServerManager,
    ServerOptions,
    ServerRegistration,
    ServerStartResult,
    ServerStartTimeout,
    ServerStopResult,
)
from src.amphi_service.server.supervisor import SupervisorError


def _instance(
    *,
    pid: int = 1234,
    token: Optional[str] = "private-token",
) -> ServerInstance:
    return ServerInstance(
        host="127.0.0.1",
        port=7421,
        pid=pid,
        started_at="2026-07-28T12:00:00",
        token=token,
        lock_file="/runtime/gateway.lock",
        version="1.2.3",
    )


class _Registration:
    def __init__(
        self,
        path: Path,
        *,
        instance: Optional[ServerInstance] = None,
        alive: bool = False,
        ready: Optional[ServerInstance] = None,
        pid_alive: Optional[bool] = None,
    ) -> None:
        self.path = path
        self.instance = instance
        self.alive = alive
        self.ready = ready
        self.pid_is_alive = alive if pid_alive is None else pid_alive
        self.clear_calls: list[ServerInstance] = []
        self.wait_calls: list[dict[str, Any]] = []

    def read(self) -> Optional[ServerInstance]:
        return self.instance

    def is_alive(self, instance: ServerInstance) -> bool:
        assert instance is self.instance
        return self.alive

    def clear(self, expected: ServerInstance, *, instance_lock: Any) -> bool:
        assert instance_lock.held
        self.clear_calls.append(expected)
        if self.instance != expected:
            return False
        self.instance = None
        return True

    def wait_for_ready(self, **kwargs: Any) -> Optional[ServerInstance]:
        self.wait_calls.append(kwargs)
        return self.ready

    def pid_alive(self, _pid: int) -> bool:
        return self.pid_is_alive


class _Detached:
    def __init__(self, pid: int = 9876) -> None:
        self.pid = pid
        self.specs: list[Any] = []

    def start(self, spec: Any) -> int:
        self.specs.append(spec)
        return self.pid


class _Autostart:
    def __init__(self, *, enabled: bool, owns_process: bool = True) -> None:
        self.owns_process = owns_process
        self.current = SimpleNamespace(
            manager="test-supervisor",
            supported=True,
            enabled=enabled,
            active=enabled,
            detail=None,
            definition=None,
        )
        self.enabled_specs: list[Any] = []
        self.installed_specs: list[Any] = []
        self.deactivated = 0
        self.disabled = 0
        self.uninstalled = 0

    def status(self) -> Any:
        return self.current

    def enable(self, spec: Any) -> Any:
        self.enabled_specs.append(spec)
        return self.current

    def install(self, spec: Any) -> Any:
        self.installed_specs.append(spec)
        self.current = SimpleNamespace(
            manager="test-supervisor",
            supported=True,
            enabled=True,
            active=self.current.active,
            detail=None,
            definition=None,
        )
        return self.current

    def deactivate(self) -> None:
        self.deactivated += 1

    def disable(self) -> Any:
        self.disabled += 1
        self.current = SimpleNamespace(
            manager="test-supervisor",
            supported=True,
            enabled=False,
            active=False,
            detail=None,
            definition=None,
        )
        return self.current

    def uninstall(self) -> Any:
        self.uninstalled += 1
        self.current = SimpleNamespace(
            manager="test-supervisor",
            supported=True,
            enabled=False,
            active=self.current.active,
            detail=None,
            definition=None,
        )
        return self.current


def test_registration_reads_the_legacy_schema(tmp_path: Path) -> None:
    path = tmp_path / "runtime.json"
    path.write_text(
        json.dumps(
            {
                "host": "0.0.0.0",
                "port": 7421,
                "pid": 1234,
                "started_at": "2026-07-28T12:00:00",
            }
        ),
        encoding="utf-8",
    )

    instance = ServerRegistration(path).read()

    assert instance == ServerInstance(
        host="0.0.0.0",
        port=7421,
        pid=1234,
        started_at="2026-07-28T12:00:00",
        token=None,
        lock_file=None,
        ws_path=DEFAULT_WS_PATH,
        version=None,
    )
    assert instance.base_url() == "http://127.0.0.1:7421"


def test_registration_uses_the_native_windows_pid_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probed: list[int] = []

    def unexpected_kill(*_args: Any) -> None:
        raise AssertionError("Windows PID probes must not call os.kill")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(
        ServerRegistration,
        "_pid_alive_windows",
        lambda pid: probed.append(pid) or True,
    )
    monkeypatch.setattr("src.amphi_service.server._manager.os.kill", unexpected_kill)

    assert ServerRegistration.pid_alive(4321) is True
    assert probed == [4321]


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("::", "http://[::1]:7421"),
        ("::1", "http://[::1]:7421"),
        ("2001:db8::1", "http://[2001:db8::1]:7421"),
    ],
)
def test_server_instance_formats_ipv6_urls(host: str, expected: str) -> None:
    instance = _instance()
    instance = ServerInstance(
        host=host,
        port=instance.port,
        pid=instance.pid,
        started_at=instance.started_at,
    )

    assert instance.base_url() == expected


@pytest.mark.parametrize(
    "contents",
    [
        "{not-json",
        json.dumps({"host": "127.0.0.1"}),
        json.dumps({"host": "127.0.0.1", "port": "bad", "pid": 1, "started_at": "now"}),
    ],
)
def test_registration_treats_invalid_json_as_absent(
    tmp_path: Path,
    contents: str,
) -> None:
    path = tmp_path / "runtime.json"
    path.write_text(contents, encoding="utf-8")

    assert ServerRegistration(path).read() is None


def test_registration_write_is_atomic_and_private(tmp_path: Path) -> None:
    path = tmp_path / "runtime" / "runtime.json"
    registration = ServerRegistration(path)
    instance_lock = ServerInstanceLock(path.parent / "gateway.lock")
    instance_lock.acquire()

    try:
        assert instance_lock.owner_pid is not None
        written = registration.write(
            instance_lock=instance_lock,
            host="127.0.0.1",
            port=7421,
            pid=instance_lock.owner_pid,
            started_at="2026-07-28T13:00:00",
            token="secret",
            lock_file=tmp_path / "gateway.lock",
            version="2.0.0",
            log_file=tmp_path / "server.log",
        )
    finally:
        instance_lock.release()

    assert registration.read() == written
    assert written.log_file == str(tmp_path / "server.log")
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(path.parent.glob(".*.tmp")) == []


def test_registration_write_and_clear_require_instance_lock_ownership(
    tmp_path: Path,
) -> None:
    registration = ServerRegistration(tmp_path / "runtime.json")
    instance_lock = ServerInstanceLock(tmp_path / "gateway.lock")

    with pytest.raises(ServerError, match="must be held"):
        registration.write(
            instance_lock=instance_lock,
            host="127.0.0.1",
            port=7421,
            pid=100,
        )
    with pytest.raises(ServerError, match="must be held"):
        registration.clear(_instance(), instance_lock=instance_lock)


def test_registration_write_requires_the_current_lock_owner_pid(
    tmp_path: Path,
) -> None:
    registration = ServerRegistration(tmp_path / "runtime.json")
    instance_lock = ServerInstanceLock(tmp_path / "gateway.lock")
    instance_lock.acquire()
    try:
        assert instance_lock.owner_pid is not None
        with pytest.raises(ServerError, match="does not own"):
            registration.write(
                instance_lock=instance_lock,
                host="127.0.0.1",
                port=7421,
                pid=instance_lock.owner_pid + 1,
            )
    finally:
        instance_lock.release()


def test_registration_clear_compares_the_expected_instance(tmp_path: Path) -> None:
    registration = ServerRegistration(tmp_path / "runtime.json")
    instance_lock = ServerInstanceLock(tmp_path / "gateway.lock")
    instance_lock.acquire()
    try:
        assert instance_lock.owner_pid is not None
        old = registration.write(
            instance_lock=instance_lock,
            host="127.0.0.1",
            port=7421,
            pid=instance_lock.owner_pid,
            started_at="old",
        )
        current = registration.write(
            instance_lock=instance_lock,
            host="127.0.0.1",
            port=7421,
            pid=instance_lock.owner_pid,
            started_at="current",
        )

        assert registration.clear(old, instance_lock=instance_lock) is False
        assert registration.read() == current
        assert registration.clear(current, instance_lock=instance_lock) is True
        assert registration.read() is None
    finally:
        instance_lock.release()


def test_instance_lock_is_not_reentrant_and_preserves_its_file(tmp_path: Path) -> None:
    path = tmp_path / "gateway.lock"
    lock = ServerInstanceLock(path)

    lock.acquire()
    with pytest.raises(ServerInstanceLockHeld, match="already held"):
        lock.acquire()
    lock.release()

    assert lock.held is False
    assert path.exists()


def test_instance_lock_publishes_only_a_stably_held_owner_pid(
    tmp_path: Path,
) -> None:
    path = tmp_path / "gateway.lock"
    lock = ServerInstanceLock(path)

    assert ServerInstanceLock.read_owner(path) is None
    lock.acquire()
    try:
        assert lock.owner_pid == os.getpid()
        assert ServerInstanceLock.read_owner(path) == os.getpid()
    finally:
        lock.release()

    assert ServerInstanceLock.read_owner(path) is None


def test_instance_lock_inspection_preserves_a_legacy_owner(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "gateway.lock"
    path.touch()
    handle = path.open("a+b")
    ServerInstanceLock._lock_handle(handle)
    registration = ServerRegistration(tmp_path / "runtime.json")
    instance = _instance()
    monkeypatch.setattr(registration, "pid_alive", lambda _pid: True)
    monkeypatch.setattr(registration, "_socket_open", lambda _host, _port: True)
    try:
        assert ServerInstanceLock.inspect(path) == ServerLockState(
            locked=True,
            owner_pid=None,
        )
        assert registration.is_alive(instance) is True
    finally:
        ServerInstanceLock._unlock_handle(handle)
        handle.close()


def test_instance_lock_rejects_a_competing_owner(tmp_path: Path) -> None:
    path = tmp_path / "gateway.lock"
    owner = ServerInstanceLock(path)
    competitor = ServerInstanceLock(path)
    owner.acquire()
    try:
        with pytest.raises(ServerInstanceLockHeld, match="Another service process"):
            competitor.acquire()
    finally:
        owner.release()

    competitor.acquire()
    competitor.release()


def test_instance_lock_does_not_write_before_kernel_lock_is_acquired(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    lock = ServerInstanceLock(tmp_path / "gateway.lock")
    writes: list[bool] = []

    def reject_lock(_handle: Any) -> None:
        raise OSError

    monkeypatch.setattr(lock, "_lock_handle", reject_lock)
    monkeypatch.setattr(lock, "_ensure_lock_byte", lambda _handle: writes.append(True))

    with pytest.raises(ServerInstanceLockHeld):
        lock.acquire()

    assert writes == []


def test_manager_cannot_clear_registration_while_a_foreground_owner_holds_lock(
    tmp_path: Path,
) -> None:
    registration = ServerRegistration(tmp_path / "runtime.json")
    owner = ServerInstanceLock(tmp_path / "gateway.lock")
    owner.acquire()
    try:
        assert owner.owner_pid is not None
        instance = registration.write(
            instance_lock=owner,
            host="127.0.0.1",
            port=7421,
            pid=owner.owner_pid,
            started_at="owned",
        )
        manager = ServerManager(registration=registration, platform="linux")

        assert manager._clear_registration(instance) is False
        assert registration.read() == instance
    finally:
        owner.release()


def test_manager_status_has_stopped_running_and_stale_states(tmp_path: Path) -> None:
    registration = _Registration(tmp_path / "runtime.json")
    manager = ServerManager(registration=registration, platform="linux")

    assert manager.status().to_dict() == {
        "status": "stopped",
        "runtime_file": str(registration.path),
    }

    registration.instance = _instance()
    registration.alive = True
    running = manager.status().to_dict()
    assert running["status"] == "running"
    assert running["base_url"] == "http://127.0.0.1:7421"
    assert "token" not in running
    # log_file 字段总是存在：daemon 亲口报告日志位置，None 表示降级/旧版。
    assert running["log_file"] is None

    registration.alive = False
    stale = manager.status().to_dict()
    assert stale["status"] == "stale"
    assert stale["registration"]["pid"] == 1234
    assert "token" not in stale["registration"]


def test_manager_start_is_idempotent_when_an_instance_is_alive(tmp_path: Path) -> None:
    current = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=current,
        alive=True,
    )
    detached = _Detached()
    manager = ServerManager(
        registration=registration,
        detached=detached,
        platform="linux",
    )

    result = manager.start()

    assert result == ServerStartResult(current, False, "existing")
    assert detached.specs == []
    assert registration.wait_calls == []


def test_manager_clears_stale_registration_and_starts_detached(
    tmp_path: Path,
) -> None:
    stale = _instance(pid=111)
    ready = _instance(pid=222)
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=stale,
        alive=False,
        ready=ready,
    )
    detached = _Detached(pid=222)
    manager = ServerManager(
        registration=registration,
        detached=detached,
        platform="linux",
    )
    options = ServerOptions(
        host="127.0.0.1",
        port=7421,
        log_level="debug",
    )

    result = manager.start(options, timeout=4.5)

    assert result == ServerStartResult(ready, True, "detached")
    assert registration.clear_calls == [stale]
    assert len(detached.specs) == 1
    assert registration.wait_calls == [
        {"host": "127.0.0.1", "port": 7421, "timeout": 4.5}
    ]


def test_manager_uses_an_enabled_autostart_owner(tmp_path: Path) -> None:
    ready = _instance(pid=222)
    registration = _Registration(tmp_path / "runtime.json", ready=ready)
    detached = _Detached()
    autostart = _Autostart(enabled=True)
    manager = ServerManager(
        registration=registration,
        detached=detached,
        autostart=autostart,
        platform="darwin",
    )

    result = manager.start(ServerOptions(), timeout=3)

    assert result == ServerStartResult(ready, True, "autostart")
    assert len(autostart.enabled_specs) == 1
    assert detached.specs == []


def test_manager_reports_a_start_timeout_with_pid_and_log(tmp_path: Path) -> None:
    registration = _Registration(tmp_path / "runtime.json")
    detached = _Detached(pid=7654)
    manager = ServerManager(
        registration=registration,
        detached=detached,
        platform="linux",
    )

    with pytest.raises(ServerStartTimeout) as caught:
        manager.start(timeout=0.25)

    assert caught.value.pid == 7654
    assert caught.value.timeout == 0.25
    assert caught.value.log_path == tmp_path / "server.log"


def test_manager_adopts_a_process_that_already_owns_the_startup_lock(
    tmp_path: Path,
) -> None:
    stale = _instance(pid=111)
    ready = _instance(pid=222)
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=stale,
        alive=False,
        ready=ready,
    )
    owner = ServerInstanceLock(tmp_path / "gateway.lock")
    owner.acquire()
    try:
        manager = ServerManager(
            registration=registration,
            detached=_Detached(),
            platform="linux",
        )

        result = manager.start(timeout=1)

        assert result == ServerStartResult(ready, False, "existing")
        assert registration.clear_calls == []
    finally:
        owner.release()


def test_manager_stop_reports_an_unregistered_service(tmp_path: Path) -> None:
    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        platform="linux",
    )

    assert manager.stop() == ServerStopResult("not_registered")


def test_manager_stop_deactivates_an_enabled_owner_without_registration(
    tmp_path: Path,
) -> None:
    autostart = _Autostart(enabled=True)
    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        autostart=autostart,
        platform="win32",
    )

    assert manager.stop() == ServerStopResult("not_registered")
    assert autostart.deactivated == 1


def test_manager_stop_clears_a_stale_registration(tmp_path: Path) -> None:
    stale = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=stale,
        alive=False,
    )
    manager = ServerManager(registration=registration, platform="linux")

    result = manager.stop()

    assert result == ServerStopResult("stale_cleared", stale.pid)
    assert registration.clear_calls == [stale]


def test_manager_stop_never_terminates_a_stale_pid_without_lock_ownership(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    stale = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=stale,
        alive=False,
        pid_alive=True,
    )
    manager = ServerManager(registration=registration, platform="linux")
    terminated: list[tuple[int, bool]] = []
    monkeypatch.setattr(manager, "_wait_for_exit", lambda _pid, _timeout: True)
    monkeypatch.setattr(
        manager,
        "_terminate",
        lambda pid, *, force: terminated.append((pid, force)),
    )

    assert manager.stop(timeout=1) == ServerStopResult("stale_cleared", stale.pid)
    assert terminated == []
    assert registration.clear_calls == [stale]


def test_manager_does_not_clear_or_kill_a_legacy_locked_stale_instance(
    tmp_path: Path,
) -> None:
    path = tmp_path / "gateway.lock"
    path.touch()
    handle = path.open("a+b")
    ServerInstanceLock._lock_handle(handle)
    stale = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=stale,
        alive=False,
    )
    manager = ServerManager(registration=registration, platform="linux")
    try:
        with pytest.raises(ServerError, match="without verifiable owner"):
            manager.stop(timeout=0.1)
    finally:
        ServerInstanceLock._unlock_handle(handle)
        handle.close()

    assert registration.clear_calls == []


def test_manager_reports_registration_clear_failure_instead_of_stale_cleared(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    stale = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=stale,
        alive=False,
    )
    manager = ServerManager(registration=registration, platform="linux")
    monkeypatch.setattr(manager, "_clear_registration", lambda _expected: False)

    with pytest.raises(ServerError, match="Could not clear stopped"):
        manager.stop()


def test_manager_stop_targets_the_verified_owner_instead_of_a_stale_pid(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    stale = _instance(pid=111)
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=stale,
        alive=False,
        pid_alive=True,
    )
    owner = ServerInstanceLock(tmp_path / "gateway.lock")
    owner.acquire()
    assert owner.owner_pid is not None
    manager = ServerManager(registration=registration, platform="linux")
    stopped: list[int] = []

    def stop_process(pid: int, *, timeout: float, force: bool) -> None:
        stopped.append(pid)
        owner.release()

    monkeypatch.setattr(manager, "_stop_process", stop_process)

    try:
        result = manager.stop(timeout=1)
    finally:
        owner.release()

    assert result == ServerStopResult("stopped", os.getpid())
    assert stopped == [os.getpid()]
    assert registration.clear_calls == [stale]


def test_manager_stop_targets_a_starting_owner_without_registration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    registration = _Registration(tmp_path / "runtime.json")
    owner = ServerInstanceLock(tmp_path / "gateway.lock")
    owner.acquire()
    assert owner.owner_pid is not None
    manager = ServerManager(registration=registration, platform="linux")
    stopped: list[int] = []

    def stop_process(pid: int, *, timeout: float, force: bool) -> None:
        stopped.append(pid)
        owner.release()

    monkeypatch.setattr(manager, "_stop_process", stop_process)

    try:
        result = manager.stop(timeout=1)
    finally:
        owner.release()

    assert result == ServerStopResult("stopped", os.getpid())
    assert stopped == [os.getpid()]


def test_manager_stop_prefers_the_authenticated_shutdown(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    running = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=running,
        alive=True,
    )
    manager = ServerManager(registration=registration, platform="linux")
    terminated: list[tuple[int, bool]] = []
    monkeypatch.setattr(manager, "_request_graceful_shutdown", lambda _instance: True)
    monkeypatch.setattr(manager, "_wait_for_exit", lambda _pid, _timeout: True)
    monkeypatch.setattr(
        manager,
        "_terminate",
        lambda pid, *, force: terminated.append((pid, force)),
    )

    result = manager.stop(timeout=1)

    assert result == ServerStopResult("stopped", running.pid)
    assert terminated == []
    assert registration.clear_calls == [running]


def test_manager_stop_deactivates_autostart_on_the_graceful_path_too(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A clean stop must deactivate the supervisor, like every other branch.

    Regression: only the failure branches deactivated, so a *successful* stop
    left the launchd job loaded. `RunAtLoad` then brought the daemon back at the
    next login, and `autostart status` kept reporting active=True (it reports
    job-loaded, not process-alive) while nothing was running — i.e. "stop" meant
    something different depending on whether the graceful shutdown worked.
    """
    running = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=running,
        alive=True,
    )
    autostart = _Autostart(enabled=True)
    manager = ServerManager(
        registration=registration,
        autostart=autostart,
        platform="darwin",
    )
    monkeypatch.setattr(manager, "_request_graceful_shutdown", lambda _instance: True)
    monkeypatch.setattr(manager, "_wait_for_exit", lambda _pid, _timeout: True)

    assert manager.stop(timeout=1) == ServerStopResult("stopped", running.pid)
    assert autostart.deactivated == 1


def test_manager_does_not_claim_success_when_forced_termination_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    running = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=running,
        alive=True,
    )
    manager = ServerManager(registration=registration, platform="linux")
    terminated: list[tuple[int, bool]] = []
    monkeypatch.setattr(manager, "_request_graceful_shutdown", lambda _instance: False)
    monkeypatch.setattr(manager, "_wait_for_exit", lambda _pid, _timeout: False)
    lock_states = iter(
        [
            ServerLockState(locked=True, owner_pid=running.pid),
            ServerLockState(locked=True, owner_pid=running.pid),
            ServerLockState(locked=True, owner_pid=running.pid),
        ]
    )
    monkeypatch.setattr(manager, "_instance_lock_state", lambda: next(lock_states))
    monkeypatch.setattr(
        manager,
        "_terminate",
        lambda pid, *, force: terminated.append((pid, force)) or True,
    )

    with pytest.raises(ServerError, match="did not exit"):
        manager.stop(timeout=0.1)

    assert terminated == [(running.pid, False), (running.pid, True)]
    assert registration.clear_calls == []


def test_manager_does_not_hide_supervisor_status_failures(tmp_path: Path) -> None:
    class BrokenAutostart(_Autostart):
        def status(self) -> Any:
            raise SupervisorError("autostart unavailable")

    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        autostart=BrokenAutostart(enabled=True),
        platform="win32",
    )

    with pytest.raises(SupervisorError, match="unavailable"):
        manager.stop()


def test_manager_uses_taskkill_for_the_windows_hard_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[list[str], dict[str, Any]]] = []

    def run(arguments: list[str], **options: Any) -> Any:
        calls.append((arguments, options))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        platform="win32",
    )
    monkeypatch.setattr("src.amphi_service.server._manager.subprocess.run", run)
    monkeypatch.setattr(manager, "_instance_owner_pid", lambda: 4321)

    assert manager._terminate(4321, force=False) is True

    assert calls == [
        (
            ["taskkill.exe", "/PID", "4321", "/T", "/F"],
            {
                "check": False,
                "capture_output": True,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
                "timeout": ServerManager.PROCESS_COMMAND_TIMEOUT,
                "creationflags": 0x08000000,
            },
        )
    ]


def test_manager_tolerates_taskkill_racing_an_exiting_process_tree(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A tree that dies while taskkill sweeps it is a success, not an error.

    ``taskkill /T`` exits non-zero when any enumerated child is already gone,
    and ``TerminateProcess`` is asynchronous, so the service pid can still
    report alive for a moment after a kill that in fact landed. Both showed
    up together in the CI smoke: the daemon was mid venv build, a grandchild
    exited during the sweep, and a clean stop was reported as a failure.
    """
    registration = _Registration(tmp_path / "runtime.json", pid_alive=True)
    manager = ServerManager(registration=registration, platform="win32")
    monkeypatch.setattr(manager, "_instance_owner_pid", lambda: 4321)
    monkeypatch.setattr(
        "src.amphi_service.server._manager.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1,
            stdout="",
            stderr=(
                "ERROR: The process with PID 3328 (child process of PID 424) "
                "could not be terminated.\nReason: There is no running instance "
                "of the task."
            ),
        ),
    )
    # The pid reads alive on the first poll and gone on the next, the way an
    # asynchronously terminating process does.
    alive_answers = iter([True, False])
    monkeypatch.setattr(
        registration, "pid_alive", lambda _pid: next(alive_answers, False)
    )

    assert manager._terminate(4321, force=True) is True


def test_manager_still_reports_a_tree_taskkill_could_not_kill(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A pid that survives taskkill past the grace window stays an error."""
    registration = _Registration(tmp_path / "runtime.json", pid_alive=True)
    manager = ServerManager(registration=registration, platform="win32")
    monkeypatch.setattr(manager, "STOP_POLL_INTERVAL", 0.01)
    monkeypatch.setattr(manager, "TERMINATE_VERIFY_TIMEOUT", 0.05)
    monkeypatch.setattr(manager, "_instance_owner_pid", lambda: 4321)
    monkeypatch.setattr(
        "src.amphi_service.server._manager.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1, stdout="", stderr="ERROR: Access is denied."
        ),
    )

    with pytest.raises(ServerError, match="Could not terminate service pid 4321"):
        manager._terminate(4321, force=True)


def test_manager_refuses_raw_termination_without_verified_lock_ownership(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[int, int]] = []
    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        platform="linux",
    )
    monkeypatch.setattr(manager, "_instance_owner_pid", lambda: None)
    monkeypatch.setattr(
        "src.amphi_service.server._manager.os.kill",
        lambda pid, sig: calls.append((pid, sig)),
    )

    assert manager._terminate(4321, force=True) is False
    assert calls == []


def test_manager_force_stop_skips_http_and_kills_the_process(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    running = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=running,
        alive=True,
    )
    manager = ServerManager(registration=registration, platform="linux")
    terminated: list[tuple[int, bool]] = []

    def unexpected_shutdown(_instance: ServerInstance) -> bool:
        raise AssertionError("force stop must not make an HTTP shutdown request")

    monkeypatch.setattr(manager, "_request_graceful_shutdown", unexpected_shutdown)
    monkeypatch.setattr(manager, "_wait_for_exit", lambda _pid, _timeout: True)
    lock_states = iter(
        [
            ServerLockState(locked=True, owner_pid=running.pid),
            ServerLockState(locked=True, owner_pid=running.pid),
            ServerLockState(locked=False),
        ]
    )
    monkeypatch.setattr(manager, "_instance_lock_state", lambda: next(lock_states))
    monkeypatch.setattr(
        manager,
        "_terminate",
        lambda pid, *, force: terminated.append((pid, force)) or True,
    )

    result = manager.stop(timeout=1, force=True)

    assert result == ServerStopResult("stopped", running.pid)
    assert terminated == [(running.pid, True)]


def test_manager_restart_stops_before_starting(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        platform="linux",
    )
    ready = _instance()
    calls: list[tuple[str, Any]] = []

    def fake_stop(*, timeout: float, force: bool) -> ServerStopResult:
        calls.append(("stop", (timeout, force)))
        return ServerStopResult("stopped", 1234)

    def fake_start(options: ServerOptions, *, timeout: float) -> ServerStartResult:
        calls.append(("start", (options, timeout)))
        return ServerStartResult(ready, True, "detached")

    monkeypatch.setattr(manager, "_stop_locked", fake_stop)
    monkeypatch.setattr(manager, "_start_locked", fake_start)
    options = ServerOptions(port=8000)

    result = manager.restart(
        options,
        start_timeout=5,
        stop_timeout=2,
        force=True,
    )

    assert result.instance == ready
    assert calls == [
        ("stop", (2, True)),
        ("start", (options, 5)),
    ]


def test_control_lock_serializes_start_and_stop_across_managers(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "runtime.json"
    first = ServerManager(registration=_Registration(path), platform="linux")
    second = ServerManager(registration=_Registration(path), platform="linux")
    start_entered = threading.Event()
    release_start = threading.Event()
    stop_entered = threading.Event()
    errors: list[BaseException] = []

    def start_locked(_options: ServerOptions, *, timeout: float) -> ServerStartResult:
        start_entered.set()
        assert release_start.wait(2)
        return ServerStartResult(_instance(), True, "detached")

    def stop_locked(*, timeout: float, force: bool) -> ServerStopResult:
        stop_entered.set()
        return ServerStopResult("stopped", 1234)

    monkeypatch.setattr(first, "_start_locked", start_locked)
    monkeypatch.setattr(second, "_stop_locked", stop_locked)

    def run(operation: Any) -> None:
        try:
            operation()
        except BaseException as exc:  # noqa: BLE001 - surfaced in the test thread
            errors.append(exc)

    start_thread = threading.Thread(target=run, args=(first.start,))
    stop_thread = threading.Thread(target=run, args=(second.stop,))
    start_thread.start()
    assert start_entered.wait(1)
    stop_thread.start()
    assert not stop_entered.wait(0.1)
    release_start.set()
    start_thread.join(2)
    stop_thread.join(2)

    assert not start_thread.is_alive()
    assert not stop_thread.is_alive()
    assert stop_entered.is_set()
    assert errors == []


def test_control_lock_wait_is_bounded_by_the_command_timeout(
    tmp_path: Path,
) -> None:
    registration = _Registration(tmp_path / "runtime.json")
    manager = ServerManager(registration=registration, platform="linux")
    owner = ServerInstanceLock(manager.control_lock_path)
    owner.acquire()
    try:
        with pytest.raises(ServerError, match="Timed out waiting"):
            manager.stop(timeout=0.01)
    finally:
        owner.release()


def test_manager_enable_autostart_transfers_a_running_instance(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    running = _instance()
    ready = _instance(pid=5678)
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=running,
        alive=True,
        ready=ready,
    )
    supervisor = _Autostart(enabled=False)
    manager = ServerManager(
        registration=registration,
        autostart=supervisor,
        platform="darwin",
    )
    stops: list[float] = []

    def stop(*, timeout: float, force: bool = False) -> ServerStopResult:
        stops.append(timeout)
        registration.instance = None
        registration.alive = False
        return ServerStopResult("stopped", running.pid)

    monkeypatch.setattr(manager, "_stop_locked", stop)
    options = ServerOptions()

    result = manager.enable_autostart(options, timeout=4)

    assert stops == [ServerManager.DEFAULT_STOP_TIMEOUT]
    assert len(supervisor.enabled_specs) == 1
    assert result.instance == ready
    assert registration.wait_calls == [
        {"host": "127.0.0.1", "port": 7421, "timeout": 4}
    ]


def test_manager_enable_trigger_only_autostart_uses_a_detached_daemon(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ready = _instance(pid=5678)
    registration = _Registration(
        tmp_path / "runtime.json",
        ready=ready,
    )
    supervisor = _Autostart(enabled=False, owns_process=False)
    detached = _Detached()
    manager = ServerManager(
        registration=registration,
        autostart=supervisor,
        detached=detached,
        platform="win32",
    )
    monkeypatch.setattr(
        manager,
        "_stop_locked",
        lambda **_kwargs: ServerStopResult("not_registered"),
    )

    result = manager.enable_autostart(ServerOptions(), timeout=4)

    assert result.instance == ready
    assert supervisor.enabled_specs[0].arguments[2:4] == ("server", "start")
    assert detached.specs[0].arguments[2:4] == ("server", "serve")


def test_manager_disable_autostart_stops_before_removing_definition(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    running = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=running,
        alive=True,
    )
    supervisor = _Autostart(enabled=True)
    manager = ServerManager(
        registration=registration,
        autostart=supervisor,
        platform="darwin",
    )
    stops: list[float] = []

    def stop(*, timeout: float, force: bool = False) -> ServerStopResult:
        stops.append(timeout)
        registration.instance = None
        registration.alive = False
        return ServerStopResult("stopped", running.pid)

    monkeypatch.setattr(manager, "_stop_locked", stop)

    result = manager.disable_autostart(timeout=3)

    assert stops == [3]
    assert supervisor.disabled == 1
    assert result.status.enabled is False


def test_manager_configures_autostart_without_touching_a_running_service(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    running = _instance()
    registration = _Registration(
        tmp_path / "runtime.json",
        instance=running,
        alive=True,
    )
    supervisor = _Autostart(enabled=False, owns_process=False)
    detached = _Detached()
    manager = ServerManager(
        registration=registration,
        autostart=supervisor,
        detached=detached,
        platform="win32",
    )
    monkeypatch.setattr(
        manager,
        "_stop_locked",
        lambda **_kwargs: pytest.fail("configure-only must not stop the service"),
    )

    enabled = manager.configure_autostart(True, ServerOptions(port=8123), timeout=3)
    disabled = manager.configure_autostart(False, timeout=3)

    assert enabled.status.enabled is True
    assert disabled.status.enabled is False
    assert enabled.instance is None
    assert disabled.instance is None
    assert registration.instance is running
    assert registration.alive is True
    assert registration.clear_calls == []
    assert registration.wait_calls == []
    assert detached.specs == []
    assert len(supervisor.installed_specs) == 1
    assert supervisor.installed_specs[0].arguments[-4:-2] == ("--port", "8123")
    assert supervisor.uninstalled == 1


def test_manager_reports_unsupported_autostart_without_importing_a_runtime(
    tmp_path: Path,
) -> None:
    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        platform="linux",
    )

    status = manager.autostart_status()

    assert status.supported is False
    assert status.enabled is False
    assert status.manager == "none"


@pytest.mark.parametrize(
    ("platform", "class_name"),
    [
        ("darwin", "LaunchdSupervisor"),
        ("win32", "RunKeySupervisor"),
    ],
)
def test_manager_selects_the_native_autostart_supervisor(
    tmp_path: Path,
    platform: str,
    class_name: str,
) -> None:
    manager = ServerManager(
        registration=_Registration(tmp_path / "runtime.json"),
        platform=platform,
    )

    supervisor = manager._optional_autostart_supervisor()

    assert supervisor is not None
    assert type(supervisor).__name__ == class_name
    assert supervisor.platform == platform
    assert manager.command.platform == platform
