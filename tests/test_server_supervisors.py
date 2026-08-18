from __future__ import annotations

import plistlib
import subprocess
from pathlib import Path

import pytest

from src.amphi_service.server.supervisor import (
    AutostartStatus,
    AutostartSupervisor,
    RunKeySupervisor,
    ServeCommand,
    ServerLaunchSpec,
    SupervisorError,
    UnsupportedSupervisor,
)
from src.amphi_service.server.supervisor import _detached
from src.amphi_service.server.supervisor._base import (
    PYINSTALLER_RESET_ENVIRONMENT,
    WINDOWS_AUTOSTART_EXECUTABLE,
)
from src.amphi_service.server.supervisor._detached import DetachedSupervisor
from src.amphi_service.server.supervisor._launchd import LABEL, LaunchdSupervisor
from src.amphi_service.server.supervisor._run_key import (
    RUN_KEY_PATH,
    RUN_VALUE_NAME,
)


def completed(
    arguments: list[str],
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(arguments, returncode, stdout, stderr)


def test_legacy_autostart_supervisor_fails_safe_for_config_only_operations() -> None:
    class LegacySupervisor(AutostartSupervisor):
        def enable(self, spec: ServerLaunchSpec) -> AutostartStatus:
            return self.status()

        def disable(self) -> AutostartStatus:
            return self.status()

        def activate(self) -> AutostartStatus:
            return self.status()

        def deactivate(self) -> AutostartStatus:
            return self.status()

        def status(self) -> AutostartStatus:
            return AutostartStatus(
                manager="legacy",
                supported=True,
                enabled=False,
            )

    supervisor = LegacySupervisor()
    spec = ServerLaunchSpec(
        executable="/runtime/amphi",
        arguments=(),
        working_directory="/runtime",
    )

    with pytest.raises(UnsupportedSupervisor, match="configuration-only install"):
        supervisor.install(spec)
    with pytest.raises(UnsupportedSupervisor, match="configuration-only uninstall"):
        supervisor.uninstall()


def test_serve_command_builds_source_and_frozen_specs(tmp_path: Path) -> None:
    # environment={} pins the spec's user-environment snapshot: without it these
    # builders read the real os.environ and the equality assertion below would
    # depend on the developer's PATH.
    source = ServeCommand(
        executable="/runtime/python",
        frozen=False,
        source_root=tmp_path,
        environment={},
    ).serve("127.0.0.1", 7421, "debug")
    frozen = ServeCommand(
        executable=tmp_path / "Amphi" / "amphi.exe",
        frozen=True,
        environment={},
    ).serve("0.0.0.0", 8123)

    assert source == ServerLaunchSpec(
        executable=Path("/runtime/python"),
        arguments=(
            "-m",
            "src",
            "server",
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "7421",
            "--log-level",
            "debug",
        ),
        working_directory=tmp_path,
    )
    assert source.argv == [
        "/runtime/python",
        "-m",
        "src",
        "server",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "7421",
        "--log-level",
        "debug",
    ]
    assert frozen.argv[:3] == [
        str(tmp_path / "Amphi" / "amphi.exe"),
        "server",
        "serve",
    ]
    assert frozen.working_directory == tmp_path / "Amphi"
    frozen_start = ServeCommand(
        executable=tmp_path / "Amphi" / "amphi.exe",
        frozen=True,
        platform="win32",
        environment={},
    ).start("127.0.0.1", 7421)
    assert frozen_start.executable == (
        tmp_path / "Amphi" / WINDOWS_AUTOSTART_EXECUTABLE
    )
    assert frozen_start.arguments[:2] == ("server", "start")

    source_start = ServeCommand(
        executable="/runtime/python",
        frozen=False,
        platform="win32",
        source_root=tmp_path,
        environment={},
    ).start("127.0.0.1", 7421)
    assert source_start.executable == Path("/runtime/python")
    assert source_start.arguments[:4] == ("-m", "src", "server", "start")


def test_frozen_detached_environment_is_isolated() -> None:
    source = ServeCommand(
        executable="/runtime/python",
        frozen=False,
        environment={"AMPHI_TEST": "kept"},
    )
    frozen = ServeCommand(
        executable="/runtime/amphi",
        frozen=True,
        environment={"AMPHI_TEST": "kept"},
    )

    assert source.detached_environment() is None
    assert frozen.detached_environment() == {
        "AMPHI_TEST": "kept",
        PYINSTALLER_RESET_ENVIRONMENT: "1",
    }


def test_autostart_status_has_optional_state_defaults() -> None:
    assert AutostartStatus("test", True, False) == AutostartStatus(
        manager="test",
        supported=True,
        enabled=False,
        active=None,
        definition=None,
        detail=None,
    )


@pytest.mark.parametrize(
    ("platform", "expected_option", "unexpected_option"),
    [
        ("darwin", "start_new_session", "creationflags"),
        ("win32", "creationflags", "start_new_session"),
    ],
)
def test_detached_supervisor_uses_platform_process_isolation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    platform: str,
    expected_option: str,
    unexpected_option: str,
) -> None:
    captured: dict = {}

    class Process:
        pid = 2468

    def fake_popen(arguments, **options):
        captured["arguments"] = arguments
        captured["options"] = options
        return Process()

    monkeypatch.setattr(_detached.subprocess, "Popen", fake_popen)
    command = ServeCommand(
        executable=tmp_path / "amphi.exe",
        frozen=True,
    )
    spec = command.serve("127.0.0.1", 7421)
    log_path = tmp_path / "logs" / "server.log"

    pid = DetachedSupervisor(command, log_path, platform=platform).start(spec)

    assert pid == 2468
    assert captured["arguments"] == spec.argv
    assert expected_option in captured["options"]
    assert unexpected_option not in captured["options"]
    if platform == "win32":
        assert captured["options"]["creationflags"] == (
            _detached.CREATE_NEW_PROCESS_GROUP
            | _detached.DETACHED_PROCESS
            | _detached.CREATE_NO_WINDOW
        )
    else:
        assert captured["options"]["start_new_session"] is True
    assert captured["options"]["cwd"] == spec.working_directory
    assert captured["options"]["stderr"] is subprocess.STDOUT
    assert captured["options"]["stdout"].closed
    assert captured["options"]["env"][PYINSTALLER_RESET_ENVIRONMENT] == "1"
    assert log_path.exists()


