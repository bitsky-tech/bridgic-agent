"""Unit coverage for the self-contained bash tool (tools/_bash.py)."""

import asyncio
import inspect
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools._bash import (
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    _decode_shell_output,
    bash,
    bash_tool,
    current_execution_mode,
    current_tool_call_id,
)
from bridgic.amphibious.builtin_tools import current_agent


def test_bash_default_timeout_is_thirty_minutes() -> None:
    """The Bash tool defaults to the full supported 30-minute window."""
    assert DEFAULT_TIMEOUT_MS == 30 * 60 * 1000
    assert MAX_TIMEOUT_MS == DEFAULT_TIMEOUT_MS
    assert inspect.signature(bash).parameters["timeout"].default == DEFAULT_TIMEOUT_MS
    timeout_schema = bash_tool.to_tool().parameters["properties"]["timeout"]
    assert timeout_schema["default"] == DEFAULT_TIMEOUT_MS


@pytest.fixture
async def active_workspace(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """Bind a Workspace without letting tests execute the user's dotfiles."""
    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session-active")
    await workspace.prepare_workspace()
    static_env = workspace.env
    monkeypatch.setattr(
        workspace.environment,
        "bash_env",
        AsyncMock(side_effect=lambda *_args, **_kwargs: dict(static_env)),
        raising=False,
    )
    token = current_agent.set(SimpleNamespace(
        ctx=SimpleNamespace(
            workspace=workspace,
            session=SimpleNamespace(id="session-active"),
        )
    ))
    try:
        yield workspace
    finally:
        current_agent.reset(token)


async def test_bash_execution_semantics(active_workspace: Workspace) -> None:
    """stdout returned verbatim; non-zero exit raises with stderr; an empty
    command is rejected; oversized output is returned without data loss."""
    cwd = str(active_workspace.work_dir)
    assert await bash("printf 'hello'", cwd) == "hello"

    with pytest.raises(RuntimeError, match="exit code 3.*boom"):
        await bash("echo boom >&2; exit 3", cwd)

    with pytest.raises(ValueError):
        await bash("   ", cwd)

    large_size = 30_050
    out = await bash(f"printf 'x%.0s' $(seq 1 {large_size})", cwd)
    assert out == "x" * large_size

    with pytest.raises(RuntimeError) as failure:
        await bash(f"printf 'e%.0s' $(seq 1 {large_size}) >&2; exit 4", cwd)
    assert str(failure.value) == f"Command failed with exit code 4: {'e' * large_size}"


async def test_bash_requires_explicit_absolute_cwd_and_cancels_process_tree(
    active_workspace: Workspace,
) -> None:
    """The selected cwd is literal and cancellation kills the process tree."""
    work_dir = active_workspace.work_dir
    with pytest.raises(ValueError, match="cwd is required"):
        await bash("pwd", "")
    with pytest.raises(ValueError, match="cwd must be an absolute"):
        await bash("pwd", ".build")
    assert (await bash("pwd", str(work_dir))).strip() == str(work_dir.resolve())

    with pytest.raises(NotADirectoryError):
        await bash("pwd", "/nonexistent/definitely-not-here")

    # Cancelling mid-run kills the child: the marker never gets touched.
    marker = work_dir / "born"
    task = asyncio.create_task(bash(f"sleep 0.5 && touch {marker}", str(work_dir)))
    await asyncio.sleep(0.1)  # let the subprocess spawn
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.7)  # past the child's sleep — were it alive…
    assert not marker.exists()

    # Cancellation owns the shell's process group, including background grandchildren.
    grandchild_marker = work_dir / "grandchild-born"
    grandchild = asyncio.create_task(
        bash(f"(sleep 0.4; touch {grandchild_marker}) & wait", str(work_dir)),
    )
    await asyncio.sleep(0.05)
    grandchild.cancel()
    with pytest.raises(asyncio.CancelledError):
        await grandchild
    await asyncio.sleep(0.5)
    assert not grandchild_marker.exists()


async def test_bash_requires_active_workspace(
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A valid command must not spawn without the current Agent's Workspace."""
    create_subprocess = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)
    token = current_agent.set(
        SimpleNamespace(ctx=SimpleNamespace(session=SimpleNamespace(id="session-missing")))
    )
    try:
        with pytest.raises(RuntimeError, match="active Agent Workspace"):
            await bash("echo unreachable", str(tmp_path))
    finally:
        current_agent.reset(token)
    create_subprocess.assert_not_awaited()


