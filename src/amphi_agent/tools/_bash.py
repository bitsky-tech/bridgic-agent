import asyncio
import os
import signal
import subprocess
from contextvars import ContextVar
from typing import Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

# Commands run for up to 30 minutes unless the caller selects a shorter timeout.
DEFAULT_TIMEOUT_MS: int = 1_800_000
MAX_TIMEOUT_MS: int = 1_800_000
USER_ENVIRONMENT_TIMEOUT_SECONDS: float = 5.0
_IS_WINDOWS = os.name == "nt"
_WINDOWS_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
_WINDOWS_FALLBACK_ENCODINGS = ("oem", "mbcs")

# Bound by AmphiAgent while dispatching each concurrent tool call.
current_tool_call_id: ContextVar[Optional[str]] = ContextVar("current_tool_call_id", default=None)
current_execution_mode: ContextVar[Optional[str]] = ContextVar("current_execution_mode", default=None)


def _create_windows_kill_job(pid: int) -> Optional[int]:
    """Assign ``pid`` to a job that can terminate its complete process tree."""
    if not _IS_WINDOWS:
        return None

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return None
    process = kernel32.OpenProcess(0x0001 | 0x0100, False, pid)
    assigned = bool(
        process
        and kernel32.AssignProcessToJobObject(job, process)
    )
    if process:
        kernel32.CloseHandle(process)
    if not assigned:
        kernel32.CloseHandle(job)
        return None
    return int(job)


def _close_windows_kill_job(handle: Optional[int], *, terminate: bool) -> bool:
    """Close a command job, optionally terminating every process assigned to it."""
    if not _IS_WINDOWS or handle is None:
        return False

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    terminated = bool(kernel32.TerminateJobObject(handle, 1)) if terminate else False
    kernel32.CloseHandle(handle)
    return terminated


def _decode_shell_output(data: bytes) -> str:
    """Decode shell output without discarding legacy Windows code-page bytes."""
    if not _IS_WINDOWS:
        return data.decode("utf-8", errors="replace")

    def decode_line(line: bytes) -> str:
        try:
            return line.decode("utf-8")
        except UnicodeDecodeError:
            for encoding in _WINDOWS_FALLBACK_ENCODINGS:
                try:
                    return line.decode(encoding)
                except (LookupError, UnicodeDecodeError):
                    continue
            return line.decode("utf-8", errors="replace")

    # Decode line by line so one legacy native command does not corrupt UTF-8
    # output emitted by another command in the same PowerShell invocation.
    return "".join(decode_line(line) for line in data.splitlines(keepends=True))


