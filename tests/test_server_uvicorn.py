from __future__ import annotations

import logging
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
        path = tmp_path / "runtime.json"

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
    monkeypatch.setattr(
        uvicorn_module,
        "configure_daemon_logging",
        # 返回真值模拟 handler 创建成功：随后 write 必须回报同一个日志路径。
        lambda log_path, **options: (events.append(("logging", log_path, options)), object())[1],
    )

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
    # 加锁之后、应用构造之前就要接好文件日志——应用构造期间已有日志输出。
    assert events[1] == (
        "logging",
        tmp_path / "server.log",
        {"log_level": "debug"},
    )
    assert events[2] == (
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
        "log_file": tmp_path / "server.log",
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
    caplog: pytest.LogCaptureFixture,
) -> None:
    def fail() -> None:
        raise RuntimeError("hook broke")

    # 走 logging（不再是 print 到 stderr）：supervisor 把裸 stderr 重定向到
    # 崩溃兜底文件，而那不是 GUI「打开日志」会打开的那个文件。
    with caplog.at_level(logging.WARNING, logger=uvicorn_module.logger.name):
        await GracefulServer._run_hook(fail, swallow=True)
    assert "hook broke" in caplog.text

    with pytest.raises(RuntimeError, match="hook broke"):
        await GracefulServer._run_hook(fail, swallow=False)


def test_reload_worker_inherits_the_requested_log_level(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """--log-level debug 必须传到 reload worker 的应用 logger 上。

    uvicorn 只会把它交给自己那三个 uvicorn* logger;worker 是另起的进程,
    拿不到父进程的参数。此前 create_reload_app 无参调用,把 APP_LOGGER_NAMES
    钉死在 INFO——开发者唯一会主动要 DEBUG 的模式反而看不到 DEBUG。
    """
    applied: list[str] = []

    class Unused:
        def acquire(self) -> None:
            raise AssertionError("reload must not acquire the daemon lock")

    # setenv(而不是 delenv):monkeypatch 记下原值,teardown 时才会把
    # 生产代码写进去的那个值清掉,不然它会漏给后面的测试。
    monkeypatch.setenv(uvicorn_module.RELOAD_LOG_LEVEL_ENV, "info")
    monkeypatch.setattr(uvicorn_module.uvicorn, "run", lambda *args, **kwargs: None)
    UvicornRunner(registration=Unused(), instance_lock=Unused()).run(
        ServerOptions(host="0.0.0.0", port=9000, log_level="debug", reload=True)
    )

    monkeypatch.setattr(
        uvicorn_module,
        "configure_console_logging",
        lambda **kwargs: applied.append(kwargs.get("log_level", "info")),
    )
    monkeypatch.setattr(
        app_module,
        "ServiceApp",
        lambda **_kwargs: SimpleNamespace(app=object()),
    )

    uvicorn_module.create_reload_app()

    assert applied == ["debug"]


def test_managed_daemon_does_not_write_access_logs_into_server_log(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """log_config=None 会让 uvicorn.access 冒泡到 root 的文件 handler。

    默认 dictConfig 给它单独的 handler + propagate=False,所以它从来没进过
    应用日志;现在它会和应用诊断抢同一份 5MB × 2 的轮转预算。
    """
    captured: dict[str, Any] = {}

    class _Config:
        def __init__(self, _app: Any, **kwargs: Any) -> None:
            captured.update(kwargs)

    class _Server:
        def __init__(self, config: Any, **_kwargs: Any) -> None:
            self.config = config

        def run(self) -> None:
            return None

    monkeypatch.setattr(uvicorn_module.uvicorn, "Config", _Config)
    monkeypatch.setattr(uvicorn_module, "GracefulServer", _Server)
    monkeypatch.setattr(
        app_module,
        "ServiceApp",
        lambda **_kwargs: SimpleNamespace(
            app=object(),
            state=SimpleNamespace(
                gateway=SimpleNamespace(
                    started_at=0.0, ws_path="/ws", version="0",
                ),
                auth=SimpleNamespace(current_token="t"),
            ),
            pre_shutdown_hook=None,
            bind_shutdown=lambda _cb: None,
        ),
    )

    registration = SimpleNamespace(
        path=tmp_path / "runtime.json",
        write=lambda **_kwargs: None,
        clear=lambda *_args, **_kwargs: None,
    )
    lock = SimpleNamespace(
        acquire=lambda: None,
        release=lambda: None,
        path=tmp_path / "lock",
    )
    # 上一次启动留下的崩溃输出:run() 应在 server.log 里留面包屑指向它。
    crash_net = tmp_path / "daemon.stderr.log"
    crash_net.write_bytes(b"Traceback (most recent call last):\n")

    # configure_daemon_logging 在本测试里是真调用,会给 root 挂真 handler;
    # 不摘掉会把指向 tmp_path 的 file handler 泄漏给会话里之后的所有测试。
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    try:
        UvicornRunner(registration=registration, instance_lock=lock).run(
            ServerOptions(host="127.0.0.1", port=9000, log_level="info", reload=False)
        )

        assert captured["log_config"] is None
        assert captured["access_log"] is False

        # 启动横幅 + crash-net 面包屑都落在 server.log 里(wiring 验证)。
        content = (tmp_path / "server.log").read_text(encoding="utf-8")
        assert "[daemon-logging] started pid=" in content
        assert f"crash net {crash_net} holds {crash_net.stat().st_size} bytes" in content
    finally:
        for handler in list(root.handlers):
            if handler not in saved_handlers:
                root.removeHandler(handler)
                handler.close()
        root.setLevel(saved_level)
