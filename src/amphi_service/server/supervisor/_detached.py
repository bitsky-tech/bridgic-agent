"""Detached subprocess supervisor for ordinary background launches."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from ._base import (
    ServeCommand,
    ServerLaunchSpec,
    SupervisorError,
    trim_oversized_log,
)

CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


class DetachedSupervisor:
    """Start a server process independently of its invoking process.

    Parameters
    ----------
    command : ServeCommand
        Command builder that also owns frozen-child environment isolation.
    log_path : Path
        Crash-net file receiving both standard output and standard error —
        output produced before or outside the daemon's own logging system
        (import-failure tracebacks, stray prints). Structured logs go to
        ``server.log`` via the daemon's rotating handler (see
        ``amphi_service.server._logging``), never through this redirect.
    platform : str | None
        Platform override used by pure cross-platform tests.
    """

    def __init__(self, command: ServeCommand, log_path: Path, platform: str | None = None) -> None:
        self.command = command
        self.log_path = Path(log_path)
        self.platform = sys.platform if platform is None else platform

    def start(self, spec: ServerLaunchSpec) -> int:
        """Start ``spec`` detached and return its process identifier."""
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            trim_oversized_log(self.log_path)
            log_handle = self.log_path.open("ab", buffering=0)
        except OSError as exc:
            raise SupervisorError(
                f"could not open detached service log {self.log_path}"
            ) from exc
        options = {
            "stdin": subprocess.DEVNULL,
            "stdout": log_handle,
            "stderr": subprocess.STDOUT,
            "cwd": spec.working_directory,
            "env": self.command.detached_environment(),
            "close_fds": True,
        }
        if self.platform.lower().startswith("win"):
            options["creationflags"] = (
                CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW
            )
        else:
            options["start_new_session"] = True

        try:
            try:
                process = subprocess.Popen(spec.argv, **options)
            except OSError as exc:
                raise SupervisorError(
                    f"could not launch detached service {spec.executable}"
                ) from exc
        finally:
            log_handle.close()
        return process.pid


__all__ = [
    "CREATE_NEW_PROCESS_GROUP",
    "CREATE_NO_WINDOW",
    "DETACHED_PROCESS",
    "DetachedSupervisor",
]