async def bash(command: str, cwd: str, timeout: int = DEFAULT_TIMEOUT_MS) -> str:
    """Execute a platform-native shell command and return captured ``stdout``.

    ``cwd`` is explicit and call-local. The tool never selects, inherits, or
    rewrites a working directory on the Agent's behalf. It uses Bash on POSIX
    and Windows PowerShell on Windows; ``<Workspace>`` describes the syntax
    available to the Agent.

    Parameters
    ----------
    command : str
        Command written in the shell syntax declared by ``<Workspace>``.
    cwd : str
        Absolute command working directory selected from the paths shown in
        ``<Workspace>`` or another user-authorized location.
    timeout : int
        Maximum duration in milliseconds. Defaults to 1800000 and is capped at
        1800000.

    Returns
    -------
    str
        Complete captured stdout. Oversized tool results are persisted by the
        Agent's shared result-storage policy.
    """
    if not command or not command.strip():
        raise ValueError("command is required")
    if not cwd or not cwd.strip():
        raise ValueError("cwd is required and must be an absolute directory path")
    if not os.path.isabs(cwd):
        raise ValueError("cwd must be an absolute directory path")
    cwd = os.path.abspath(cwd)
    if not os.path.isdir(cwd):
        raise NotADirectoryError(
            f"Working directory does not exist or is not a directory: {cwd}"
        )

    timeout_ms = max(1, min(int(timeout), MAX_TIMEOUT_MS))
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_ms / 1000.0

    agent = current_agent.get(None)
    context = getattr(agent, "ctx", None)
    workspace = getattr(context, "workspace", None) if context is not None else None
    if workspace is None:
        raise RuntimeError("bash requires an active Agent Workspace")
    environment_budget = min(
        USER_ENVIRONMENT_TIMEOUT_SECONDS,
        max(0.0, deadline - loop.time()),
    )
    env = await workspace.environment.bash_env(
        timeout_seconds=environment_budget,
    )
    if loop.time() >= deadline:
        raise TimeoutError(
            f"Command timed out after {timeout_ms}ms before the shell started."
        )

    session = getattr(context, "session", None) if context is not None else None
    session_id = getattr(session, "id", None)
    if session_id:
        env["SESSION_ID"] = str(session_id)
        tool_call_id = current_tool_call_id.get()
        if tool_call_id:
            env["PARENT_TOOL_CALL_ID"] = tool_call_id
        execution_mode = current_execution_mode.get()
        if execution_mode:
            env["EXECUTION_MODE"] = execution_mode

    spawn_options = (
        {"creationflags": _WINDOWS_CREATE_NO_WINDOW}
        if _IS_WINDOWS
        else {"start_new_session": True}
    )
    if _IS_WINDOWS:
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        powershell_command = (
            "$utf8 = New-Object System.Text.UTF8Encoding($false); "
            "[Console]::InputEncoding = $utf8; "
            "[Console]::OutputEncoding = $utf8; "
            "$OutputEncoding = $utf8; "
            "$PSDefaultParameterValues['*:Encoding'] = 'utf8'; "
            # Keep the status check in the same scope and immediately after
            # the user command.  Invoking the command through ``& { ... }``
            # makes ``$?`` describe the script-block invocation itself, which
            # is successful even when its final PowerShell command emitted a
            # non-terminating error (for example CommandNotFoundException).
            f"{command}\n"
            "if (-not $?) { "
            "if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 "
            "}"
        )
        shell_argv = (
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            powershell_command,
        )
    else:
        shell_argv = ("/bin/bash", "-c", command)

    proc = await asyncio.create_subprocess_exec(
        *shell_argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
        **spawn_options,
    )
    windows_job = _create_windows_kill_job(proc.pid)

    async def kill_process_tree() -> None:
        """Kill the shell's complete process group and reap the shell."""
        nonlocal windows_job
        try:
            if not _IS_WINDOWS:
                os.killpg(proc.pid, signal.SIGKILL)
            elif proc.returncode is None:
                terminated_job = _close_windows_kill_job(
                    windows_job,
                    terminate=True,
                )
                windows_job = None
                if not terminated_job:
                    try:
                        killer = await asyncio.create_subprocess_exec(
                            "taskkill.exe",
                            "/PID",
                            str(proc.pid),
                            "/T",
                            "/F",
                            stdout=asyncio.subprocess.DEVNULL,
                            stderr=asyncio.subprocess.DEVNULL,
                            creationflags=_WINDOWS_CREATE_NO_WINDOW,
                        )
                        await killer.wait()
                    except OSError:
                        proc.kill()
                if proc.returncode is None:
                    proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()

    remaining_seconds = deadline - loop.time()
    if remaining_seconds <= 0:
        await kill_process_tree()
        raise TimeoutError(
            f"Command timed out after {timeout_ms}ms and was killed."
        )

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=remaining_seconds,
        )
    except asyncio.TimeoutError as exc:
        await kill_process_tree()
        raise TimeoutError(
            f"Command timed out after {timeout_ms}ms and was killed."
        ) from exc
    except asyncio.CancelledError:
        await kill_process_tree()
        raise
    else:
        _close_windows_kill_job(windows_job, terminate=False)
        windows_job = None

    stdout = _decode_shell_output(stdout_bytes)
    stderr = _decode_shell_output(stderr_bytes)
    exit_code = proc.returncode if proc.returncode is not None else -1

    if exit_code != 0:
        # subprocess.check_output convention: a non-zero exit raises, and the
        # framework folds it into ActionStepResult(success=False, error=...).
        detail = stderr.strip() or stdout.strip() or "(no output captured)"
        raise RuntimeError(f"Command failed with exit code {exit_code}: {detail}")

    return stdout


bash_tool: FunctionToolSpec = FunctionToolSpec.from_raw(bash)

__all__ = ["bash_tool", "current_execution_mode", "current_tool_call_id"]
