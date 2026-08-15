"""Isolated coverage for the POSIX login-shell environment probe."""

import asyncio
import os
import signal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

import src.amphi_agent.runtime._shell_env as shell_env_module
from src.amphi_agent.runtime._shell_env import (
    MAX_PROBE_OUTPUT_BYTES,
    LoginShellProbeError,
    LoginShellProbeOutputLimitError,
    LoginShellProbeTimeoutError,
    LoginShellResolutionError,
    UnsupportedLoginShellError,
    UserLoginShellEnvironment,
)


pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX login shells only")


def _bind_passwd(
    monkeypatch: pytest.MonkeyPatch,
    *,
    home: Path,
    shell: str,
    name: str = "probe-user",
    uid: int = 4242,
) -> None:
    record = SimpleNamespace(pw_name=name, pw_dir=str(home), pw_shell=shell)
    monkeypatch.setattr(
        shell_env_module,
        "_pwd",
        SimpleNamespace(getpwuid=lambda requested: record if requested == uid else None),
    )


class _CompletedProcess:
    def __init__(
        self,
        stdout: bytes,
        stderr: bytes = b"",
        *,
        returncode: int = 0,
        pid: int = 731,
    ) -> None:
        self.pid = pid
        self.returncode = returncode
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(stderr)
        self.stderr.feed_eof()
        self.wait = AsyncMock(return_value=returncode)

    def kill(self) -> None:
        self.returncode = -signal.SIGKILL


class _PendingProcess:
    def __init__(self, *, pid: int = 947) -> None:
        self.pid = pid
        self.returncode = None
        self.started = asyncio.Event()
        self.stdout = self._PendingStream(self.started)
        self.stderr = self._PendingStream(self.started)
        self.wait = AsyncMock()

    class _PendingStream:
        def __init__(self, started: asyncio.Event) -> None:
            self.started = started

        async def read(self, _size: int) -> bytes:
            self.started.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    def kill(self) -> None:
        self.returncode = -signal.SIGKILL


class _FailingStream:
    async def read(self, _size: int) -> bytes:
        raise OSError("probe pipe failed")


async def test_capture_uses_clean_seed_and_ignores_startup_chatter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    _bind_passwd(monkeypatch, home=home, shell="/bin/bash")
    monkeypatch.setattr(shell_env_module.secrets, "token_hex", lambda _size: "marker42")
    captured: dict[str, object] = {}
    stdout = (
        b"plugin startup chatter\n"
        b"\0marker42\0"
        b"HOME=/captured/home\0"
        b"PATH=/captured/bin:/usr/bin\0"
        b"COMPLEX=line one\nline=two\0"
        b"PWD=/captured/home\0OLDPWD=/before\0SHLVL=2\0_=/usr/bin/env\0"
    )

    async def fake_create_subprocess_exec(*argv, **kwargs):
        captured["argv"] = argv
        captured.update(kwargs)
        return _CompletedProcess(stdout)

    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )
    environment = {
        "PATH": "/daemon/private/bin",
        "VIRTUAL_ENV": "/daemon/venv",
        "APP_PRIVATE_TOKEN": "do-not-copy",
        "HTTP_PROXY": "http://private-proxy",
        "TERM": "dumb",
        "TMPDIR": str(tmp_path / "tmp"),
        "LANG": "en_US.UTF-8",
        "LC_CTYPE": "en_US.UTF-8",
    }

    result = await UserLoginShellEnvironment(
        environ=environment, uid=4242,
    ).capture()

    argv = captured["argv"]
    assert argv[:4] == ("/bin/bash", "-l", "-i", "-c")
    assert "/usr/bin/printf '\\000%s\\000' 'marker42'" in argv[4]
    assert argv[4].endswith("exec /usr/bin/env -0")
    assert captured["stdin"] is asyncio.subprocess.DEVNULL
    assert captured["stdout"] is asyncio.subprocess.PIPE
    assert captured["stderr"] is asyncio.subprocess.PIPE
    assert captured["cwd"] == str(home)
    assert captured["start_new_session"] is True
    assert captured["env"] == {
        "HOME": str(home),
        "USER": "probe-user",
        "LOGNAME": "probe-user",
        "SHELL": "/bin/bash",
        "PATH": os.defpath,
        "TERM": "xterm-256color",
        "TMPDIR": str(tmp_path / "tmp"),
        "LANG": "en_US.UTF-8",
        "LC_CTYPE": "en_US.UTF-8",
    }
    assert result == {
        "HOME": str(home),
        "USER": "probe-user",
        "LOGNAME": "probe-user",
        "SHELL": "/bin/bash",
        "PATH": "/captured/bin:/usr/bin",
        "COMPLEX": "line one\nline=two",
    }


