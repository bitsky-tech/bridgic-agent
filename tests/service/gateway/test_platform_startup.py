import plistlib
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.amphi_service.server.supervisor import RunKeySupervisor, ServeCommand, ServerLaunchSpec
from src.amphi_service.server.supervisor._base import (
    PYINSTALLER_RESET_ENVIRONMENT,
    WINDOWS_AUTOSTART_EXECUTABLE,
)
from src.amphi_service.server.supervisor._detached import (
    CREATE_NEW_PROCESS_GROUP,
    CREATE_NO_WINDOW,
    DETACHED_PROCESS,
    DetachedSupervisor,
)
from src.amphi_service.server.supervisor._launchd import LABEL, LaunchdSupervisor
from tests._support.sandbox import IsolatedPaths


def test_launch_commands(test_sandbox: IsolatedPaths) -> None:
    """Source and packaged builds produce platform-correct Gateway commands.

    Final state:
    {
      "source": ["python", "-m", "src", "server", "serve"],
      "macos": ["amphi", "server", "serve"],
      "windows_login": ["amphi-autostart.exe", "server", "start"]
    }

    Checks:
    1. Source launches use the current Python module from the repository root.
    2. Packaged macOS launches run the foreground application executable.
    3. Packaged Windows login uses the windowless launcher and start command.
    4. Only approved user-session environment variables enter supervisor definitions.
    """
    environment = {"PATH": "/usr/local/bin", "LANG": "en_US.UTF-8", "PRIVATE_TOKEN": "hidden"}

    # Check 1: Source launches use the current Python module from the repository root.
    source = ServeCommand(
        executable=test_sandbox.root / "python",
        frozen=False,
        environment=environment,
        platform="linux",
        source_root=test_sandbox.root,
    ).serve("127.0.0.1", 7421, "warning")
    assert source.argv == [
        str(test_sandbox.root / "python"),
        "-m",
        "src",
        "server",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "7421",
        "--log-level",
        "warning",
    ]
    assert source.working_directory == test_sandbox.root

    # Check 2: Packaged macOS launches run the foreground application executable.
    mac_executable = test_sandbox.root / "Bridgic Agent.app" / "Contents" / "MacOS" / "amphi"
    macos = ServeCommand(
        executable=mac_executable,
        frozen=True,
        environment=environment,
        platform="darwin",
    ).serve("127.0.0.1", 7421)
    assert macos.argv == [
        str(mac_executable),
        "server",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "7421",
        "--log-level",
        "info",
    ]

    # Check 3: Packaged Windows login uses the windowless launcher and start command.
    windows_executable = test_sandbox.root / "Bridgic Agent" / "amphi.exe"
    windows = ServeCommand(
        executable=windows_executable,
        frozen=True,
        environment=environment,
        platform="win32",
    ).start("127.0.0.1", 7421)
    assert windows.argv == [
        str(windows_executable.with_name(WINDOWS_AUTOSTART_EXECUTABLE)),
        "server",
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        "7421",
        "--log-level",
        "info",
    ]

    # Check 4: Only approved user-session variables enter supervisor definitions.
    assert dict(source.environment) == {"PATH": "/usr/local/bin", "LANG": "en_US.UTF-8"}
    assert dict(macos.environment) == dict(source.environment)
    assert dict(windows.environment) == dict(source.environment)


def test_macos_launchd(test_sandbox: IsolatedPaths) -> None:
    """macOS login startup renders one restartable per-user LaunchAgent.

    Final state:
    {
      "launchd": {
        "label": "ai.bridgic.agent.daemon",
        "run_at_load": true,
        "restart_after_failure": true,
        "environment": {"PATH": "/usr/local/bin"}
      }
    }

    Checks:
    1. The plist runs the exact foreground Gateway command from its working directory.
    2. Login and crash-restart policies keep the Gateway available to the Desktop.
    3. The user command environment is carried into launchd's sparse environment.
    """
    spec = ServerLaunchSpec(
        executable=Path("/Applications/Bridgic Agent.app/Contents/MacOS/amphi"),
        arguments=("server", "serve", "--port", "7421"),
        working_directory=Path("/Applications/Bridgic Agent.app/Contents/MacOS"),
        environment={"PATH": "/usr/local/bin"},
    )
    definition = plistlib.loads(
        LaunchdSupervisor(platform="darwin", home=test_sandbox.home, uid=501).render_plist(spec)
    )

    # Check 1: The plist runs the exact foreground Gateway command from its working directory.
    assert definition["Label"] == LABEL
    assert definition["ProgramArguments"] == spec.argv
    assert definition["WorkingDirectory"] == str(spec.working_directory)

    # Check 2: Login and crash-restart policies keep the Gateway available to the Desktop.
    assert definition["RunAtLoad"] is True
    assert definition["KeepAlive"] == {"SuccessfulExit": False}

    # Check 3: The user command environment is carried into launchd's sparse environment.
    assert definition["EnvironmentVariables"] == {"PATH": "/usr/local/bin"}