async def test_bash_awaits_workspace_env_and_injects_rpc_context(
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """POSIX Bash injects its Session, call, and admitted execution mode."""
    import src.amphi_agent.tools._bash as bash_module

    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    monkeypatch.setattr(bash_module, "_IS_WINDOWS", False)
    workspace = Workspace("session_abc")
    await workspace.prepare_workspace()
    session_root = workspace.session_root
    work_dir = workspace.work_dir
    expected_env = workspace.env
    expected_env["LOGIN_SHELL_MARKER"] = "fresh"
    expected_env["EXECUTION_MODE"] = "request"
    bash_env = AsyncMock(
        side_effect=lambda *_args, **_kwargs: dict(expected_env),
    )
    monkeypatch.setattr(
        workspace.environment,
        "bash_env",
        bash_env,
        raising=False,
    )

    captured: dict = {}

    async def fake_create_subprocess_exec(*argv, **kwargs):
        captured["argv"] = argv
        captured.update(kwargs)
        proc = AsyncMock()
        proc.communicate = AsyncMock(return_value=(b"ok\n", b""))
        proc.returncode = 0
        proc.kill = AsyncMock()
        proc.wait = AsyncMock()
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    agent = SimpleNamespace(
        ctx=SimpleNamespace(
            workspace=workspace,
            session=SimpleNamespace(id="session-child", workspace_root=str(session_root)),
        )
    )
    token = current_agent.set(agent)
    call_token = current_tool_call_id.set("call-bash")
    mode_token = current_execution_mode.set("full")
    try:
        assert await bash("echo hi", str(work_dir)) == "ok\n"
    finally:
        current_execution_mode.reset(mode_token)
        current_tool_call_id.reset(call_token)
        current_agent.reset(token)

    assert captured["cwd"] == str(work_dir.resolve())
    assert captured["argv"] == ("/bin/bash", "-c", "echo hi")
    bash_env.assert_awaited_once()
    env = captured["env"]
    assert "VIRTUAL_ENV" not in env
    assert "UV_PROJECT" not in env
    assert "UV_PROJECT_ENVIRONMENT" not in env
    assert env["PATH"] == expected_env["PATH"]
    assert env["LOGIN_SHELL_MARKER"] == "fresh"
    assert env["SESSION_ID"] == "session-child"
    assert env["PARENT_TOOL_CALL_ID"] == "call-bash"
    assert env["EXECUTION_MODE"] == "full"


@pytest.mark.parametrize("is_windows", [False, True])
async def test_bash_environment_refresh_consumes_the_command_timeout(
    active_workspace: Workspace,
    monkeypatch: pytest.MonkeyPatch,
    is_windows: bool,
) -> None:
    """A slow environment refresh cannot extend the caller's total budget."""
    import src.amphi_agent.tools._bash as bash_module

    monkeypatch.setattr(bash_module, "_IS_WINDOWS", is_windows)

    async def slow_bash_env(*, timeout_seconds: float) -> dict[str, str]:
        assert timeout_seconds <= 0.001
        await asyncio.sleep(0.01)
        return active_workspace.env

    monkeypatch.setattr(active_workspace.environment, "bash_env", slow_bash_env)
    create_subprocess = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)

    with pytest.raises(TimeoutError, match="before the shell started"):
        await bash("echo unreachable", str(active_workspace.work_dir), timeout=1)

    create_subprocess.assert_not_awaited()


