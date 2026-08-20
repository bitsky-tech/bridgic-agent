import asyncio
import os
import signal
from types import SimpleNamespace

import pytest

import src.amphi_agent.runtime._shell_env as shell_env_module
from src.amphi_agent.runtime._environment import AgentCLIShim
from src.amphi_agent.runtime._shell_env import (
    LoginShellProbeTimeoutError,
    UserLoginShellEnvironment,
)
from src.amphi_agent.runtime._windows_env import (
    WindowsUserEnvironment,
    WindowsUserEnvironmentError,
)
from tests._support.sandbox import IsolatedPaths


class _CompletedProcess:
    def __init__(self, stdout: bytes) -> None:
        self.pid = 731
        self.returncode = 0
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()

    async def wait(self) -> int:
        return self.returncode


def _login_probe(paths: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> UserLoginShellEnvironment:
    home = paths.home / "login-user"
    home.mkdir(parents=True)
    shell = paths.root / "fake-bin" / "bash"
    shell.parent.mkdir()
    shell.write_text("unused", encoding="utf-8")
    probe = UserLoginShellEnvironment(
        environ={
            "PATH": "/daemon/private/bin",
            "VIRTUAL_ENV": "/daemon/venv",
            "APP_PRIVATE_TOKEN": "do-not-copy",
            "TMPDIR": str(paths.root / "tmp"),
            "LANG": "en_US.UTF-8",
        },
        uid=4242,
    )
    identity = shell_env_module._LoginIdentity(
        name="probe-user",
        home=home,
        shell=shell,
    )
    monkeypatch.setattr(probe, "_resolve_identity", lambda: identity)
    return probe


@pytest.mark.skipif(os.name == "nt", reason="POSIX login-shell contract")
async def test_login_capture(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final POSIX login environment:

    {
      "probe_seed": {"PATH": "system default", "daemon_secrets": "absent"},
      "captured": {"PATH": "/user/bin:/usr/bin", "COMPLEX": "line one\\nline=two"},
      "transient_shell_state": "removed"
    }

    Checks:
    1. The login shell starts in login mode with a minimal identity seed instead of daemon state.
    2. Parsing ignores startup chatter, keeps exported values, and removes transient fields.
    """
    probe = _login_probe(test_sandbox, monkeypatch)
    monkeypatch.setattr(shell_env_module.secrets, "token_hex", lambda _size: "marker42")
    captured: dict[str, object] = {}
    stdout = (
        b"plugin startup chatter\n"
        b"\0marker42\0"
        b"HOME=/shell/override\0"
        b"PATH=/user/bin:/usr/bin\0"
        b"COMPLEX=line one\nline=two\0"
        b"PWD=/work\0OLDPWD=/before\0SHLVL=2\0_=/usr/bin/env\0"
    )

    async def create_process(*argv: str, **kwargs: object) -> _CompletedProcess:
        captured["argv"] = argv
        captured.update(kwargs)
        return _CompletedProcess(stdout)

    monkeypatch.setattr(shell_env_module.asyncio, "create_subprocess_exec", create_process)
    result = await probe.capture()

    # Check 1: Login startup receives only stable identity, locale, and system defaults.
    argv = captured["argv"]
    assert isinstance(argv, tuple)
    assert argv[:3] == (str(test_sandbox.root / "fake-bin" / "bash"), "-l", "-i")
    assert argv[3] == "-c"
    assert "marker42" in argv[4]
    seed = captured["env"]
    assert isinstance(seed, dict)
    assert seed == {
        "HOME": str(test_sandbox.home / "login-user"),
        "USER": "probe-user",
        "LOGNAME": "probe-user",
        "SHELL": str(test_sandbox.root / "fake-bin" / "bash"),
        "PATH": os.defpath,
        "TERM": "xterm-256color",
        "TMPDIR": str(test_sandbox.root / "tmp"),
        "LANG": "en_US.UTF-8",
    }
    assert captured["start_new_session"] is True
    assert captured["cwd"] == str(test_sandbox.home / "login-user")
    assert "APP_PRIVATE_TOKEN" not in seed
    assert "VIRTUAL_ENV" not in seed

    # Check 2: Only the marker-delimited exported environment survives normalization.
    assert result == {
        "HOME": str(test_sandbox.home / "login-user"),
        "USER": "probe-user",
        "LOGNAME": "probe-user",
        "SHELL": str(test_sandbox.root / "fake-bin" / "bash"),
        "PATH": "/user/bin:/usr/bin",
        "COMPLEX": "line one\nline=two",
    }


@pytest.mark.skipif(os.name == "nt", reason="POSIX login-shell contract")
@pytest.mark.timeout(2)
async def test_login_timeout(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final stalled login probe:

    {
      "deadline": "bounded",
      "process_group": "terminated",
      "result": "LoginShellProbeTimeoutError"
    }

    Checks:
    1. Capture enforces its caller-supplied timeout while output remains stalled.
    2. Timeout terminates the isolated process group before returning the error.
    """
    probe = _login_probe(test_sandbox, monkeypatch)
    process = SimpleNamespace(pid=947, returncode=None)
    killed: list[int] = []

    async def create_process(*_argv: str, **_kwargs: object) -> SimpleNamespace:
        return process

    async def stalled_output(_cls: type, _process: object) -> tuple[bytes, bytes]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def kill_process(target: SimpleNamespace) -> None:
        killed.append(target.pid)
        target.returncode = -signal.SIGKILL

    monkeypatch.setattr(shell_env_module.asyncio, "create_subprocess_exec", create_process)
    monkeypatch.setattr(UserLoginShellEnvironment, "_read_process_output", classmethod(stalled_output))
    monkeypatch.setattr(UserLoginShellEnvironment, "_kill_process_group", staticmethod(kill_process))

    # Check 1: The pending reader cannot outlive the explicit capture deadline.
    with pytest.raises(LoginShellProbeTimeoutError, match="did not initialize"):
        await probe.capture(timeout_seconds=0.01)

    # Check 2: Timeout cleanup targets the child process group exactly once.
    assert killed == [947]
    assert process.returncode == -signal.SIGKILL


@pytest.mark.windows_runtime
def test_windows_environment() -> None:
    """Final normalized Windows environment:

    {
      "names": "uppercase and case-insensitive",
      "duplicates": "last value wins",
      "values_with_equals": "preserved",
      "drive_working_directory": "private record ignored"
    }

    Checks:
    1. Native records normalize into one case-insensitive environment mapping.
    2. Values preserve Unicode, emptiness, and embedded equals signs.
    """
    records = [
        r"Path=C:\Windows\System32;C:\Users\测试\bin",
        "AMPHI_COMPLEX=first=second=third",
        "MiXeD=old",
        "MIXED=updated",
        "UNICODE=环境正常🙂",
        "EMPTY=",
        r"=C:=C:\workspace",
    ]
    result = WindowsUserEnvironment(block_reader=lambda: records).capture()

    # Check 1: Case folding and private drive records produce stable public names.
    assert result["PATH"] == r"C:\Windows\System32;C:\Users\测试\bin"
    assert result["MIXED"] == "updated"
    assert "=C:" not in result

    # Check 2: Record splitting occurs only at the first equals sign and preserves values.
    assert result["AMPHI_COMPLEX"] == "first=second=third"
    assert result["UNICODE"] == "环境正常🙂"
    assert result["EMPTY"] == ""


@pytest.mark.windows_runtime
def test_windows_malformed() -> None:
    """Final malformed Windows environment:

    {
      "record": "BROKEN",
      "partial_environment": "discarded",
      "result": "WindowsUserEnvironmentError"
    }

    Checks:
    1. One malformed native record rejects the entire captured block.
    2. An empty block is rejected instead of becoming an empty command environment.
    """
    # Check 1: A partial valid prefix cannot hide a malformed trailing record.
    with pytest.raises(WindowsUserEnvironmentError, match="malformed record"):
        WindowsUserEnvironment(block_reader=lambda: ["PATH=C:\\Windows", "BROKEN"]).capture()

    # Check 2: No-variable capture fails closed at the adapter boundary.
    with pytest.raises(WindowsUserEnvironmentError, match="contained no variables"):
        WindowsUserEnvironment(block_reader=lambda: []).capture()


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink contract")
def test_cli_posix(test_sandbox: IsolatedPaths) -> None:
    """Final POSIX CLI shim:

    {
      "command": "amphi",
      "kind": "symlink",
      "target": "current daemon launcher",
      "temporary_entries": []
    }

    Checks:
    1. The command resolves directly to the supplied daemon launcher.
    2. Atomic preparation leaves no temporary shim entry behind.
    """
    launcher = test_sandbox.root / "daemon" / "amphi"
    launcher.parent.mkdir()
    launcher.write_text("launcher", encoding="utf-8")
    shim = AgentCLIShim(test_sandbox.root / "posix-shims", platform="posix")
    assert shim.prepare(launcher) == shim.root
    command = shim.root / "amphi"

    # Check 1: POSIX commands use an absolute symlink to the current launcher.
    assert command.is_symlink()
    assert command.resolve() == launcher.resolve()

    # Check 2: The published command is the only filesystem entry.
    assert {path.name for path in shim.root.iterdir()} == {"amphi"}


@pytest.mark.windows_runtime
def test_cli_windows(test_sandbox: IsolatedPaths) -> None:
    """Final Windows CLI shim:

    {
      "command": "amphi.cmd",
      "launcher_source": "%AMPHI_AGENT_CLI_LAUNCHER%",
      "arguments": "%*",
      "encoding": "ASCII with CRLF"
    }

    Checks:
    1. The forwarder reads the launcher from the daemon-owned environment variable.
    2. It forwards every argument and publishes no path-specific temporary file.
    """
    launcher = test_sandbox.root / "包含空格%SDK%" / "amphi.exe"
    launcher.parent.mkdir()
    launcher.write_text("launcher", encoding="utf-8")
    shim = AgentCLIShim(test_sandbox.root / "windows-shims", platform="nt")
    assert shim.prepare(launcher) == shim.root
    content = (shim.root / "amphi.cmd").read_bytes()

    # Check 1: The stable environment indirection avoids quoting the install path into the file.
    assert content == b'@echo off\r\n"%AMPHI_AGENT_CLI_LAUNCHER%" %*\r\n'

    # Check 2: Only the final forwarding command remains after atomic replacement.
    assert {path.name for path in shim.root.iterdir()} == {"amphi.cmd"}