def test_detached_supervisor_trims_an_oversized_crash_log_before_launch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """兜底文件跨生命周期只追加，无法运行时轮转，所以在启动时截断。"""

    class Process:
        pid = 4321

    monkeypatch.setattr(
        _detached.subprocess,
        "Popen",
        lambda arguments, **options: Process(),
    )
    command = ServeCommand(executable=tmp_path / "amphi", frozen=True)
    log_path = tmp_path / "daemon.stderr.log"
    log_path.write_bytes(b"x" * (6 * 1024 * 1024))

    DetachedSupervisor(command, log_path, platform="darwin").start(
        command.serve("127.0.0.1", 7421)
    )

    assert log_path.stat().st_size == 0


def test_detached_supervisor_wraps_process_launch_failures(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    def fail(*_arguments, **_options):
        raise OSError("cannot execute")

    monkeypatch.setattr(_detached.subprocess, "Popen", fail)
    command = ServeCommand(
        executable=tmp_path / "amphi",
        frozen=True,
    )

    with pytest.raises(SupervisorError, match="could not launch"):
        DetachedSupervisor(
            command,
            tmp_path / "server.log",
            platform="darwin",
        ).start(command.serve("127.0.0.1", 7421))


def test_launchd_plist_has_foreground_keepalive_contract(tmp_path: Path) -> None:
    spec = ServeCommand(
        executable="/runtime/python",
        frozen=False,
        source_root=tmp_path / "repo",
        environment={},
    ).serve("127.0.0.1", 7421)
    supervisor = LaunchdSupervisor(
        platform="darwin",
        home=tmp_path,
        uid=501,
    )

    definition = plistlib.loads(supervisor.render_plist(spec))

    assert definition == {
        "Label": LABEL,
        "ProgramArguments": spec.argv,
        "WorkingDirectory": str(spec.working_directory),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        # Crash net lives beside runtime.json now (single log directory),
        # not under ~/Library/Logs/Amphi.
        "StandardOutPath": str(
            tmp_path / ".bridgic" / "AmphiAgent" / "daemon.stdout.log"
        ),
        "StandardErrorPath": str(
            tmp_path / ".bridgic" / "AmphiAgent" / "daemon.stderr.log"
        ),
    }
    assert definition["ProgramArguments"][3:5] == ["server", "serve"]


def test_launchd_plist_carries_the_user_environment(tmp_path: Path) -> None:
    """launchd hands agents a bare PATH, so the plist must carry the user's.

    Regression: without ``EnvironmentVariables`` the daemon ran with
    ``PATH=/usr/bin:/bin:/usr/sbin:/sbin`` and every new conversation died on
    ``FileNotFoundError: 'uv'`` — while ``which uv`` in the user's terminal
    worked fine, which is what made it expensive to diagnose.
    """
    spec = ServeCommand(
        executable="/runtime/python",
        frozen=False,
        source_root=tmp_path / "repo",
        environment={
            "PATH": "/opt/tools/bin:/usr/bin",
            "LANG": "en_US.UTF-8",
            "HTTPS_PROXY": "http://proxy.invalid:8080",
            # Daemon-private wiring must NOT be frozen into a launcher
            # definition — only the user-session allowlist travels.
            "AMPHI_SECRET_TOKEN": "must-not-travel",
            # Present-but-empty is dropped: writing PATH="" would be worse than
            # writing nothing, since it overrides launchd's own default.
            "NO_PROXY": "",
        },
    ).serve("127.0.0.1", 7421)
    supervisor = LaunchdSupervisor(platform="darwin", home=tmp_path, uid=501)

    definition = plistlib.loads(supervisor.render_plist(spec))

    assert definition["EnvironmentVariables"] == {
        "PATH": "/opt/tools/bin:/usr/bin",
        "LANG": "en_US.UTF-8",
        "HTTPS_PROXY": "http://proxy.invalid:8080",
    }


def test_detached_launch_ignores_the_spec_environment_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The detached path must keep INHERITING, not adopt the allowlist.

    The allowlist exists for launchd, which passes nothing through. A detached
    child inherits the caller's complete environment, which is strictly richer;
    narrowing it to the allowlist here would be a regression dressed up as
    consistency.
    """
    captured: dict = {}

    class Process:
        pid = 1357

    monkeypatch.setattr(
        _detached.subprocess,
        "Popen",
        lambda arguments, **options: (captured.update(options), Process())[1],
    )
    command = ServeCommand(
        executable="/runtime/python",
        frozen=False,
        source_root=tmp_path,
        environment={"PATH": "/opt/tools/bin"},
    )
    spec = command.serve("127.0.0.1", 7421)
    assert spec.environment == {"PATH": "/opt/tools/bin"}

    DetachedSupervisor(command, tmp_path / "server.log", platform="darwin").start(spec)

    # env=None → Popen inherits ours. Anything else means the snapshot leaked in.
    assert captured["env"] is None


def test_launchd_trims_the_crash_net_only_after_booting_the_job_out(
    tmp_path: Path,
) -> None:
    """launchd 在 job 存活期间一直持有这两个文件的描述符。

    若在 bootout 之前截断，而该描述符不是 O_APPEND，下一次写入会落在原来的
    偏移量上，写出一大片 NUL 空洞，文件反而彻底读不了。
    """
    sizes_at_bootout: dict[str, int] = {}
    runtime_dir = tmp_path / ".bridgic" / "AmphiAgent"
    runtime_dir.mkdir(parents=True)
    stderr_log = runtime_dir / "daemon.stderr.log"
    stderr_log.write_bytes(b"x" * (6 * 1024 * 1024))

    def runner(arguments, **_options):
        if arguments[1] == "bootout":
            sizes_at_bootout["stderr"] = stderr_log.stat().st_size
        return completed(arguments, 0)

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="darwin",
        home=tmp_path,
        uid=502,
    )
    spec = ServeCommand(executable=tmp_path / "amphi", frozen=True).serve("127.0.0.1", 7421)

    supervisor.enable(spec)

    assert sizes_at_bootout["stderr"] == 6 * 1024 * 1024
    assert stderr_log.stat().st_size == 0


def test_launchd_enable_writes_atomically_and_reloads(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def runner(arguments, **options):
        calls.append(arguments)
        assert options == {
            "capture_output": True,
            "text": True,
            "check": False,
            "timeout": LaunchdSupervisor.COMMAND_TIMEOUT,
        }
        return completed(arguments, 0 if arguments[1] != "bootout" else 3)

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="darwin",
        home=tmp_path,
        uid=502,
    )
    spec = ServeCommand(
        executable=tmp_path / "amphi",
        frozen=True,
    ).serve("127.0.0.1", 7421)

    status = supervisor.enable(spec)

    assert status == AutostartStatus(
        manager="launchd",
        supported=True,
        enabled=True,
        active=True,
        definition=supervisor.plist_path,
    )
    assert calls == [
        ["launchctl", "bootout", f"gui/502/{LABEL}"],
        [
            "launchctl",
            "bootstrap",
            "gui/502",
            str(supervisor.plist_path),
        ],
        ["launchctl", "print", f"gui/502/{LABEL}"],
    ]
    assert plistlib.loads(supervisor.plist_path.read_bytes())[
        "ProgramArguments"
    ] == spec.argv
    assert list(supervisor.plist_path.parent.iterdir()) == [supervisor.plist_path]
    assert supervisor.log_directory.is_dir()


def test_launchd_install_and_uninstall_preserve_the_loaded_job(
    tmp_path: Path,
) -> None:
    calls: list[list[str]] = []

    def runner(arguments, **_options):
        calls.append(arguments)
        return completed(arguments)

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="darwin",
        home=tmp_path,
        uid=502,
    )
    spec = ServeCommand(
        executable=tmp_path / "amphi",
        frozen=True,
    ).serve("127.0.0.1", 7421)

    installed = supervisor.install(spec)
    uninstalled = supervisor.uninstall()

    assert installed.enabled is True
    assert installed.active is None
    assert uninstalled.enabled is False
    assert uninstalled.active is None
    assert not supervisor.plist_path.exists()
    assert calls == []


@pytest.mark.parametrize(
    ("loaded", "expected_operation"),
    [(True, "kickstart"), (False, "bootstrap")],
)
def test_launchd_activate_uses_loaded_state(
    tmp_path: Path,
    loaded: bool,
    expected_operation: str,
) -> None:
    calls: list[list[str]] = []
    print_count = 0

    def runner(arguments, **_options):
        nonlocal print_count
        calls.append(arguments)
        if arguments[1] == "print":
            print_count += 1
            return completed(arguments, 0 if loaded or print_count > 1 else 3)
        return completed(arguments)

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="darwin",
        home=tmp_path,
        uid=503,
    )
    supervisor.plist_path.parent.mkdir(parents=True)
    supervisor.plist_path.write_text("definition", encoding="utf-8")

    status = supervisor.activate()

    assert calls[1][1] == expected_operation
    assert status.enabled is True
    assert status.active is True


def test_launchd_deactivate_preserves_definition_and_disable_removes_it(
    tmp_path: Path,
) -> None:
    active = True

    def runner(arguments, **_options):
        nonlocal active
        if arguments[1] == "bootout":
            active = False
        return completed(arguments, 0 if active or arguments[1] == "bootout" else 3)

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="darwin",
        home=tmp_path,
        uid=504,
    )
    supervisor.plist_path.parent.mkdir(parents=True)
    supervisor.plist_path.write_text("definition", encoding="utf-8")

    deactivated = supervisor.deactivate()

    assert deactivated.enabled is True
    assert deactivated.active is False
    assert supervisor.plist_path.exists()

    disabled = supervisor.disable()

    assert disabled.enabled is False
    assert disabled.active is False
    assert not supervisor.plist_path.exists()


@pytest.mark.parametrize("operation", ["deactivate", "disable"])
def test_launchd_refuses_to_hide_a_job_that_remains_loaded(
    tmp_path: Path,
    operation: str,
) -> None:
    def runner(arguments, **_options):
        return completed(arguments, 0)

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="darwin",
        home=tmp_path,
        uid=505,
    )
    supervisor.plist_path.parent.mkdir(parents=True)
    supervisor.plist_path.write_text("definition", encoding="utf-8")

    with pytest.raises(SupervisorError, match="remains loaded"):
        getattr(supervisor, operation)()

    assert supervisor.plist_path.exists()


def test_launchd_unsupported_status_does_not_execute_commands(tmp_path: Path) -> None:
    def runner(_arguments, **_options):
        raise AssertionError("runner must not be called")

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="linux",
        home=tmp_path,
    )

    assert supervisor.status() == AutostartStatus(
        manager="launchd",
        supported=False,
        enabled=False,
        detail="launchd is unavailable on linux",
    )
    with pytest.raises(UnsupportedSupervisor):
        supervisor.deactivate()


def test_launchd_status_does_not_treat_command_failures_as_not_loaded(
    tmp_path: Path,
) -> None:
    def runner(arguments, **_options):
        return completed(arguments, 5, stderr="permission denied")

    supervisor = LaunchdSupervisor(
        runner=runner,
        platform="darwin",
        home=tmp_path,
        uid=506,
    )
    supervisor.plist_path.parent.mkdir(parents=True)
    supervisor.plist_path.write_text("definition", encoding="utf-8")

    with pytest.raises(SupervisorError, match="exit code 5"):
        supervisor.status()

    assert supervisor.plist_path.exists()


def test_run_key_supervisor_registers_a_login_launcher(tmp_path: Path) -> None:
    values: dict[str, str] = {}
    approval: list[bytes | None] = [bytes((3, 0, 0, 0))]
    approval_resets: list[bool] = []

    def enable_approval() -> None:
        approval_resets.append(True)
        approval[0] = None

    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: values.get(RUN_VALUE_NAME),
        write_value=lambda command: values.__setitem__(RUN_VALUE_NAME, command),
        delete_value=lambda: values.pop(RUN_VALUE_NAME, None),
        read_approval=lambda: approval[0],
        enable_approval=enable_approval,
    )
    spec = ServeCommand(
        executable=tmp_path / "Program Files" / "Amphi" / "amphi.exe",
        frozen=True,
        platform="win32",
    ).start("127.0.0.1", 7421)
    spec.executable.parent.mkdir(parents=True)
    spec.executable.touch()

    enabled = supervisor.install(spec)

    assert enabled.enabled is True
    assert enabled.active is None
    assert enabled.detail == rf"HKCU\{RUN_KEY_PATH}\{RUN_VALUE_NAME}"
    assert values[RUN_VALUE_NAME] == subprocess.list2cmdline(spec.argv)
    assert WINDOWS_AUTOSTART_EXECUTABLE in values[RUN_VALUE_NAME]
    assert " server start " in f" {values[RUN_VALUE_NAME]} "
    assert approval_resets == [True]
    assert approval[0] is None
    assert supervisor.owns_process is False

    disabled = supervisor.uninstall()

    assert disabled.enabled is False
    assert RUN_VALUE_NAME not in values


def test_run_key_install_preserves_existing_launch_arguments(tmp_path: Path) -> None:
    values = {
        RUN_VALUE_NAME: (
            r'"C:\old\amphi-autostart.exe" server start '
            "--host 0.0.0.0 --port 9000 --log-level debug"
        )
    }
    approval: list[bytes | None] = [bytes((3, 0, 0, 0))]
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: values.get(RUN_VALUE_NAME),
        write_value=lambda command: values.__setitem__(RUN_VALUE_NAME, command),
        read_approval=lambda: approval[0],
        enable_approval=lambda: approval.__setitem__(0, None),
    )
    spec = ServeCommand(
        executable=tmp_path / "new" / "amphi-autostart.exe",
        frozen=True,
        platform="win32",
    ).start("127.0.0.1", 7421)
    spec.executable.parent.mkdir(parents=True)
    spec.executable.touch()

    installed = supervisor.install(spec)

    assert installed.enabled is True
    assert values[RUN_VALUE_NAME].startswith(
        subprocess.list2cmdline([str(spec.executable)])
    )
    assert values[RUN_VALUE_NAME].endswith(
        " server start --host 0.0.0.0 --port 9000 --log-level debug"
    )
    assert approval[0] is None


def test_run_key_legacy_enable_uses_the_requested_arguments(tmp_path: Path) -> None:
    values = {
        RUN_VALUE_NAME: r'"C:\old\amphi-autostart.exe" server start --port 9000'
    }
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: values.get(RUN_VALUE_NAME),
        write_value=lambda command: values.__setitem__(RUN_VALUE_NAME, command),
        read_approval=lambda: None,
        enable_approval=lambda: None,
    )
    spec = ServeCommand(
        executable=tmp_path / "amphi-autostart.exe",
        frozen=True,
        platform="win32",
    ).start("127.0.0.1", 8123, log_level="warning")
    spec.executable.touch()

    enabled = supervisor.enable(spec)

    assert enabled.enabled is True
    assert values[RUN_VALUE_NAME] == subprocess.list2cmdline(spec.argv)


def test_run_key_status_does_not_query_approval_without_a_run_value() -> None:
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: None,
        read_approval=lambda: (_ for _ in ()).throw(
            AssertionError("approval must not be queried without a Run value")
        ),
    )

    status = supervisor.status()

    assert status.enabled is False
    assert status.detail is None


@pytest.mark.parametrize(
    "approval",
    [
        pytest.param(None, id="approval-value-missing"),
        pytest.param(bytes((0, 0, 0, 0)), id="state-zero"),
        pytest.param(bytes((2, 0, 0, 0)), id="state-two"),
    ],
)
def test_run_key_status_requires_an_effective_startup_approval(
    approval: bytes | None,
) -> None:
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: r'"C:\Amphi\amphi-autostart.exe" server start',
        read_approval=lambda: approval,
    )

    status = supervisor.status()

    assert status.enabled is True
    assert status.detail == rf"HKCU\{RUN_KEY_PATH}\{RUN_VALUE_NAME}"


@pytest.mark.parametrize(
    "approval",
    [
        pytest.param(bytes((1, 0, 0, 0)), id="state-one"),
        pytest.param(bytes((3, 0, 0, 0)), id="state-three"),
        pytest.param(bytes((255, 0, 0, 0)), id="state-unknown"),
    ],
)
def test_run_key_status_fails_closed_for_disabled_startup_approval(
    approval: bytes,
) -> None:
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: r'"C:\Amphi\amphi-autostart.exe" server start',
        read_approval=lambda: approval,
    )

    status = supervisor.status()

    assert status.enabled is False
    assert "disabled in Windows Startup Apps" in (status.detail or "")
    assert f"state {approval[0]}" in (status.detail or "")


def test_run_key_status_fails_closed_when_startup_approval_query_fails() -> None:
    def read_approval() -> bytes | None:
        raise OSError("registry access denied")

    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: r'"C:\Amphi\amphi-autostart.exe" server start',
        read_approval=read_approval,
    )

    status = supervisor.status()

    assert status.enabled is False
    assert "could not read Windows StartupApproved state" in (status.detail or "")
    assert "registry access denied" in (status.detail or "")


def test_run_key_enable_fails_when_startup_approval_cannot_be_restored(
    tmp_path: Path,
) -> None:
    values: dict[str, str] = {}

    def fail_approval_reset() -> None:
        raise OSError("registry access denied")

    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: values.get(RUN_VALUE_NAME),
        write_value=lambda command: values.__setitem__(RUN_VALUE_NAME, command),
        read_approval=lambda: bytes((3, 0, 0, 0)),
        enable_approval=fail_approval_reset,
    )
    spec = ServeCommand(
        executable=tmp_path / "amphi-autostart.exe",
        frozen=True,
        platform="win32",
    ).start("127.0.0.1", 7421)
    spec.executable.touch()

    with pytest.raises(SupervisorError, match="StartupApproved"):
        supervisor.enable(spec)

    # Registration may have been written, but it must never be reported as an
    # effective successful enable while Windows still blocks it.
    assert RUN_VALUE_NAME in values
    assert supervisor.status().enabled is False


def test_run_key_supervisor_rejects_a_missing_launcher(tmp_path: Path) -> None:
    supervisor = RunKeySupervisor(
        platform="win32",
        read_value=lambda: None,
        write_value=lambda _command: None,
    )
    spec = ServeCommand(
        executable=tmp_path / "amphi.exe",
        frozen=True,
        platform="win32",
    ).start("127.0.0.1", 7421)

    with pytest.raises(SupervisorError, match="autostart launcher is missing"):
        supervisor.enable(spec)


def test_run_key_supervisor_reports_unsupported_platform_without_registry() -> None:
    supervisor = RunKeySupervisor(
        platform="darwin",
        read_value=lambda: (_ for _ in ()).throw(
            AssertionError("registry must not be read")
        ),
    )

    status = supervisor.status()

    assert status.supported is False
    assert status.enabled is False
    with pytest.raises(UnsupportedSupervisor):
        supervisor.enable(
            ServeCommand(executable="/runtime/amphi", frozen=True).start(
                "127.0.0.1",
                7421,
            )
        )
