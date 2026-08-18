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
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Optional

LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 2
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
# Matches the timestamp prefix _uvicorn.log_config() has always used, so a
# server.log survives a version upgrade with one consistent line shape.
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

#: CLI ``--log-level`` choices → root logger level. Uvicorn's ``trace`` has no
#: stdlib equivalent below DEBUG, so it maps to DEBUG.
_ROOT_LEVELS = {
    "critical": logging.CRITICAL,
    "error": logging.ERROR,
    "warning": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
    "trace": logging.DEBUG,
}


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
    be opened — the daemon then runs without file logging rather than failing
    startup over its own diagnostics (the same start-degraded philosophy as
    ``runtime._env_supervisor``).

    A console handler is added only when ``stderr`` is a TTY: a developer
    running ``amphi server serve`` in a terminal keeps live output, while a
    supervised daemon (stderr redirected to the crash-net file, never a TTY)
    writes each record exactly once, to ``server.log``.

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
            "continuing without file logging",
            file=stream,
        )
        return None

    file_handler.setFormatter(formatter)
    root = logging.getLogger()
    root.setLevel(_ROOT_LEVELS.get(log_level, logging.INFO))
    root.addHandler(file_handler)

    is_tty = getattr(stream, "isatty", lambda: False)
    try:
        if is_tty():
            console = logging.StreamHandler(stream)
            console.setFormatter(formatter)
            root.addHandler(console)
    except (OSError, ValueError):
        pass
    return file_handler


__all__ = [
    "LOG_BACKUP_COUNT",
    "LOG_DATE_FORMAT",
    "LOG_FORMAT",
    "LOG_MAX_BYTES",
    "configure_daemon_logging",
]
