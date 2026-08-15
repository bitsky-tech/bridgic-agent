from __future__ import annotations

import subprocess
from pathlib import Path

from build.amphi_autostart_entry import (
    CREATE_NO_WINDOW,
    PYINSTALLER_RESET_ENVIRONMENT,
    WindowsAutostartLauncher,
)


def test_windowless_launcher_forwards_server_start(tmp_path: Path) -> None:
    executable = tmp_path / "Program Files" / "Amphi" / "amphi-autostart.exe"
    cli = executable.with_name("amphi.exe")
    cli.parent.mkdir(parents=True)
    cli.touch()
    captured: dict = {}

    def runner(arguments, **options):
        captured["arguments"] = arguments
        captured["options"] = options
        return subprocess.CompletedProcess(arguments, 0)

    launcher = WindowsAutostartLauncher(
        executable=executable,
        platform="win32",
        environment={"AMPHI_TEST": "kept"},
        runner=runner,
    )

    assert launcher.run(
        ["server", "start", "--host", "127.0.0.1", "--port", "8123"]
    ) == 0
    assert captured["arguments"] == [
        str(cli),
        "server",
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        "8123",
    ]
    assert captured["options"] == {
        "cwd": cli.parent,
        "env": {
            "AMPHI_TEST": "kept",
            PYINSTALLER_RESET_ENVIRONMENT: "1",
        },
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "check": False,
        "creationflags": CREATE_NO_WINDOW,
    }


def test_windowless_launcher_rejects_other_commands_and_missing_cli(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "amphi-autostart.exe"
    launcher = WindowsAutostartLauncher(
        executable=executable,
        platform="win32",
    )

    assert launcher.run(["server", "stop"]) == 2
    assert launcher.run(["server", "start"]) == 1
    assert WindowsAutostartLauncher(
        executable=executable,
        platform="darwin",
    ).run(["server", "start"]) == 2
