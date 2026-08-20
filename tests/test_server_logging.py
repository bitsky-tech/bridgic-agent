"""Behavioral contract of configure_daemon_logging.

These tests hold three lines:
1. Records from application loggers (logging.getLogger(__name__) style) must
   land in server.log with timestamp/level/logger name — fixing the era of a
   handler-less root where INFO was dropped and ERROR fell through to
   lastResort's bare output.
2. The log file rotates, and only the handler holds it open (the crash net is
   a separate file).
3. When the logging setup itself fails, the daemon degrades and keeps running;
   it must never fail startup over its own diagnostics.
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
    # _apply_levels mutates process-wide logger objects — the four app loggers
    # on top of root. Without restoring them, whichever test in this module
    # runs last (DEBUG or WARNING) decides the app-logger levels for the rest
    # of the session — under random ordering that is an intermittent failure
    # in some unrelated caplog test.
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

    # Probes use fresh logger names: the real ones (amphi_agent.* / uvicorn.*)
    # may carry propagate=False or a disabled flag left behind by some other
    # test's dictConfig. In the daemon process they are clean (we pass
    # log_config=None, so uvicorn never runs dictConfig).
    logging.getLogger("probe.module.logger").info("session %s established", "s1")
    logging.getLogger("probe.uvicorn.logger").warning("uvicorn-side warning")
    handler.flush()

    content = log_path.read_text(encoding="utf-8")
    assert "INFO probe.module.logger session s1 established" in content
    assert "WARNING probe.uvicorn.logger uvicorn-side warning" in content
    # Every line carries a timestamp prefix (like 2026-08-18 10:00:00,123).
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
    # --log-level is a uvicorn option and may only reach the application's own
    # loggers: dropping root to DEBUG with it would write httpx / LLM SDK
    # request detail (bodies included) into a file the user opens, and flood
    # the rotation budget within minutes.
    assert root.level == logging.INFO
    for name in APP_LOGGER_NAMES:
        assert logging.getLogger(name).level == logging.DEBUG
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.INFO


def test_app_logger_names_cover_this_repo_s_actual_module_names() -> None:
    # packages = ["src"], so runtime module names carry the src. prefix. This
    # assertion fails the moment the packaging layout changes, instead of
    # letting --log-level silently stop working.
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
        logger.info("rotation filler line %04d %s", index, "x" * 64)
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
    # Key point: the caller hands uvicorn log_config=None, so a handler-less
    # root silences the whole process — uvicorn's own startup banner included.
    logging.getLogger("probe.degraded").info("must still be visible")
    assert "must still be visible" in stderr.getvalue()
    assert logging.getLogger("uvicorn.error").hasHandlers()


def test_console_only_configuration_serves_the_reload_worker(tmp_path: Path) -> None:
    stderr = io.StringIO()

    configure_console_logging(stderr=stderr)

    logging.getLogger("probe.reload").info("dev reload needs logs too")
    assert "dev reload needs logs too" in stderr.getvalue()
    # Reload workers are separate uvicorn-spawned processes and must never
    # share the daemon's rotating file.
    assert not list(tmp_path.iterdir())


def test_console_handler_only_when_stderr_is_a_tty(tmp_path: Path) -> None:
    root = logging.getLogger()
    before = len(root.handlers)

    handler = configure_daemon_logging(
        tmp_path / "server.log", stderr=io.StringIO()
    )
    assert handler is not None
    # Non-TTY (redirected by a supervisor): file handler only, so the crash
    # net is not double-written.
    assert len(root.handlers) == before + 1

    tty = _TtyStderr()
    handler_tty = configure_daemon_logging(tmp_path / "server2.log", stderr=tty)
    assert handler_tty is not None
    # TTY (a developer's foreground serve): one copy to the file, one to the
    # terminal.
    assert len(root.handlers) == before + 3

    logging.getLogger("console.probe").error("console must see this too")
    assert "console must see this too" in tty.getvalue()


def test_startup_banner_marks_each_daemon_session(tmp_path: Path) -> None:
    # server.log rotates at 5MB x 2 and interleaves several restarts in one
    # file; without a boundary line "which lines are post-upgrade" cannot be
    # answered. The banner is each session's hard boundary in the file.
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
    # Scenario: the first successful start after a launchd KeepAlive crash
    # loop. The traceback sits in daemon.stderr.log while the investigator is
    # staring at server.log — this breadcrumb sends them over.
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
    # Make RotatingFileHandler unable to open: a directory sits on the path,
    # so the open raises OSError (IsADirectoryError).
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
    """The usual degradation causes (full disk, a briefly locked directory)
    are transient; degrading used to be forever — every record went into the
    unrotated crash net until the next restart. The fallback now retries per
    emitted record, rate-limited, and switches back to server.log once the
    path is writable again."""
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

    # Phase 1: path still unwritable, retry window open -> the attempt fails,
    # records keep going to the console.
    now["t"] = 301.0
    probe.info("degraded-1")
    assert "degraded-1" in console.getvalue()
    assert not (tmp_path / "server.log").is_file()

    # Phase 2: path writable again but inside the rate-limit window -> no
    # retry, still console.
    log_path.rmdir()
    probe.info("degraded-2")
    assert "degraded-2" in console.getvalue()
    assert not log_path.is_file()

    # Phase 3: the first record after the window triggers the handover: it
    # lands in the file, and the console stops growing.
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
    # Recovery after degrading in a dev terminal: the healthy path is file +
    # TTY console side by side, and the recovered topology must match — the
    # terminal cannot suddenly go quiet.
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