def test_windows_run_key(test_sandbox: IsolatedPaths) -> None:
    """Windows login startup registers the windowless launcher without elevation.

    Final state:
    {
      "windows_run": {
        "enabled": true,
        "command": "\".../amphi-autostart.exe\" server start ..."
      }
    }

    Checks:
    1. Enabling autostart writes the full quoted login command to the user Run key.
    2. The effective status reflects both the Run value and StartupApproved state.
    3. The login launcher is registration-only and does not claim the live process.
    """
    launcher = test_sandbox.root / "Bridgic Agent" / WINDOWS_AUTOSTART_EXECUTABLE
    launcher.parent.mkdir(parents=True)
    launcher.touch()
    written: list[str] = []
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: written[-1] if written else None,
        write_value=written.append,
        delete_value=written.clear,
        read_approval=lambda: bytes([2]),
        enable_approval=lambda: None,
    )
    spec = ServerLaunchSpec(
        executable=launcher,
        arguments=("server", "start", "--host", "127.0.0.1", "--port", "7421"),
        working_directory=launcher.parent,
    )

    # Check 1: Enabling autostart writes the full quoted login command to the user Run key.
    status = supervisor.enable(spec)
    assert written == [subprocess.list2cmdline(spec.argv)]
    assert written[0].startswith(f'"{launcher}" server start')

    # Check 2: The effective status reflects both the Run value and StartupApproved state.
    assert status.supported is True
    assert status.enabled is True

    # Check 3: The login launcher is registration-only and does not claim the live process.
    assert supervisor.owns_process is False


@pytest.mark.parametrize(
    ("platform", "option_name", "option_value"),
    [
        ("darwin", "start_new_session", True),
        ("linux", "start_new_session", True),
        (
            "win32",
            "creationflags",
            CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW,
        ),
    ],
)
def test_detached_process(
    test_sandbox: IsolatedPaths,
    monkeypatch: pytest.MonkeyPatch,
    platform: str,
    option_name: str,
    option_value: object,
) -> None:
    """Manual startup detaches the Gateway according to the host process model.

    Final state:
    {
      "macos_linux": {"start_new_session": true},
      "windows": {"creationflags": "detached + no-window + process-group"}
    }

    Checks:
    1. POSIX systems start a new session while Windows uses detached process flags.
    2. Frozen children receive PyInstaller's clean-process environment marker.
    3. The detached child keeps the exact Gateway command and working directory.
    """
    executable = test_sandbox.root / "amphi"
    executable.touch()
    command = ServeCommand(
        executable=executable,
        frozen=True,
        environment={"PATH": "/system/bin"},
        platform=platform,
    )
    spec = command.serve("127.0.0.1", 7421)
    captured: dict[str, object] = {}

    def popen(argv: list[str], **options: object) -> SimpleNamespace:
        captured["argv"] = argv
        captured.update(options)
        return SimpleNamespace(pid=4321)

    monkeypatch.setattr(subprocess, "Popen", popen)
    supervisor = DetachedSupervisor(
        command=command,
        log_path=test_sandbox.root / "gateway.log",
        platform=platform,
    )

    # Check 1: POSIX systems start a new session while Windows uses detached process flags.
    assert supervisor.start(spec) == 4321
    assert captured[option_name] == option_value
    if platform == "win32":
        assert "start_new_session" not in captured
    else:
        assert "creationflags" not in captured

    # Check 2: Frozen children receive PyInstaller's clean-process environment marker.
    assert captured["env"] == {"PATH": "/system/bin", PYINSTALLER_RESET_ENVIRONMENT: "1"}

    # Check 3: The detached child keeps the exact Gateway command and working directory.
    assert captured["argv"] == spec.argv
    assert captured["cwd"] == spec.working_directory
