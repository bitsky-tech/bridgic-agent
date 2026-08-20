from __future__ import annotations

import asyncio
import os
from pathlib import Path
from types import MappingProxyType

import pytest

import src.amphi_agent.runtime._environment as environment_module
from src.amphi_agent.runtime._environment import (
    AgentCLIShim,
    ENV_FAILED,
    ENV_PREPARING,
    ENV_READY,
    AppCommandEnvironment,
    AppCommandEnvironmentSnapshot,
    AppEnvironmentStatus,
    WorkspaceEnvironment,
    app_command_environment,
)
from src.amphi_agent.runtime._errors import BundledRuntimeUnavailable
from tests._support.sandbox import IsolatedPaths


def _snapshot(root: Path) -> AppCommandEnvironmentSnapshot:
    """Build an immutable fake app-runtime snapshot rooted in one test sandbox."""
    app_bin = root / "app-bin"
    node_bin = root / "node-bin"
    environment = {
        "PATH": os.pathsep.join((str(app_bin), str(node_bin))),
        "HOME": str(root / "startup-home"),
        "UV_PYTHON": str(root / "python"),
        "npm_config_prefix": str(root / "node-base"),
        "STARTUP_ONLY": "stable",
    }
    managed = {
        "PATH": environment["PATH"],
        "UV_PYTHON": environment["UV_PYTHON"],
        "npm_config_prefix": environment["npm_config_prefix"],
    }
    return AppCommandEnvironmentSnapshot(
        environment=MappingProxyType(environment),
        managed_environment=MappingProxyType(managed),
        uv_executable=root / "uv",
        uv_version="0.test",
        python_executable=root / "python",
        python_version="3.test",
        node_executable=root / "node",
        node_version="v.test",
    )


def test_status_messages() -> None:
    """Final readiness messages:

    {
      "preparing": {"retryable": true, "message": "still being prepared"},
      "transient_error": {"retryable": true, "message": "file busy"},
      "failed": {"retryable": false, "message": "runtime missing"}
    }

    Checks:
    1. A fresh preparation state tells callers to wait and remains retryable.
    2. A transient preparation error preserves its reason without becoming terminal.
    3. A missing bundled runtime produces a terminal, non-retryable explanation.
    """
    # Check 1: Initial preparation remains an honest retryable wait state.
    preparing = AppEnvironmentStatus(ENV_PREPARING)
    assert preparing.retryable is True
    assert preparing.unavailable_message() == "The Agent runtime environment is still being prepared"

    # Check 2: Transient failures remain retryable and visible to the user.
    transient = AppEnvironmentStatus(ENV_PREPARING, "runtime file busy")
    assert transient.retryable is True
    assert "the last attempt failed with: runtime file busy" in transient.unavailable_message()

    # Check 3: Packaged-resource failure stops retrying and names the permanent cause.
    failed = AppEnvironmentStatus(ENV_FAILED, "bundled runtime missing")
    assert failed.retryable is False
    assert failed.unavailable_message() == (
        "The Agent runtime environment failed to prepare: bundled runtime missing"
    )


