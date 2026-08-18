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
from pathlib import Path
from typing import Iterator

import pytest

from src.amphi_service.server._logging import configure_daemon_logging


class _TtyStderr(io.StringIO):
    def isatty(self) -> bool:  # noqa: D102 - trivial test double
        return True


@pytest.fixture(autouse=True)
def _restore_root_logger() -> Iterator[None]:
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    saved_disable = logging.root.manager.disable
    logging.disable(logging.NOTSET)
    yield
    for handler in list(root.handlers):
        if handler not in saved_handlers:
            root.removeHandler(handler)
            handler.close()
    root.setLevel(saved_level)
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
    assert root.level == logging.DEBUG


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


def test_unwritable_log_path_degrades_instead_of_raising(tmp_path: Path) -> None:
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("occupied", encoding="utf-8")
    stderr = io.StringIO()

    handler = configure_daemon_logging(blocker / "server.log", stderr=stderr)

    assert handler is None
    assert "continuing without file logging" in stderr.getvalue()


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