async def test_real_bash_probe_reads_only_the_temporary_login_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "isolated-home"
    home.mkdir()
    profile = home / ".bash_profile"
    profile.write_text(
        "printf 'profile chatter\\n'\n"
        "export HOME='/profile/override' USER='fake-user' LOGNAME='fake-logname'\n"
        "export SHELL='/profile/fake-shell'\n"
        "export AMPHI_LOGIN_PROBE='from temporary profile'\n"
        "export AMPHI_COMPLEX_VALUE='first line\nsecond=line'\n",
        encoding="utf-8",
    )
    _bind_passwd(monkeypatch, home=home, shell="/bin/bash")

    probe = UserLoginShellEnvironment(
        environ={"TERM": "dumb", "TMPDIR": str(tmp_path)}, uid=4242,
    )
    result = await probe.capture()

    assert result["HOME"] == str(home)
    assert result["USER"] == "probe-user"
    assert result["LOGNAME"] == "probe-user"
    assert result["SHELL"] == "/bin/bash"
    assert result["AMPHI_LOGIN_PROBE"] == "from temporary profile"
    assert result["AMPHI_COMPLEX_VALUE"] == "first line\nsecond=line"
    assert {"PWD", "OLDPWD", "SHLVL", "_"}.isdisjoint(result)

    profile.write_text(
        "export AMPHI_LOGIN_PROBE='updated without restarting'\n",
        encoding="utf-8",
    )
    refreshed = await probe.capture()

    assert refreshed["AMPHI_LOGIN_PROBE"] == "updated without restarting"


@pytest.mark.skipif(not Path("/bin/zsh").is_file(), reason="requires zsh")
async def test_real_zsh_probe_uses_a_stable_terminal_type(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "isolated-zsh-home"
    home.mkdir()
    (home / ".zshrc").write_text(
        "if [[ $TERM == xterm-256color ]]; then\n"
        "  export AMPHI_ZSH_LOGIN_PROBE='terminal config loaded'\n"
        "fi\n",
        encoding="utf-8",
    )
    _bind_passwd(monkeypatch, home=home, shell="/bin/zsh")

    result = await UserLoginShellEnvironment(
        environ={"TERM": "dumb", "TMPDIR": str(tmp_path)}, uid=4242,
    ).capture()

    assert result["TERM"] == "xterm-256color"
    assert result["AMPHI_ZSH_LOGIN_PROBE"] == "terminal config loaded"


@pytest.mark.parametrize(
    ("shell", "expected_options"),
    [
        ("/bin/bash", ("-l", "-i", "-c")),
        ("/bin/zsh", ("-l", "-i", "-c")),
        ("/bin/sh", ("-l", "-i", "-c")),
        ("/bin/dash", ("-l", "-i", "-c")),
        ("/bin/ksh", ("-l", "-i", "-c")),
        ("/usr/local/bin/fish", ("--login", "--interactive", "--command")),
    ],
)
def test_supported_shells_use_family_specific_login_arguments(
    shell: str, expected_options: tuple[str, ...],
) -> None:
    argv = UserLoginShellEnvironment._probe_argv(Path(shell), "probe-command")

    assert argv == (shell, *expected_options, "probe-command")


async def test_valid_unknown_login_shell_is_not_replaced_with_bash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    unknown_shell = tmp_path / "nushell"
    unknown_shell.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    unknown_shell.chmod(0o755)
    _bind_passwd(monkeypatch, home=home, shell=str(unknown_shell))
    create_subprocess = AsyncMock()
    monkeypatch.setattr(
        shell_env_module.asyncio, "create_subprocess_exec", create_subprocess,
    )

    with pytest.raises(UnsupportedLoginShellError, match="Unsupported login shell"):
        await UserLoginShellEnvironment(
            environ={"SHELL": "/bin/bash"}, uid=4242,
        ).capture()

    create_subprocess.assert_not_awaited()


async def test_missing_passwd_shell_uses_valid_environment_shell(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    shell = tmp_path / "bash"
    shell.symlink_to("/bin/bash")
    _bind_passwd(monkeypatch, home=home, shell="")
    monkeypatch.setattr(shell_env_module.secrets, "token_hex", lambda _size: "fallback")
    captured: dict[str, object] = {}

    async def fake_create_subprocess_exec(*argv, **kwargs):
        captured["argv"] = argv
        captured["env"] = kwargs["env"]
        return _CompletedProcess(b"\0fallback\0FALLBACK=environment\0")

    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    result = await UserLoginShellEnvironment(
        environ={"SHELL": str(shell)}, uid=4242,
    ).capture()

    assert captured["argv"][0] == str(shell)
    assert captured["env"]["SHELL"] == str(shell)
    assert result == {
        "FALLBACK": "environment",
        "HOME": str(home),
        "USER": "probe-user",
        "LOGNAME": "probe-user",
        "SHELL": str(shell),
    }


async def test_invalid_shell_candidates_fall_back_to_system_bash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    _bind_passwd(monkeypatch, home=home, shell="relative-shell")
    monkeypatch.setattr(shell_env_module.secrets, "token_hex", lambda _size: "system")
    captured: dict[str, object] = {}

    async def fake_create_subprocess_exec(*argv, **kwargs):
        captured["argv"] = argv
        return _CompletedProcess(b"\0system\0SOURCE=system-bash\0")

    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    result = await UserLoginShellEnvironment(
        environ={"SHELL": "/missing/shell"}, uid=4242,
    ).capture()

    assert captured["argv"][0] == "/bin/bash"
    assert result == {
        "SOURCE": "system-bash",
        "HOME": str(home),
        "USER": "probe-user",
        "LOGNAME": "probe-user",
        "SHELL": "/bin/bash",
    }


async def test_invalid_passwd_identity_fails_before_spawning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing_home = tmp_path / "missing"
    _bind_passwd(monkeypatch, home=missing_home, shell="/bin/bash")
    create_subprocess = AsyncMock()
    monkeypatch.setattr(
        shell_env_module.asyncio, "create_subprocess_exec", create_subprocess,
    )

    with pytest.raises(LoginShellResolutionError, match="home directory"):
        await UserLoginShellEnvironment(uid=4242).capture()

    create_subprocess.assert_not_awaited()


async def test_nonzero_and_malformed_probe_results_are_controlled_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    _bind_passwd(monkeypatch, home=home, shell="/bin/bash")
    results = [
        _CompletedProcess(b"", b"broken profile", returncode=12),
        _CompletedProcess(b"startup only", returncode=0),
    ]

    async def fake_create_subprocess_exec(*_argv, **_kwargs):
        return results.pop(0)

    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    with pytest.raises(LoginShellProbeError, match="exit code 12: broken profile"):
        await UserLoginShellEnvironment(uid=4242).capture()
    with pytest.raises(LoginShellProbeError, match="without publishing"):
        await UserLoginShellEnvironment(uid=4242).capture()


async def test_probe_timeout_kills_and_reaps_the_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    _bind_passwd(monkeypatch, home=home, shell="/bin/bash")
    process = _PendingProcess()
    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        AsyncMock(return_value=process),
    )
    killpg = Mock()

    def record_killpg(pid: int, sig: signal.Signals) -> None:
        killpg(pid, sig)

    monkeypatch.setattr(shell_env_module.os, "killpg", record_killpg)

    with pytest.raises(LoginShellProbeTimeoutError, match="within 0.01s"):
        await UserLoginShellEnvironment(uid=4242).capture(timeout_seconds=0.01)

    killpg.assert_called_once_with(process.pid, signal.SIGKILL)
    process.wait.assert_awaited_once()


async def test_probe_output_limit_kills_and_reaps_the_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    _bind_passwd(monkeypatch, home=home, shell="/bin/bash")
    process = _CompletedProcess(b"x" * (MAX_PROBE_OUTPUT_BYTES + 1))
    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        AsyncMock(return_value=process),
    )
    killpg = Mock()
    monkeypatch.setattr(shell_env_module.os, "killpg", killpg)

    with pytest.raises(LoginShellProbeOutputLimitError, match="stdout exceeded"):
        await UserLoginShellEnvironment(uid=4242).capture()

    killpg.assert_called_once_with(process.pid, signal.SIGKILL)
    process.wait.assert_awaited()