def test_environment_lifecycle(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final process-wide environment lifecycle:

    {
      "success": {"state": "ready", "builds": 1, "snapshot": "cached"},
      "transient_failure": {"state": "preparing", "next_attempt": "ready"},
      "missing_resource": {"state": "failed", "retryable": false}
    }

    Checks:
    1. Successful preparation publishes and reuses one immutable snapshot.
    2. A transient build failure remains retryable and a later attempt can become ready.
    3. Missing bundled resources permanently fail the environment instead of retrying forever.
    """
    snapshot = _snapshot(test_sandbox.root)
    ready = AppCommandEnvironment(strict=False)
    builds = 0

    def build_once() -> AppCommandEnvironmentSnapshot:
        nonlocal builds
        builds += 1
        return snapshot

    monkeypatch.setattr(ready, "_build", build_once)

    # Check 1: One successful build becomes the cached process snapshot.
    assert ready.prepare() is snapshot
    assert ready.prepare() is snapshot
    assert ready.snapshot() is snapshot
    assert ready.status() == AppEnvironmentStatus(ENV_READY)
    assert builds == 1

    transient = AppCommandEnvironment(strict=False)
    attempts = 0

    def build_after_retry() -> AppCommandEnvironmentSnapshot:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("runtime base is busy")
        return snapshot

    monkeypatch.setattr(transient, "_build", build_after_retry)

    # Check 2: A transient error records its cause without preventing a later success.
    with pytest.raises(RuntimeError, match="runtime base is busy"):
        transient.prepare()
    assert transient.status() == AppEnvironmentStatus(ENV_PREPARING, "runtime base is busy")
    assert transient.prepare() is snapshot
    assert transient.status() == AppEnvironmentStatus(ENV_READY)

    failed = AppCommandEnvironment(strict=True)

    def missing_resources() -> AppCommandEnvironmentSnapshot:
        raise BundledRuntimeUnavailable("Node executable is missing")

    monkeypatch.setattr(failed, "_build", missing_resources)

    # Check 3: A permanent packaged-resource failure is published as terminal state.
    with pytest.raises(BundledRuntimeUnavailable, match="Node executable is missing"):
        failed.prepare()
    assert failed.status() == AppEnvironmentStatus(ENV_FAILED, "Node executable is missing")
    assert failed.status().retryable is False


@pytest.mark.windows_runtime
def test_runtime_composition(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final app command environment:

    {
      "runtime": {"uv": "0.bundle", "python": "3.bundle", "node": "v20.11.1"},
      "bindings": {"UV_PYTHON": "python", "npm_config_prefix": "node-base"},
      "PATH": ["amphi", "npm-shims", "node", "bundled-uv", "uv", "python", "node-base", "user"],
      "incomplete_bundle": {"state": "failed", "commands_prepared": false}
    }

    Checks:
    1. Strict preparation composes the real root from isolated Python and Node boundaries.
    2. The CLI shim and every managed runtime directory lead the inherited user PATH once.
    3. The published snapshot reports the exact executables and versions that were applied.
    4. Missing required package resources fail before either writable runtime base is touched.
    """
    def executable(path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("isolated executable", encoding="utf-8")
        path.chmod(0o700)
        return path

    runtime_root = test_sandbox.root / "runtime"
    uv_executable = executable(runtime_root / "bundled-uv" / "uv")
    python_executable = executable(runtime_root / "python" / "python3")
    node_executable = executable(runtime_root / "node" / "bin" / "node")
    npm_cli = executable(runtime_root / "node" / "npm-cli.js")
    npx_cli = executable(runtime_root / "node" / "npx-cli.js")
    uv_bin = runtime_root / "uv-base" / "bin"
    python_bin = runtime_root / "python-base" / "bin"
    node_base_bin = runtime_root / "node-base" / "bin"
    node_shims = runtime_root / "node-base" / "shims"
    for directory in (uv_bin, python_bin, node_base_bin, node_shims):
        directory.mkdir(parents=True)
    calls: list[str] = []

    class FakeResources:
        def directory(self) -> Path:
            return runtime_root

    class FakeUvRuntime:
        def bootstrap_env(self, target: dict[str, str]) -> None:
            calls.append("uv")
            target["UV_CACHE_DIR"] = str(runtime_root / "uv-cache")

        def bundled_executable(self) -> Path:
            return uv_executable

        def bundled_version(self) -> str:
            return "0.bundle"

        def bundled_bin_dir(self) -> Path:
            return uv_executable.parent

        def bin_dir(self) -> Path:
            return uv_bin

    class FakePythonRuntime:
        bin_dir = python_bin

        def apply(self, target: dict[str, str]) -> None:
            calls.append("python")
            target["UV_PYTHON"] = str(python_executable)

        def bundled_executable(self) -> Path:
            return python_executable

        def version(self) -> str:
            return "3.bundle"

    class FakeNodeRuntime:
        RESOLVER_MIN_VERSION = (20, 6)

        def __init__(self) -> None:
            self.npm = npm_cli

        def executable(self) -> Path:
            return node_executable

        def npm_cli(self) -> Path | None:
            return self.npm

        def npx_cli(self) -> Path:
            return npx_cli

        def version(self) -> str:
            return "v20.11.1"

        def executable_version(self) -> str:
            return "v20.11.1"

        def bin_dir(self) -> Path:
            return node_executable.parent

    class FakeNodeBaseRuntime:
        root = runtime_root / "node-base"
        bin_dir = node_base_bin
        shim_dir = node_shims

        def apply(self, target: dict[str, str]) -> None:
            calls.append("node")
            target["npm_config_prefix"] = str(self.root)

    launcher_name = "amphi.exe" if os.name == "nt" else "amphi"
    command_name = "amphi.cmd" if os.name == "nt" else "amphi"
    launcher = executable(test_sandbox.root / "daemon" / launcher_name)
    cli_shim = AgentCLIShim(test_sandbox.root / "command-shims")
    fake_node = FakeNodeRuntime()
    monkeypatch.setattr(environment_module, "bundled_runtime_resources", FakeResources())
    monkeypatch.setattr(environment_module, "bundled_uv_runtime", FakeUvRuntime())
    monkeypatch.setattr(environment_module, "bundled_python_runtime", FakePythonRuntime())
    monkeypatch.setattr(environment_module, "bundled_node_runtime", fake_node)
    monkeypatch.setattr(environment_module, "bundled_node_base_runtime", FakeNodeBaseRuntime())
    monkeypatch.setattr(environment_module, "agent_cli_shim", cli_shim)
    monkeypatch.setattr(environment_module.sys, "executable", str(launcher))
    user_bin = test_sandbox.root / "user-bin"
    monkeypatch.setenv("PATH", str(user_bin))

    environment = AppCommandEnvironment(strict=True)

    # Check 1: Both startup and managed snapshots receive the real composition sequence.
    snapshot = environment.prepare()
    assert calls == ["uv", "python", "node", "uv", "python", "node"]
    assert snapshot.environment["UV_PYTHON"] == str(python_executable)
    assert snapshot.environment["npm_config_prefix"] == str(runtime_root / "node-base")

    # Check 2: The generated CLI command and managed runtime directories precede user PATH.
    assert (cli_shim.root / command_name).is_file()
    assert snapshot.environment[AgentCLIShim.LAUNCHER_ENV] == str(launcher.absolute())
    managed_path = [
        str(cli_shim.root),
        str(node_shims),
        str(node_executable.parent),
        str(uv_executable.parent),
        str(uv_bin),
        str(python_bin),
        str(node_base_bin),
    ]
    assert snapshot.environment["PATH"].split(os.pathsep) == [*managed_path, str(user_bin)]
    assert snapshot.managed_environment["PATH"].split(os.pathsep) == managed_path

    # Check 3: Runtime metadata names the same isolated resources used in the bindings.
    assert snapshot.uv_executable == uv_executable
    assert snapshot.uv_version == "0.bundle"
    assert snapshot.python_executable == python_executable
    assert snapshot.python_version == "3.bundle"
    assert snapshot.node_executable == node_executable
    assert snapshot.node_version == "v20.11.1"

    # Check 4: Strict validation rejects an incomplete bundle before composing commands.
    completed_calls = list(calls)
    fake_node.npm = None
    incomplete = AppCommandEnvironment(strict=True)
    with pytest.raises(BundledRuntimeUnavailable, match="missing npm entry point"):
        incomplete.prepare()
    assert calls == completed_calls
    assert incomplete.status().state == ENV_FAILED


def test_snapshot_compose(test_sandbox: IsolatedPaths) -> None:
    """Final command environment:

    {
      "PATH": ["app-bin", "node-bin", "user-bin", "other-bin"],
      "UV_PYTHON": "<sandbox>/python",
      "npm_config_prefix": "<sandbox>/node-base",
      "HOME": "<sandbox>/user-home",
      "CUSTOM": "kept",
      "PYTHONPATH|VIRTUAL_ENV|PLAYWRIGHT_NODEJS_PATH": "removed"
    }

    Checks:
    1. Managed runtime values replace inherited conflicts and unsafe Python bindings.
    2. Managed PATH entries lead once, followed by the user's remaining PATH entries.
    3. The inherited mapping and every returned command environment remain independent.
    """
    snapshot = _snapshot(test_sandbox.root)
    app_bin, node_bin = snapshot.managed_environment["PATH"].split(os.pathsep)
    user_bin = str(test_sandbox.root / "user-bin")
    other_bin = str(test_sandbox.root / "other-bin")
    inherited = {
        "PATH": os.pathsep.join((user_bin, app_bin, other_bin)),
        "HOME": str(test_sandbox.root / "user-home"),
        "Uv_Python": "/host/python",
        "NPM_CONFIG_PREFIX": "/host/node",
        "PYTHONPATH": "/host/packages",
        "virtual_env": "/host/venv",
        "playwright_nodejs_path": "/host/node",
        "AMPHI_AGENT_CLI_LAUNCHER": "/host/amphi",
        "CUSTOM": "kept",
    }
    original = dict(inherited)

    # Check 1: App-owned bindings win and unsafe host runtime bindings disappear.
    composed = snapshot.compose(inherited)
    assert composed["UV_PYTHON"] == str(test_sandbox.root / "python")
    assert composed["npm_config_prefix"] == str(test_sandbox.root / "node-base")
    assert composed["HOME"] == str(test_sandbox.root / "user-home")
    assert composed["CUSTOM"] == "kept"
    assert not {
        "Uv_Python",
        "NPM_CONFIG_PREFIX",
        "PYTHONPATH",
        "virtual_env",
        "playwright_nodejs_path",
        "AMPHI_AGENT_CLI_LAUNCHER",
    }.intersection(composed)

    # Check 2: Managed directories lead exactly once without dropping safe user paths.
    assert composed["PATH"].split(os.pathsep) == [
        app_bin,
        node_bin,
        user_bin,
        other_bin,
    ]

    # Check 3: Composition and command copies cannot mutate their inputs or the snapshot.
    assert inherited == original
    first = snapshot.command_env()
    second = snapshot.command_env()
    first["PATH"] = "changed"
    first["ADDED"] = "local"
    assert second["PATH"] == snapshot.environment["PATH"]
    assert "ADDED" not in second
    assert "ADDED" not in snapshot.environment


async def test_workspace_refresh(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Workspace command environment:

    {
      "runtime": {"uv": "0.test", "python": "3.test", "node": "v.test"},
      "HOME": "<sandbox>/login-home",
      "PATH": ["app-bin", "node-bin", "login-bin"],
      "CUSTOM": "fresh",
      "BASH_ENV|PROMPT_COMMAND|DYLD_*|LD_*|BASH_FUNC_*": "removed"
    }

    Checks:
    1. Prepare binds one immutable app snapshot and exposes fresh subprocess copies.
    2. A successful login-shell refresh preserves safe user variables.
    3. Shell-control variables and host runtime bindings are removed before execution.
    """
    class FakeLoginEnvironment:
        timeout: float | None = None

        async def capture(self, timeout_seconds: float) -> dict[str, str]:
            self.timeout = timeout_seconds
            return {
                "HOME": str(test_sandbox.root / "login-home"),
                "PATH": str(test_sandbox.root / "login-bin"),
                "CUSTOM": "fresh",
                "BASH_ENV": "/tmp/evil",
                "prompt_command": "malicious",
                "DYLD_INSERT_LIBRARIES": "/tmp/inject.dylib",
                "ld_preload": "/tmp/inject.so",
                "BASH_FUNC_attack%%": "() { :; }",
                "PYTHONPATH": "/host/packages",
                "VIRTUAL_ENV": "/host/venv",
            }

    snapshot = _snapshot(test_sandbox.root)
    snapshot_calls = 0

    def prepared_snapshot() -> AppCommandEnvironmentSnapshot:
        nonlocal snapshot_calls
        snapshot_calls += 1
        return snapshot

    monkeypatch.setattr(app_command_environment, "snapshot", prepared_snapshot)
    workspace = WorkspaceEnvironment(test_sandbox.sessions / "session")
    workspace.os_name = "Darwin"
    login_environment = FakeLoginEnvironment()
    workspace.login_shell_environment = login_environment

    # Check 1: One preparation binds metadata and every subprocess receives its own copy.
    workspace.prepare()
    workspace.prepare()
    first = workspace.subprocess_env()
    first["PATH"] = "changed"
    assert snapshot_calls == 1
    assert workspace.subprocess_env()["PATH"] == snapshot.environment["PATH"]
    assert workspace.uv_version == "0.test"
    assert workspace.python_version == "3.test"
    assert workspace.node_version == "v.test"

    # Check 2: A fresh safe user environment is combined with the app runtime.
    refreshed = await workspace.bash_env(0.25)
    assert login_environment.timeout == 0.25
    assert refreshed["HOME"] == str(test_sandbox.root / "login-home")
    assert refreshed["CUSTOM"] == "fresh"
    assert refreshed["PATH"].split(os.pathsep) == [
        str(test_sandbox.root / "app-bin"),
        str(test_sandbox.root / "node-bin"),
        str(test_sandbox.root / "login-bin"),
    ]

    # Check 3: Neither shell injection controls nor host Python bindings survive.
    assert not {
        "BASH_ENV",
        "prompt_command",
        "DYLD_INSERT_LIBRARIES",
        "ld_preload",
        "BASH_FUNC_attack%%",
        "PYTHONPATH",
        "VIRTUAL_ENV",
    }.intersection(refreshed)
    assert refreshed["UV_PYTHON"] == str(test_sandbox.root / "python")


async def test_refresh_fallback(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final failed-refresh result:

    {
      "first": "startup snapshot",
      "second": "independent startup snapshot",
      "login_capture_attempts": 2
    }

    Checks:
    1. A failed login-shell refresh returns the prepared startup environment.
    2. Mutating one fallback result cannot contaminate the next command.
    """
    class FailingLoginEnvironment:
        attempts = 0

        async def capture(self, timeout_seconds: float) -> dict[str, str]:
            self.attempts += 1
            raise RuntimeError(f"login refresh failed after {timeout_seconds:g}s")

    snapshot = _snapshot(test_sandbox.root)
    monkeypatch.setattr(app_command_environment, "snapshot", lambda: snapshot)
    workspace = WorkspaceEnvironment(test_sandbox.sessions / "session")
    workspace.os_name = "Darwin"
    login_environment = FailingLoginEnvironment()
    workspace.login_shell_environment = login_environment
    workspace.prepare()

    # Check 1: Refresh failure falls back to the complete startup snapshot.
    first = await workspace.bash_env(0.1)
    assert first == dict(snapshot.environment)

    # Check 2: Each failed refresh returns a clean copy rather than shared mutable state.
    first["PATH"] = "changed"
    first["ADDED"] = "local"
    second = await workspace.bash_env(0.1)
    assert second == dict(snapshot.environment)
    assert login_environment.attempts == 2


async def test_refresh_cancel(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final cancellation result:

    {
      "bash_env": "cancelled",
      "fallback_returned": false
    }

    Checks:
    1. Cancellation propagates instead of becoming an apparently successful fallback.
    """
    class CancelledLoginEnvironment:
        async def capture(self, timeout_seconds: float) -> dict[str, str]:
            raise asyncio.CancelledError(f"cancelled after {timeout_seconds:g}s")

    snapshot = _snapshot(test_sandbox.root)
    monkeypatch.setattr(app_command_environment, "snapshot", lambda: snapshot)
    workspace = WorkspaceEnvironment(test_sandbox.sessions / "session")
    workspace.os_name = "Darwin"
    workspace.login_shell_environment = CancelledLoginEnvironment()
    workspace.prepare()

    # Check 1: The cancellation remains observable and no fallback result is returned.
    with pytest.raises(asyncio.CancelledError, match="cancelled after 0.1s"):
        await workspace.bash_env(0.1)


@pytest.mark.windows_runtime
async def test_windows_refresh(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Windows Workspace environment:

    {
      "capture": "Windows native environment only",
      "PATH": ["app-bin", "node-bin", "windows-user-bin"],
      "CUSTOM": "kept",
      "BASH_ENV|PROMPT_COMMAND|DYLD_*|BASH_FUNC_*": "removed"
    }

    Checks:
    1. Windows Workspaces select the native capture adapter instead of a login shell.
    2. Unsafe shell controls are removed before the app runtime is reapplied.
    3. Managed Python, Node, and PATH bindings lead the safe Windows user environment.
    """
    class FakeWindowsEnvironment:
        calls = 0

        def capture(self) -> dict[str, str]:
            self.calls += 1
            return {
                "HOME": str(test_sandbox.root / "windows-home"),
                "PATH": str(test_sandbox.root / "windows-user-bin"),
                "CUSTOM": "kept",
                "BASH_ENV": "C:\\unsafe\\bash-env",
                "prompt_command": "malicious",
                "DYLD_INSERT_LIBRARIES": "C:\\unsafe\\inject.dll",
                "BASH_FUNC_attack%%": "() { :; }",
                "PYTHONPATH": "C:\\host\\packages",
            }

    class UnusedLoginEnvironment:
        calls = 0

        async def capture(self, timeout_seconds: float) -> dict[str, str]:
            self.calls += 1
            raise AssertionError(f"login capture must not run after {timeout_seconds:g}s")

    snapshot = _snapshot(test_sandbox.root)
    monkeypatch.setattr(app_command_environment, "snapshot", lambda: snapshot)
    monkeypatch.setattr(app_command_environment, "compose", snapshot.compose)
    workspace = WorkspaceEnvironment(test_sandbox.sessions / "windows-session")
    workspace.os_name = "Windows"
    windows_environment = FakeWindowsEnvironment()
    login_environment = UnusedLoginEnvironment()
    workspace.windows_user_environment = windows_environment
    workspace.login_shell_environment = login_environment
    workspace.prepare()

    # Check 1: Platform selection invokes only the synchronous Windows capture adapter.
    refreshed = await workspace.bash_env(0.25)
    assert windows_environment.calls == 1
    assert login_environment.calls == 0

    # Check 2: Case-insensitive shell controls and inherited Python bindings disappear.
    assert refreshed["CUSTOM"] == "kept"
    assert not {
        "BASH_ENV",
        "prompt_command",
        "DYLD_INSERT_LIBRARIES",
        "BASH_FUNC_attack%%",
        "PYTHONPATH",
    }.intersection(refreshed)

    # Check 3: The immutable app bindings lead the captured safe Windows values.
    assert refreshed["HOME"] == str(test_sandbox.root / "windows-home")
    assert refreshed["UV_PYTHON"] == str(test_sandbox.root / "python")
    assert refreshed["npm_config_prefix"] == str(test_sandbox.root / "node-base")
    assert refreshed["PATH"].split(os.pathsep) == [
        str(test_sandbox.root / "app-bin"),
        str(test_sandbox.root / "node-bin"),
        str(test_sandbox.root / "windows-user-bin"),
    ]
