"""Daemon file logging: one rotating ``server.log`` regardless of supervisor.

Until now the daemon had no logging configuration at all. Uvicorn's default
``LOGGING_CONFIG`` wires only the three ``uvicorn*`` loggers to the console,
so the application's own ``logging.getLogger(__name__)`` records either
vanished (INFO) or fell through to ``logging.lastResort`` (bare message on
stderr, no timestamp, no level, no logger name). Where that console ended up
then depended on the supervisor: the detached path redirected it into
``server.log``, launchd into ``~/Library/Logs/Amphi/``, and a dev terminal
kept it on screen — three different answers to "where are the logs?".

This module gives the daemon process one authoritative, supervisor-independent
answer: a rotating file handler on the root logger, writing
``<runtime_dir>/server.log``. The supervisors' stdout/stderr redirection is
demoted to a crash net for output produced before (or outside) the logging
system — import-failure tracebacks, stray prints.
"""

from __future__ import annotations

import logging
import os
import platform
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Optional

from src import __version__

logger = logging.getLogger(__name__)

LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 2
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
# Matches the timestamp prefix _uvicorn.log_config() has always used, so a
# server.log survives a version upgrade with one consistent line shape.
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

#: CLI ``--log-level`` choices → logger level. Uvicorn's ``trace`` has no
#: stdlib equivalent below DEBUG, so it maps to DEBUG.
_LEVELS = {
    "critical": logging.CRITICAL,
    "error": logging.ERROR,
    "warning": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
    "trace": logging.DEBUG,
}

#: The packages whose loggers ``--log-level`` is meant to control.
#:
#: The flag is a *uvicorn* option that historically reached only the three
#: ``uvicorn*`` loggers. Applying it to the root logger instead would hand
#: ``--log-level debug`` to every dependency in the process — httpx, the LLM
#: SDK clients, asyncio — whose DEBUG records include request options and
#: bodies. That both floods the rotation budget and writes third-party request
#: detail into the file the GUI's "Open Logs" button hands to the user.
#: The ``src.`` prefix is not a source-tree artifact: ``pyproject.toml`` ships
#: ``packages = ["src"]``, so every module is imported as ``src.amphi_*`` in a
#: wheel and in the frozen build alike. ``test_server_logging`` asserts this
#: list still covers this very module's ``__name__``.
APP_LOGGER_NAMES: tuple[str, ...] = (
    "src.amphi_service",
    "src.amphi_agent",
    "src.amphi_store",
    "src.amphi_cli",
)


def _apply_levels(log_level: str) -> None:
    """Point ``--log-level`` at the application's own loggers, not at root."""
    level = _LEVELS.get(log_level, logging.INFO)
    # Root never drops below INFO: a DEBUG root would hand every dependency's
    # DEBUG stream (request options and bodies included) to a file the GUI
    # opens for the user, and would flood the rotation budget in minutes.
    logging.getLogger().setLevel(max(level, logging.INFO))
    for name in APP_LOGGER_NAMES:
        logging.getLogger(name).setLevel(level)


def configure_console_logging(
    *,
    log_level: str = "info",
    stderr: Optional[Any] = None,
) -> logging.Handler:
    """Attach console-only logging to the root logger.

    Used by the ``--reload`` development path, whose worker processes are
    spawned by uvicorn and must not share the daemon's rotating file (two
    processes rotating one file corrupt each other's renames).
    """
    stream = sys.stderr if stderr is None else stderr
    _apply_levels(log_level)
    console = logging.StreamHandler(stream)
    console.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT))
    logging.getLogger().addHandler(console)
    return console


def configure_daemon_logging(
    log_path: Path,
    *,
    log_level: str = "info",
    stderr: Optional[Any] = None,
    max_bytes: int = LOG_MAX_BYTES,
    backup_count: int = LOG_BACKUP_COUNT,
) -> Optional[logging.Handler]:
    """Attach rotating file logging to the root logger.

    Returns the file handler on success and ``None`` when the log file cannot
    be opened — the daemon then logs to the console rather than failing
    startup over its own diagnostics (the same start-degraded philosophy as
    ``runtime._env_supervisor``).

    Exactly one destination is normally installed. A console handler is added
    when ``stderr`` is a TTY — a developer running ``amphi server serve`` in a
    terminal keeps live output — and *also* when the file handler could not be
    opened, because the caller passes ``log_config=None`` to uvicorn: without
    a root handler, uvicorn's own loggers have nowhere to write either, and a
    daemon that cannot open its log file would start in total silence. Under a
    supervisor that console is the crash-net file, which is the right place
    for it.

    Parameters
    ----------
    log_path : Path
        Rotating log destination; parent directories are created.
    log_level : str
        CLI log level name; unknown names fall back to INFO.
    stderr : file-like, optional
        Console stream probed for TTY-ness. Defaults to ``sys.stderr``.
    max_bytes, backup_count : int
        Rotation policy overrides for tests.
    """
    stream = sys.stderr if stderr is None else stderr
    formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
    # Levels first, so the degraded path below is still correctly configured.
    _apply_levels(log_level)
    root = logging.getLogger()

    def add_console() -> None:
        console = logging.StreamHandler(stream)
        console.setFormatter(formatter)
        root.addHandler(console)

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_path,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
            # Never let one unencodable record kill the handler.
            errors="backslashreplace",
        )
    except OSError as exc:
        print(
            f"[daemon-logging] could not open {log_path}: {exc}; "
            "falling back to console logging",
            file=stream,
        )
        add_console()
        return None

    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    try:
        is_tty = bool(stream.isatty())
    except (AttributeError, OSError, ValueError):
        is_tty = False
    if is_tty:
        add_console()
    # Session banner, emitted after every handler is attached so a dev
    # terminal prints it too. The rotation mixes several daemon sessions into
    # one file; without a hard boundary carrying pid and version there is no
    # answering "which lines are from after the upgrade?", nor matching a
    # crash-net traceback to the server.log session it interrupted.
    logger.info(
        "[daemon-logging] started pid=%d version=%s log_level=%s python=%s file=%s",
        os.getpid(),
        __version__,
        log_level,
        platform.python_version(),
        log_path,
    )
    return file_handler


def log_crash_net_size(path: Path) -> None:
    """One INFO breadcrumb when the crash net holds output from earlier runs.

    The reader of ``server.log`` cannot see ``daemon.stderr.log`` from inside
    the file, yet that is where the traceback of a start-up death lives — a
    launchd ``KeepAlive`` crash loop appends one per restart and nothing in
    ``server.log`` hints that the file exists. Never raises: a stat failure
    only costs the breadcrumb.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return
    if size <= 0:
        return
    logger.info(
        "[daemon-logging] crash net %s holds %d bytes from previous runs", path, size
    )


__all__ = [
    "APP_LOGGER_NAMES",
    "configure_console_logging",
    "LOG_BACKUP_COUNT",
    "LOG_DATE_FORMAT",
    "LOG_FORMAT",
    "LOG_MAX_BYTES",
    "configure_daemon_logging",
    "log_crash_net_size",
]
