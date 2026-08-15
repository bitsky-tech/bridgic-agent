"""Windowless Windows login launcher for the frozen ``amphi`` CLI."""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Callable

PYINSTALLER_RESET_ENVIRONMENT = "PYINSTALLER_RESET_ENVIRONMENT"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


class WindowsAutostartLauncher:
    """Forward ``server start`` without creating a Windows console.

    Parameters
    ----------
    executable : str | Path | None
        Path to this launcher. Its sibling ``amphi.exe`` is the forwarding
        target.
    platform : str | None
        Platform override used by cross-platform tests.
    environment : Mapping[str, str] | None
        Environment copied into the independent frozen child.
    runner : Callable
        Subprocess runner, injectable for tests.
    """

    def __init__(
        self,
        *,
        executable: str | Path | None = None,
        platform: str | None = None,
        environment: Mapping[str, str] | None = None,
        runner: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
    ) -> None:
        self.executable = Path(sys.executable if executable is None else executable)
        self.platform = sys.platform if platform is None else platform
        self.environment = os.environ if environment is None else environment
        self.runner = runner

    @property
    def cli_path(self) -> Path:
        """Return the sibling console CLI bundled in the same onedir tree."""
        return self.executable.with_name("amphi.exe")

    def run(self, arguments: Sequence[str]) -> int:
        """Run an ``amphi server start`` command and return its exit code."""
        argv = [str(argument) for argument in arguments]
        if self.platform != "win32" or argv[:2] != ["server", "start"]:
            return 2
        if not self.cli_path.is_file():
            return 1

        environment = dict(self.environment)
        environment[PYINSTALLER_RESET_ENVIRONMENT] = "1"
        try:
            result = self.runner(
                [str(self.cli_path), *argv],
                cwd=self.cli_path.parent,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                creationflags=CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            return 1
        return int(result.returncode)


def main() -> int:
    """Run the windowless launcher without allowing an exception dialog."""
    try:
        return WindowsAutostartLauncher().run(sys.argv[1:])
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
