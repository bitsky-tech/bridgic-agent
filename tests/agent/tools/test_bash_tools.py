import asyncio
import os

import pytest

from src.amphi_agent.tools._bash import bash, current_execution_mode, current_tool_call_id
from tests.agent.tools._harness import ToolHarness


async def test_command_context(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final shell process:

    {
      "cwd": "<session>/.work",
      "SESSION_ID": "session-tools",
      "PARENT_TOOL_CALL_ID": "call-7",
      "EXECUTION_MODE": "build"
    }

    Checks:
    1. The command runs in the exact absolute directory selected by the caller.
    2. Agent identity and invocation metadata reach the child process.
    3. Captured stdout is returned without adding presentation text.
    """
    async def test_environment(*, timeout_seconds: float) -> dict[str, str]:
        assert timeout_seconds > 0
        return os.environ.copy()

    monkeypatch.setattr(tool_harness.workspace.environment, "bash_env", test_environment)
    call_token = current_tool_call_id.set("call-7")
    mode_token = current_execution_mode.set("build")
    try:
        output = await bash(
            "printf '%s|%s|%s|%s' \"$PWD\" \"$SESSION_ID\" \"$PARENT_TOOL_CALL_ID\" \"$EXECUTION_MODE\"",
            str(tool_harness.workspace.work_dir),
        )
    finally:
        current_execution_mode.reset(mode_token)
        current_tool_call_id.reset(call_token)

    # Check 1: The command runs in the exact absolute directory selected by the caller.
    cwd, session_id, call_id, mode = output.split("|")
    assert cwd == str(tool_harness.workspace.work_dir)

    # Check 2: Agent identity and invocation metadata reach the child process.
    assert (session_id, call_id, mode) == ("session-tools", "call-7", "build")

    # Check 3: Captured stdout is returned without adding presentation text.
    assert output == f"{tool_harness.workspace.work_dir}|session-tools|call-7|build"


async def test_command_failures(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final failed commands:

    {
      "exit_9": "raises with stderr",
      "timeout": "process killed",
      "invalid_cwd": "rejected before spawn"
    }

    Checks:
    1. A non-zero process exit reports its code and stderr instead of returning false success.
    2. A command exceeding its deadline is killed and raises a timeout error.
    3. Empty commands and non-absolute working directories are rejected before execution.
    """
    async def test_environment(*, timeout_seconds: float) -> dict[str, str]:
        return os.environ.copy()

    monkeypatch.setattr(tool_harness.workspace.environment, "bash_env", test_environment)
    cwd = str(tool_harness.workspace.work_dir)

    # Check 1: A non-zero process exit reports its code and stderr instead of returning false success.
    with pytest.raises(RuntimeError, match="exit code 9: command failed"):
        await bash("printf 'command failed' >&2; exit 9", cwd)

    # Check 2: A command exceeding its deadline is killed and raises a timeout error.
    with pytest.raises(TimeoutError) as timeout:
        await bash("sleep 0.6; printf survived > timeout-marker.txt", cwd, timeout=100)
    assert str(timeout.value) == "Command timed out after 100ms and was killed."
    await asyncio.sleep(0.7)
    assert not (tool_harness.workspace.work_dir / "timeout-marker.txt").exists()

    # Check 3: Empty commands and non-absolute working directories are rejected before execution.
    with pytest.raises(ValueError, match="command is required"):
        await bash("", cwd)
    with pytest.raises(ValueError, match="absolute"):
        await bash("pwd", ".")