async def test_probe_cancellation_kills_and_reaps_the_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    _bind_passwd(monkeypatch, home=home, shell="/bin/bash")
    process = _PendingProcess()
    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        AsyncMock(return_value=process),
    )
    killed: list[tuple[int, signal.Signals]] = []
    monkeypatch.setattr(
        shell_env_module.os,
        "killpg",
        lambda pid, sig: killed.append((pid, sig)),
    )

    task = asyncio.create_task(
        UserLoginShellEnvironment(uid=4242).capture(timeout_seconds=30),
    )
    await process.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert killed == [(process.pid, signal.SIGKILL)]
    process.wait.assert_awaited_once()


async def test_probe_pipe_failure_kills_and_reaps_the_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    _bind_passwd(monkeypatch, home=home, shell="/bin/bash")
    process = _CompletedProcess(b"")
    process.stdout = _FailingStream()
    monkeypatch.setattr(
        shell_env_module.asyncio,
        "create_subprocess_exec",
        AsyncMock(return_value=process),
    )
    killpg = Mock()
    monkeypatch.setattr(shell_env_module.os, "killpg", killpg)

    with pytest.raises(OSError, match="probe pipe failed"):
        await UserLoginShellEnvironment(uid=4242).capture()

    killpg.assert_called_once_with(process.pid, signal.SIGKILL)
    process.wait.assert_awaited_once()


@pytest.mark.parametrize("timeout", [0, -1, float("inf"), float("nan"), True])
async def test_probe_timeout_must_be_positive_and_finite(timeout) -> None:
    with pytest.raises(ValueError, match="positive finite"):
        await UserLoginShellEnvironment().capture(timeout_seconds=timeout)