async def test_bash_uses_windows_powershell_argv(
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Windows refreshes the user env before invoking PowerShell directly."""
    import src.amphi_agent.tools._bash as bash_module

    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    monkeypatch.setattr(bash_module, "_IS_WINDOWS", True)
    workspace = Workspace("session-windows")
    await workspace.prepare_workspace()
    refreshed_env = workspace.env
    refreshed_env["WINDOWS_ENV_MARKER"] = "fresh"
    bash_env = AsyncMock(
        side_effect=lambda *_args, **_kwargs: dict(refreshed_env),
    )
    monkeypatch.setattr(
        workspace.environment,
        "bash_env",
        bash_env,
        raising=False,
    )
    captured: dict = {}

    async def fake_create_subprocess_exec(*argv, **kwargs):
        captured["argv"] = argv
        captured.update(kwargs)
        proc = AsyncMock()
        proc.communicate = AsyncMock(return_value=("你好\n".encode(), b""))
        proc.returncode = 0
        proc.wait = AsyncMock()
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    token = current_agent.set(
        SimpleNamespace(
            ctx=SimpleNamespace(
                workspace=workspace,
                session=SimpleNamespace(id="session-windows"),
            )
        )
    )
    try:
        assert await bash("Get-ChildItem .", str(workspace.work_dir)) == "你好\n"
    finally:
        current_agent.reset(token)

    argv = captured["argv"]
    assert argv[:5] == (
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
    )
    assert "Get-ChildItem ." in argv[5]
    assert "[Console]::InputEncoding = $utf8" in argv[5]
    assert "[Console]::OutputEncoding = $utf8" in argv[5]
    assert "$PSDefaultParameterValues['*:Encoding'] = 'utf8'" in argv[5]
    assert "Get-ChildItem .\nif (-not $?)" in argv[5]
    assert "& { Get-ChildItem ." not in argv[5]
    assert captured["cwd"] == str(workspace.work_dir.resolve())
    assert captured["env"]["SESSION_ID"] == "session-windows"
    assert captured["env"]["WINDOWS_ENV_MARKER"] == "fresh"
    assert captured["env"]["PYTHONUTF8"] == "1"
    assert captured["env"]["PYTHONIOENCODING"] == "utf-8"
    bash_env.assert_awaited_once()
    assert 0 < bash_env.await_args.kwargs["timeout_seconds"] <= 5


@pytest.mark.skipif(os.name != "nt", reason="requires Windows PowerShell")
async def test_bash_windows_preserves_failure_code_and_stderr(
    active_workspace: Workspace,
) -> None:
    """PowerShell must not turn a failed native command into empty success."""
    cwd = str(active_workspace.work_dir)

    with pytest.raises(RuntimeError) as native_failure:
        await bash(
            'cmd.exe /d /c "echo native-boom 1>&2 & exit /b 23"',
            cwd,
        )
    assert str(native_failure.value) == (
        "Command failed with exit code 23: native-boom"
    )

    with pytest.raises(RuntimeError) as powershell_failure:
        await bash("Get-Command definitely_missing_command_42", cwd)
    error = str(powershell_failure.value)
    assert error.startswith("Command failed with exit code 1:")
    assert "definitely_missing_command_42" in error


def test_bash_windows_output_falls_back_to_legacy_code_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Legacy native output is decoded without corrupting adjacent UTF-8 lines."""
    import src.amphi_agent.tools._bash as bash_module

    monkeypatch.setattr(bash_module, "_IS_WINDOWS", True)
    monkeypatch.setattr(bash_module, "_WINDOWS_FALLBACK_ENCODINGS", ("cp936",))
    output = "UTF-8 输出 🙂\n".encode() + "旧程序输出\n".encode("cp936")

    assert _decode_shell_output(output) == "UTF-8 输出 🙂\n旧程序输出\n"


async def test_bash_windows_timeout_terminates_process_tree(
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A timed-out Windows shell is terminated through taskkill's tree mode."""
    import src.amphi_agent.tools._bash as bash_module

    monkeypatch.setattr(bash_module, "_IS_WINDOWS", True)
    workspace = Workspace("session-windows-timeout", session_root=tmp_path)
    workspace.work_dir.mkdir()
    await asyncio.to_thread(workspace.environment.prepare)
    bash_env = AsyncMock(side_effect=lambda **_kwargs: workspace.env)
    monkeypatch.setattr(workspace.environment, "bash_env", bash_env)
    main_proc = AsyncMock()
    main_proc.pid = 42
    main_proc.returncode = None
    main_proc.communicate = AsyncMock(side_effect=asyncio.TimeoutError)
    main_proc.kill = Mock()
    main_proc.wait = AsyncMock()
    killer_proc = AsyncMock()
    killer_proc.wait = AsyncMock()
    calls: list[tuple[str, ...]] = []

    async def fake_create_subprocess_exec(*argv, **kwargs):
        calls.append(argv)
        return main_proc if len(calls) == 1 else killer_proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    token = current_agent.set(
        SimpleNamespace(
            ctx=SimpleNamespace(
                workspace=workspace,
                session=SimpleNamespace(id="session-windows-timeout"),
            )
        )
    )
    try:
        with pytest.raises(TimeoutError, match="timed out"):
            await bash("Start-Sleep -Seconds 30", str(workspace.work_dir), timeout=1)
    finally:
        current_agent.reset(token)

    assert calls[1] == ("taskkill.exe", "/PID", "42", "/T", "/F")
    bash_env.assert_awaited_once()
    main_proc.wait.assert_awaited_once()
