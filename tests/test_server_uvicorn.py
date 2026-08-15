from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import src.amphi_service._app as app_module
import src.amphi_service.server._uvicorn as uvicorn_module
from src.amphi_service.server._manager import ServerInstance, ServerOptions
from src.amphi_service.server._uvicorn import GracefulServer, UvicornRunner


def test_uvicorn_runner_owns_lock_registration_and_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[Any] = []
    written = ServerInstance(
        host="127.0.0.1",
        port=8123,
        pid=1234,
        started_at="2026-07-28T12:00:00",
    )

    class Registration:
        def write(self, *, instance_lock: Any, **values: Any) -> ServerInstance:
            assert instance_lock.held
            events.append(("write", values))
            return written

        def clear(self, expected: ServerInstance, *, instance_lock: Any) -> bool:
            assert instance_lock.held
            events.append(("clear", expected))
            return True

    class InstanceLock:
        path = tmp_path / "gateway.lock"
        held = False

        def acquire(self) -> None:
            self.held = True
            events.append("lock")

        def release(self) -> None:
            events.append("unlock")
            self.held = False

    class Service:
        def __init__(self, **values: Any) -> None:
            events.append(("service", values))
            self.app = object()
            self.state = SimpleNamespace(
                gateway=SimpleNamespace(
                    started_at="2026-07-28T12:00:00",
                    ws_path="/ws",
                    version="1.2.3",
                ),
                auth=SimpleNamespace(current_token="private-token"),
            )

        async def pre_shutdown_hook(self) -> None:
            events.append("pre_shutdown")

        def bind_shutdown(self, callback: Any) -> None:
            events.append(("bind_shutdown", callback))

    class Server:
        def __init__(self, _config: Any, **hooks: Any) -> None:
            events.append("server")
            self.hooks = hooks

        def run(self) -> None:
            events.append("run")
            self.hooks["post_startup"]()
            callback = next(
                event[1]
                for event in events
                if isinstance(event, tuple) and event[0] == "bind_shutdown"
            )
            callback()
            events.append(("should_exit", self.should_exit))

    monkeypatch.setattr(app_module, "ServiceApp", Service)
    monkeypatch.setattr(uvicorn_module.uvicorn, "Config", lambda *args, **kwargs: (args, kwargs))
    monkeypatch.setattr(uvicorn_module, "GracefulServer", Server)
    monkeypatch.setattr(uvicorn_module.os, "getpid", lambda: 1234)

    UvicornRunner(
        registration=Registration(),
        instance_lock=InstanceLock(),
    ).run(
        ServerOptions(
            host="127.0.0.1",
            port=8123,
            log_level="debug",
        )
    )

    assert events[0] == "lock"
    assert events[1] == (
        "service",
        {
            "bind_host": "127.0.0.1",
            "bind_port": 8123,
        },
    )
    write = next(event for event in events if isinstance(event, tuple) and event[0] == "write")
    assert write[1] == {
        "host": "127.0.0.1",
        "port": 8123,
        "pid": 1234,
        "started_at": "2026-07-28T12:00:00",
        "token": "private-token",
        "lock_file": tmp_path / "gateway.lock",
        "ws_path": "/ws",
        "version": "1.2.3",
    }
    assert any(
        isinstance(event, tuple) and event[0] == "bind_shutdown"
        for event in events
    )
    assert ("should_exit", True) in events
    assert events[-2:] == [("clear", written), "unlock"]


def test_uvicorn_reload_is_explicitly_unmanaged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    class Unused:
        def acquire(self) -> None:
            raise AssertionError("reload must not acquire the daemon lock")

    monkeypatch.setattr(
        uvicorn_module.uvicorn,
        "run",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    UvicornRunner(registration=Unused(), instance_lock=Unused()).run(
        ServerOptions(host="0.0.0.0", port=9000, log_level="debug", reload=True)
    )

    assert calls == [
        (
            ("src.amphi_service.server._uvicorn:create_reload_app",),
            {
                "factory": True,
                "host": "0.0.0.0",
                "port": 9000,
                "log_level": "debug",
                "log_config": uvicorn_module.log_config(),
                "reload": True,
            },
        )
    ]


@pytest.mark.asyncio
async def test_lifecycle_hook_failure_is_only_swallowed_during_shutdown(
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail() -> None:
        raise RuntimeError("hook broke")

    await GracefulServer._run_hook(fail, swallow=True)
    assert "hook broke" in capsys.readouterr().err

    with pytest.raises(RuntimeError, match="hook broke"):
        await GracefulServer._run_hook(fail, swallow=False)
