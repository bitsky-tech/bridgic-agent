"""configure_daemon_logging 的行为契约。

这些测试守住三条底线：
1. 业务 logger（logging.getLogger(__name__) 风格）的记录必须落进 server.log，
   带时间戳/级别/logger 名——修复此前 root 无 handler、INFO 全丢、
   ERROR 走 lastResort 的裸输出。
2. 日志文件自身可轮转，且轮转只由 handler 持有文件（崩溃兜底另有文件）。
3. 日志系统建不起来时降级续跑，绝不让 daemon 因自身诊断设施而起不来。
"""

from __future__ import annotations

import io
import logging
import os
from pathlib import Path
from typing import Iterator

import pytest

import src.amphi_service.server._logging as logging_module
from src.amphi_service.server._logging import (
    APP_LOGGER_NAMES,
    configure_console_logging,
    configure_daemon_logging,
    log_crash_net_size,
)


class _TtyStderr(io.StringIO):
    def isatty(self) -> bool:  # noqa: D102 - trivial test double
        return True


@pytest.fixture(autouse=True)
def _restore_root_logger() -> Iterator[None]:
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    saved_disable = logging.root.manager.disable
    # _apply_levels 改的是进程级的 logger 对象，root 之外还有这四个。不还原
    # 的话，本模块里最后跑的那个用例（DEBUG 或 WARNING）会决定整个会话剩下
    # 部分的应用 logger 级别——随机顺序下就是别处 caplog 用例的偶发失败。
    saved_app_levels = {name: logging.getLogger(name).level for name in APP_LOGGER_NAMES}
    logging.disable(logging.NOTSET)
    yield
    for handler in list(root.handlers):
        if handler not in saved_handlers:
            root.removeHandler(handler)
            handler.close()
    root.setLevel(saved_level)
    for name, level in saved_app_levels.items():
        logging.getLogger(name).setLevel(level)
    logging.disable(saved_disable)


