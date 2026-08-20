import asyncio
import os

import pytest

from src.amphi_agent.tools._bash import bash, current_execution_mode, current_tool_call_id
from tests.agent.tools._harness import ToolHarness


pytestmark = pytest.mark.windows_runtime


async def test_command_context(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final shell process:

    {
      "cwd": "<session>/.work",
      "BRIDGIC_MANAGED_RUNTIME_SENTINEL": "workspace-runtime-env",
      "SESSION_ID": "session-tools",
      "PARENT_TOOL_CALL_ID": "call-7",
      "EXECUTION_MODE": "build"
    }

    Checks:
    1. The command runs in the exact absolute directory selected by the caller.
    2. The managed runtime environment reaches the real shell child process.
    3. Agent identity and invocation metadata reach the child process.
    4. Captured stdout is returned without adding presentation text.
    """
    async def test_environment(*, timeout_seconds: float) -> dict[str, str]:
        assert timeout_seconds > 0
        env = os.environ.copy()
        env["BRIDGIC_MANAGED_RUNTIME_SENTINEL"] = "workspace-runtime-env"
        return env

    monkeypatch.setattr(tool_harness.workspace.environment, "bash_env", test_environment)
    call_token = current_tool_call_id.set("call-7")
    mode_token = current_execution_mode.set("build")
    command = (
        '[Console]::Write("$($PWD.Path)|$env:BRIDGIC_MANAGED_RUNTIME_SENTINEL|'
        '$env:SESSION_ID|$env:PARENT_TOOL_CALL_ID|$env:EXECUTION_MODE")'
        if os.name == "nt"
        else (
            "printf '%s|%s|%s|%s|%s' \"$PWD\" \"$BRIDGIC_MANAGED_RUNTIME_SENTINEL\" "
            "\"$SESSION_ID\" \"$PARENT_TOOL_CALL_ID\" \"$EXECUTION_MODE\""
        )
    )
    try:
        output = await bash(command, str(tool_harness.workspace.work_dir))
    finally:
        current_execution_mode.reset(mode_token)
        current_tool_call_id.reset(call_token)

    # Check 1: The command runs in the exact absolute directory selected by the caller.
    cwd, managed_runtime, session_id, call_id, mode = output.split("|")
    assert cwd == str(tool_harness.workspace.work_dir)

    # Check 2: The managed runtime environment reaches the real shell child process.
    assert managed_runtime == "workspace-runtime-env"

    # Check 3: Agent identity and invocation metadata reach the child process.
    assert (session_id, call_id, mode) == ("session-tools", "call-7", "build")

    # Check 4: Captured stdout is returned without adding presentation text.
    assert output == (
        f"{tool_harness.workspace.work_dir}|workspace-runtime-env|session-tools|call-7|build"
    )


async def test_command_failures(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final rejected commands:

    {
      "exit_9": "raises with stderr",
      "invalid_cwd": "rejected before spawn"
    }

    Checks:
    1. A non-zero process exit reports its code and stderr instead of returning false success.
    2. Empty commands and non-absolute working directories are rejected before execution.
    """
    async def test_environment(*, timeout_seconds: float) -> dict[str, str]:
        return os.environ.copy()

    monkeypatch.setattr(tool_harness.workspace.environment, "bash_env", test_environment)
    cwd = str(tool_harness.workspace.work_dir)

    failure_command = (
        'cmd.exe /d /s /c "echo command failed 1>&2 & exit /b 9"'
        if os.name == "nt"
        else "printf 'command failed' >&2; exit 9"
    )

    # Check 1: A non-zero process exit reports its code and stderr instead of returning false success.
    with pytest.raises(RuntimeError, match="exit code 9: command failed"):
        await bash(failure_command, cwd)
    if os.name == "nt":
        with pytest.raises(RuntimeError, match="exit code 1") as powershell_error:
            await bash("Get-Item 'missing-agent-test-path'", cwd)
        assert "missing-agent-test-path" in str(powershell_error.value)

    # Check 2: Empty commands and non-absolute working directories are rejected before execution.
    with pytest.raises(ValueError, match="command is required"):
        await bash("", cwd)
    with pytest.raises(ValueError, match="absolute"):
        await bash("pwd", ".")


async def test_command_termination(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Timeout and cancellation both terminate the complete descendant process tree."""
    async def test_environment(*, timeout_seconds: float) -> dict[str, str]:
        return os.environ.copy()

    def delayed_marker(name: str) -> str:
        if os.name != "nt":
            return f"/bin/bash -c 'printf started > {name}-started; sleep 2; printf survived > {name}'"
        return (
            'cmd.exe /d /s /c "'
            f"echo started>{name}-started & "
            "ping 127.0.0.1 -n 8 >nul & "
            f"echo survived>{name}"
            '"'
        )

    async def assert_marker_stays_absent(name: str) -> None:
        marker = tool_harness.workspace.work_dir / name
        deadline = asyncio.get_running_loop().time() + 2.25
        while asyncio.get_running_loop().time() < deadline:
            assert not marker.exists(), "A descendant survived after its shell was terminated"
            await asyncio.sleep(0.05)

    monkeypatch.setattr(tool_harness.workspace.environment, "bash_env", test_environment)
    cwd = str(tool_harness.workspace.work_dir)

    timeout_ms = 5_000 if os.name == "nt" else 1_500
    with pytest.raises(TimeoutError) as timeout:
        await bash(delayed_marker("timeout-marker.txt"), cwd, timeout=timeout_ms)
    assert str(timeout.value) == f"Command timed out after {timeout_ms}ms and was killed."
    assert (tool_harness.workspace.work_dir / "timeout-marker.txt-started").exists()
    await assert_marker_stays_absent("timeout-marker.txt")

    task = asyncio.create_task(bash(delayed_marker("cancel-marker.txt"), cwd))
    started = tool_harness.workspace.work_dir / "cancel-marker.txt-started"
    try:
        for _ in range(500):
            if started.exists() or task.done():
                break
            await asyncio.sleep(0.01)
        assert started.exists()
    except BaseException:
        task.cancel()
        try:
            await task
        except BaseException:
            pass
        raise
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await assert_marker_stays_absent("cancel-marker.txt")