def test_named_logger_records_reach_the_file_with_full_context(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / "server.log"
    handler = configure_daemon_logging(log_path, stderr=io.StringIO())
    assert handler is not None

    # 探针用全新 logger 名：真实名字（amphi_agent.* / uvicorn.*）可能被套件里
    # 其他测试的 dictConfig 留下 propagate=False 或 disabled 状态。daemon 进程
    # 里它们是干净的（我们传 log_config=None，uvicorn 不做 dictConfig）。
    logging.getLogger("probe.module.logger").info("会话 %s 已建立", "s1")
    logging.getLogger("probe.uvicorn.logger").warning("uvicorn 侧告警")
    handler.flush()

    content = log_path.read_text(encoding="utf-8")
    assert "INFO probe.module.logger 会话 s1 已建立" in content
    assert "WARNING probe.uvicorn.logger uvicorn 侧告警" in content
    # 每行都有时间戳前缀（形如 2026-08-18 10:00:00,123）。
    for line in content.strip().splitlines():
        assert line[:4].isdigit(), line


def test_info_level_is_the_default_and_debug_opts_in(tmp_path: Path) -> None:
    handler = configure_daemon_logging(
        tmp_path / "server.log", stderr=io.StringIO()
    )
    assert handler is not None
    root = logging.getLogger()
    assert root.level == logging.INFO

    handler_debug = configure_daemon_logging(
        tmp_path / "server2.log", log_level="trace", stderr=io.StringIO()
    )
    assert handler_debug is not None
    # --log-level 是 uvicorn 的选项，只能作用到应用自己的 logger：root 跟着降到
    # DEBUG 会把 httpx / LLM SDK 的请求详情（含 body）写进用户会打开的文件，
    # 几分钟就冲掉轮转预算。
    assert root.level == logging.INFO
    for name in APP_LOGGER_NAMES:
        assert logging.getLogger(name).level == logging.DEBUG
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.INFO


def test_app_logger_names_cover_this_repo_s_actual_module_names() -> None:
    # packages = ["src"]，所以运行时模块名带 src. 前缀。这条断言让打包方式
    # 一旦变化就立刻失败，而不是悄悄让 --log-level 失效。
    assert any(
        logging_module.__name__.startswith(f"{name}.") or logging_module.__name__ == name
        for name in APP_LOGGER_NAMES
    ), logging_module.__name__


def test_higher_log_levels_apply_to_root_too(tmp_path: Path) -> None:
    handler = configure_daemon_logging(
        tmp_path / "server.log", log_level="warning", stderr=io.StringIO()
    )
    assert handler is not None
    assert logging.getLogger().level == logging.WARNING


def test_rotation_produces_backups_instead_of_unbounded_growth(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / "server.log"
    handler = configure_daemon_logging(
        log_path,
        stderr=io.StringIO(),
        max_bytes=512,
        backup_count=2,
    )
    assert handler is not None

    logger = logging.getLogger("rotation.probe")
    for index in range(64):
        logger.info("填充轮转的行 %04d %s", index, "x" * 64)
    handler.flush()

    assert log_path.exists()
    assert (tmp_path / "server.log.1").exists()
    assert log_path.stat().st_size <= 1024


def test_unwritable_log_path_degrades_to_console_instead_of_silence(
    tmp_path: Path,
) -> None:
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("occupied", encoding="utf-8")
    stderr = io.StringIO()

    handler = configure_daemon_logging(blocker / "server.log", stderr=stderr)

    assert handler is None
    assert "falling back to console logging" in stderr.getvalue()
    # 关键：调用方给 uvicorn 传的是 log_config=None，root 没 handler 就等于
    # 整个进程（含 uvicorn 自己的启动横幅）彻底失声。
    logging.getLogger("probe.degraded").info("仍然要看得到")
    assert "仍然要看得到" in stderr.getvalue()
    assert logging.getLogger("uvicorn.error").hasHandlers()


def test_console_only_configuration_serves_the_reload_worker(tmp_path: Path) -> None:
    stderr = io.StringIO()

    configure_console_logging(stderr=stderr)

    logging.getLogger("probe.reload").info("dev reload 也要有日志")
    assert "dev reload 也要有日志" in stderr.getvalue()
    # reload worker 由 uvicorn 另起进程，绝不能共享 daemon 的轮转文件。
    assert not list(tmp_path.iterdir())


def test_console_handler_only_when_stderr_is_a_tty(tmp_path: Path) -> None:
    root = logging.getLogger()
    before = len(root.handlers)

    handler = configure_daemon_logging(
        tmp_path / "server.log", stderr=io.StringIO()
    )
    assert handler is not None
    # 非 TTY（被 supervisor 重定向）：只有文件 handler，避免兜底文件双写。
    assert len(root.handlers) == before + 1

    tty = _TtyStderr()
    handler_tty = configure_daemon_logging(tmp_path / "server2.log", stderr=tty)
    assert handler_tty is not None
    # TTY（开发者前台 serve）：文件 + 终端各一份。
    assert len(root.handlers) == before + 3

    logging.getLogger("console.probe").error("终端也要看得到")
    assert "终端也要看得到" in tty.getvalue()


def test_startup_banner_marks_each_daemon_session(tmp_path: Path) -> None:
    # server.log 5MB×2 轮转,一个文件里混着多次重启;没有分界线就无法回答
    # "从哪行开始是升级后的版本"。横幅是每次会话在文件里的硬分界。
    from src import __version__

    log_path = tmp_path / "server.log"
    handler = configure_daemon_logging(log_path, stderr=io.StringIO())
    assert handler is not None

    content = log_path.read_text(encoding="utf-8")
    assert "[daemon-logging] started" in content
    assert f"pid={os.getpid()}" in content
    assert f"version={__version__}" in content
    assert "log_level=info" in content


def test_crash_net_note_points_at_preexisting_crash_output(tmp_path: Path) -> None:
    # 场景:launchd KeepAlive 崩溃循环后的下一次成功启动。traceback 在
    # daemon.stderr.log 里,而排查者正盯着 server.log —— 这行面包屑把人引过去。
    log_path = tmp_path / "server.log"
    crash_net = tmp_path / "daemon.stderr.log"
    crash_net.write_bytes(b"Traceback (most recent call last):\n" * 3)
    handler = configure_daemon_logging(log_path, stderr=io.StringIO())
    assert handler is not None

    log_crash_net_size(crash_net)

    content = log_path.read_text(encoding="utf-8")
    assert "crash net" in content
    assert str(crash_net) in content
    assert str(crash_net.stat().st_size) in content


def test_crash_net_note_stays_silent_when_there_is_nothing_to_read(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / "server.log"
    handler = configure_daemon_logging(log_path, stderr=io.StringIO())
    assert handler is not None
    banner_only = log_path.read_text(encoding="utf-8")

    log_crash_net_size(tmp_path / "missing.log")
    empty = tmp_path / "empty.log"
    empty.write_bytes(b"")
    log_crash_net_size(empty)

    assert log_path.read_text(encoding="utf-8") == banner_only


def _blocked(log_path: Path) -> None:
    # 让 RotatingFileHandler 打不开:路径上是个目录 → OSError(IsADirectoryError)。
    log_path.mkdir()


def test_degraded_configure_installs_the_self_healing_fallback(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / "server.log"
    _blocked(log_path)

    handler = configure_daemon_logging(log_path, stderr=io.StringIO())

    assert handler is None
    fallbacks = [
        h
        for h in logging.getLogger().handlers
        if isinstance(h, logging_module._SelfHealingConsoleHandler)
    ]
    assert len(fallbacks) == 1


def test_degraded_logging_recovers_when_the_path_becomes_writable(
    tmp_path: Path,
) -> None:
    """降级的常见诱因(磁盘满/目录被临时锁)是暂时的;此前一旦降级就永远
    把全部日志写进无轮转的 crash net,直到下次重启。现在按 emit 限频重试,
    路径恢复可写后自动切回 server.log。"""
    log_path = tmp_path / "server.log"
    _blocked(log_path)
    console = io.StringIO()
    now = {"t": 0.0}

    fallback = logging_module._SelfHealingConsoleHandler(
        console,
        log_path=log_path,
        formatter=logging.Formatter(logging_module.LOG_FORMAT),
        max_bytes=logging_module.LOG_MAX_BYTES,
        backup_count=logging_module.LOG_BACKUP_COUNT,
        retry_seconds=300.0,
        monotonic=lambda: now["t"],
    )
    root = logging.getLogger()
    root.addHandler(fallback)
    root.setLevel(logging.INFO)
    probe = logging.getLogger("probe.selfheal")

    # 阶段 1:路径仍不可写,重试窗口已到 → 尝试失败,继续走 console。
    now["t"] = 301.0
    probe.info("degraded-1")
    assert "degraded-1" in console.getvalue()
    assert not (tmp_path / "server.log").is_file()

    # 阶段 2:路径恢复可写,但还在限频窗口内 → 不重试,仍走 console。
    log_path.rmdir()
    probe.info("degraded-2")
    assert "degraded-2" in console.getvalue()
    assert not log_path.is_file()

    # 阶段 3:窗口过后第一条记录触发接管:本条起进文件,console 不再增长。
    now["t"] = 602.0
    probe.info("recovered-1")
    console_after_heal = console.getvalue()
    content = log_path.read_text(encoding="utf-8")
    assert "recovered-1" in content
    assert "[daemon-logging] recovered" in content
    assert "recovered-1" not in console_after_heal

    probe.info("recovered-2")
    assert "recovered-2" in log_path.read_text(encoding="utf-8")
    assert console.getvalue() == console_after_heal


def test_degraded_recovery_keeps_a_tty_console(tmp_path: Path) -> None:
    # 开发终端里降级后恢复:成功路径本来就是 file + TTY console 双写,
    # 恢复后的拓扑必须一致 —— 终端不能突然安静下来。
    log_path = tmp_path / "server.log"
    _blocked(log_path)
    console = _TtyStderr()
    now = {"t": 0.0}

    fallback = logging_module._SelfHealingConsoleHandler(
        console,
        log_path=log_path,
        formatter=logging.Formatter(logging_module.LOG_FORMAT),
        max_bytes=logging_module.LOG_MAX_BYTES,
        backup_count=logging_module.LOG_BACKUP_COUNT,
        retry_seconds=300.0,
        monotonic=lambda: now["t"],
    )
    root = logging.getLogger()
    root.addHandler(fallback)
    root.setLevel(logging.INFO)

    log_path.rmdir()
    now["t"] = 301.0
    logging.getLogger("probe.selfheal.tty").info("after-heal")

    assert "after-heal" in log_path.read_text(encoding="utf-8")
    assert "after-heal" in console.getvalue()
