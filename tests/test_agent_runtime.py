"""Unit coverage for the Agent-owned execution runtimes."""

import asyncio
import contextlib
import errno
import getpass
import json
import logging
import ntpath
import os
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from src.amphi_agent.runtime import _probe
from src.amphi_agent.runtime._errors import EnvNotReady
from src.amphi_agent.runtime._environment import (
    AgentCLIShim,
    AppCommandEnvironment,
    AppCommandEnvironmentSnapshot,
    WorkspaceEnvironment,
    app_command_environment,
    bundled_node_base_runtime,
    bundled_node_runtime,
    bundled_python_runtime,
    bundled_runtime_resources,
    bundled_uv_runtime,
)
from src.amphi_agent.runtime._node_env import BundledNodeBaseRuntime, BundledNodeRuntime
from src.amphi_agent.runtime._python_env import BundledUPythonRuntime, BundledUvRuntime
from src.amphi_agent.runtime._resources import BundledRuntimeResources


def _make_node_runtime(root: Path, *, windows: bool) -> Path:
    """Lay out a minimal Node bundle the way the official archives do.

    POSIX nests the executable under ``bin/``; Windows keeps ``node.exe`` at the
    archive root. Getting this wrong is the single likeliest cross-platform bug
    in BundledNodeRuntime, hence a fixture for each shape.

    Note there is deliberately no ``os.name`` patching in these tests:
    ``pathlib.Path()`` picks PosixPath vs WindowsPath off ``os.name`` at
    construction time, so faking it makes every ``Path.is_dir()`` in the module
    under test silently fail. ``BundledNodeRuntime`` probes the on-disk layout
    instead of branching on the platform, which is what makes both shapes
    testable from a single OS.
    """
    if windows:
        executable = root / "node.exe"
    else:
        (root / "bin").mkdir(parents=True, exist_ok=True)
        executable = root / "bin" / "node"
    root.mkdir(parents=True, exist_ok=True)
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    npm_bin = root / ("node_modules" if windows else "lib/node_modules") / "npm" / "bin"
    npm_bin.mkdir(parents=True, exist_ok=True)
    (npm_bin / "npm-cli.js").write_text("", encoding="utf-8")
    (npm_bin / "npx-cli.js").write_text("", encoding="utf-8")
    return executable


def _make_real_node_runtime(root: Path) -> tuple[Path, Path]:
    """Lay out a test bundle backed by a host Node supporting registerHooks."""
    found = shutil.which("node")
    if found is None:
        pytest.skip("Node is required for the shared base integration test")
    completed = subprocess.run(
        [found, "--version"], capture_output=True, text=True, check=True,
    )
    version = tuple(int(part) for part in completed.stdout.strip().lstrip("v").split(".")[:2])
    if version < (22, 15):
        pytest.skip("Node 22.15+ is required for module.registerHooks")
    executable = _make_node_runtime(root, windows=False)
    executable.unlink()
    try:
        executable.symlink_to(Path(found).resolve())
    except OSError:
        shutil.copy2(found, executable)
    return Path(found).resolve(), executable


def _attach_host_npm(root: Path) -> None:
    """Point a test bundle at the host npm implementation without copying it."""
    npm = shutil.which("npm")
    if npm is None:
        pytest.skip("npm is required for the shared base integration test")
    completed = subprocess.run(
        [npm, "root", "--global"],
        capture_output=True,
        text=True,
        check=True,
    )
    npm_root = Path(completed.stdout.strip()) / "npm" / "bin"
    targets = root / "lib" / "node_modules" / "npm" / "bin"
    for name in ("npm-cli.js", "npx-cli.js"):
        source = npm_root / name
        if not source.is_file():
            pytest.skip(f"host npm entry point is unavailable: {source}")
        target = targets / name
        target.unlink(missing_ok=True)
        try:
            target.symlink_to(source.resolve())
        except OSError:
            shutil.copy2(source, target)


def _clear_playwright_node_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unset ``PLAYWRIGHT_NODEJS_PATH`` so monkeypatch restores it afterwards.

    ``apply_playwright_env`` writes ``os.environ`` directly, and
    ``monkeypatch.delenv(name, raising=False)`` records NOTHING when the key is
    already absent — so a plain ``delenv`` leaves whatever the test wrote in
    place for the rest of the session, pointing at a deleted ``tmp_path``.
    Seeding the key first makes the deletion (and therefore the restore)
    something monkeypatch actually tracks.
    """
    monkeypatch.setenv("PLAYWRIGHT_NODEJS_PATH", "")
    monkeypatch.delenv("PLAYWRIGHT_NODEJS_PATH")


def test_runtime_resources_auto_discover_source_checkout(tmp_path: Path) -> None:
    """Editable installs resolve the same Resources tree as Electron dev."""
    (tmp_path / "pyproject.toml").write_text("[project]\nname='test'\n", encoding="utf-8")
    resources = tmp_path / "desktop" / "apps" / "electron" / "resources"
    resources.mkdir(parents=True)

    assert BundledRuntimeResources(source_root=tmp_path).directory() == resources


def test_strict_app_environment_rejects_host_fallbacks(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A host uv on PATH cannot rescue an incomplete App Resources tree."""
    import src.amphi_agent.runtime._environment as environment_module

    host_uv = tmp_path / "daemon-venv" / "bin" / "uv"
    host_uv.parent.mkdir(parents=True)
    host_uv.write_text("", encoding="utf-8")
    monkeypatch.setattr(bundled_runtime_resources, "directory", lambda: tmp_path)
    monkeypatch.setattr(bundled_uv_runtime, "bundled_executable", lambda: None)
    monkeypatch.setattr(bundled_uv_runtime, "executable", lambda: host_uv)
    monkeypatch.setattr(
        bundled_python_runtime,
        "bundled_executable",
        lambda: tmp_path / "python",
    )
    monkeypatch.setattr(bundled_node_runtime, "executable", lambda: tmp_path / "node")
    monkeypatch.setattr(bundled_node_runtime, "npm_cli", lambda: tmp_path / "npm-cli.js")
    monkeypatch.setattr(bundled_node_runtime, "npx_cli", lambda: tmp_path / "npx-cli.js")
    monkeypatch.setattr(
        environment_module,
        "_compose_user_command_env",
        lambda _base=None: pytest.fail("composition ran after strict validation failed"),
    )

    runtime = AppCommandEnvironment()
    with pytest.raises(RuntimeError, match="missing uv executable"):
        runtime.prepare()
    with pytest.raises(RuntimeError, match="failed to prepare"):
        runtime.snapshot()


def test_incomplete_resources_are_reported_as_a_failure_not_worth_retrying(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A missing packaged binary never appears on its own, so retrying is noise."""
    monkeypatch.setattr(bundled_runtime_resources, "directory", lambda: tmp_path)
    monkeypatch.setattr(bundled_uv_runtime, "bundled_executable", lambda: None)

    runtime = AppCommandEnvironment()
    with pytest.raises(RuntimeError, match="missing uv executable"):
        runtime.prepare()
    status = runtime.status()

    assert status.state == "failed"
    assert status.retryable is False
    assert "missing uv executable" in (status.error or "")


def test_a_transient_preparation_failure_keeps_the_environment_preparing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A held handle clears on its own, so the verdict must stay retryable.

    This is the failure that used to reach uvicorn as "Application startup
    failed. Exiting." and leave the user with an app that never opened.
    """
    import src.amphi_agent.runtime._environment as environment_module

    def compose(base=None):
        raise EnvNotReady(tmp_path / "python" / "base", PermissionError("Access is denied"))

    monkeypatch.setattr(environment_module, "_compose_user_command_env", compose)

    runtime = AppCommandEnvironment()
    monkeypatch.setattr(runtime, "_validate_required_resources", lambda: None)
    with pytest.raises(EnvNotReady):
        runtime.prepare()
    status = runtime.status()

    assert status.state == "preparing"
    assert status.retryable is True
    with pytest.raises(RuntimeError, match="still being prepared"):
        runtime.snapshot()


def test_a_workspace_says_why_commands_cannot_run_yet(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The message an Agent command shows the user comes from this path.

    ``prepare_workspace`` binds the process snapshot, so a Session that starts
    before preparation finishes fails here. The invocation turns whatever is
    raised into the conversation's error text verbatim.
    """
    monkeypatch.setattr(app_command_environment, "strict", True)
    app_command_environment.reset()

    with pytest.raises(RuntimeError, match="still being prepared"):
        WorkspaceEnvironment(tmp_path).prepare()


def test_app_environment_publishes_one_immutable_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Every Workspace receives an isolated copy of one process-level snapshot."""
    import src.amphi_agent.runtime._environment as environment_module

    calls: list[dict[str, str] | None] = []
    python = tmp_path / "python" / "base" / "bin" / "python"

    def compose(base=None):
        calls.append(dict(base) if base is not None else None)
        inherited_path = "/daemon/.venv/bin" if base is None else base.get("PATH", "")
        return {
            "PATH": f"/app/bin:{inherited_path}".rstrip(":"),
            "UV_PYTHON": str(python),
        }

    monkeypatch.setattr(environment_module, "_compose_user_command_env", compose)
    monkeypatch.setattr(bundled_uv_runtime, "bundled_executable", lambda: tmp_path / "uv")
    monkeypatch.setattr(bundled_uv_runtime, "bundled_version", lambda: "0.9.5")
    monkeypatch.setattr(
        bundled_uv_runtime,
        "version",
        lambda: pytest.fail("strict snapshot probed a host uv"),
    )
    monkeypatch.setattr(bundled_python_runtime, "version", lambda: "3.13.6")
    monkeypatch.setattr(bundled_node_runtime, "executable", lambda: tmp_path / "node")
    monkeypatch.setattr(bundled_node_runtime, "version", lambda: "v22.23.1")

    runtime = AppCommandEnvironment()
    monkeypatch.setattr(runtime, "_validate_required_resources", lambda: None)
    first = runtime.prepare()
    second = runtime.prepare()
    command_env = first.command_env()
    command_env["PATH"] = "/mutated"
    refreshed = runtime.compose({"PATH": "/fresh/login/bin"})

    assert first is second
    assert calls == [None, {}]
    assert runtime.status().state == "ready"
    assert first.environment["PATH"] == "/app/bin:/daemon/.venv/bin"
    assert runtime.command_env()["PATH"] == "/app/bin:/daemon/.venv/bin"
    assert refreshed["PATH"] == "/app/bin:/fresh/login/bin"
    with pytest.raises(TypeError):
        first.environment["PATH"] = "/forbidden"  # type: ignore[index]


def test_app_environment_snapshot_reapplies_managed_bindings_in_memory() -> None:
    """Per-command composition is pure and never prepares runtimes again."""
    snapshot = AppCommandEnvironmentSnapshot(
        environment={"PATH": "/managed/bin:/daemon/bin"},
        managed_environment={
            "PATH": "/managed/bin",
            "UV_PYTHON": "/managed/python",
            "NODE_OPTIONS": "--require /managed/resolver.cjs",
            "npm_config_prefix": "/managed/node/base",
        },
        uv_executable=None,
        uv_version=None,
        python_executable=None,
        python_version=None,
        node_executable=None,
        node_version=None,
    )
    inherited = {
        "PATH": "/user/bin:/managed/bin:/usr/bin",
        "UV_PROJECT": "/user/project",
        "uv_python": "/user/python",
        "PYTHONPATH": "/user/python-modules",
        "node_options": "--inspect",
        "NPM_CONFIG_PREFIX": "/user/node",
        "PLAYWRIGHT_NODEJS_PATH": "/user/node",
        "JAVA_HOME": "/user/jdk",
    }

    result = snapshot.compose(inherited)

    assert result == {
        "PATH": "/managed/bin:/user/bin:/usr/bin",
        "UV_PYTHON": "/managed/python",
        "NODE_OPTIONS": "--require /managed/resolver.cjs",
        "npm_config_prefix": "/managed/node/base",
        "JAVA_HOME": "/user/jdk",
    }
    assert inherited["PATH"] == "/user/bin:/managed/bin:/usr/bin"


def test_app_environment_snapshot_deduplicates_windows_path_case_insensitively(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Managed Windows executables stay first without duplicate casing aliases."""
    snapshot = AppCommandEnvironmentSnapshot(
        environment={"PATH": r"C:\Managed\bin;C:\daemon"},
        managed_environment={
            "PATH": r"C:\Managed\bin;C:\Node",
            "UV_PYTHON": r"C:\Managed\python.exe",
        },
        uv_executable=None,
        uv_version=None,
        python_executable=None,
        python_version=None,
        node_executable=None,
        node_version=None,
    )
    monkeypatch.setattr(os, "pathsep", ";")
    monkeypatch.setattr(os.path, "normcase", ntpath.normcase)

    result = snapshot.compose({
        "PATH": r"c:\managed\BIN;C:\Users\person\bin;C:\NODE",
        "uv_python": r"C:\host\python.exe",
    })

    assert result == {
        "PATH": r"C:\Managed\bin;C:\Node;C:\Users\person\bin",
        "UV_PYTHON": r"C:\Managed\python.exe",
    }


@pytest.mark.skipif(os.name == "nt", reason="POSIX login shells only")
async def test_workspace_bash_env_sanitizes_and_recomposes_each_probe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Fresh user exports survive while shell-control variables do not."""
    environment = WorkspaceEnvironment(tmp_path / "session")
    environment._base_environment = {"PATH": "/managed/fallback"}
    capture = AsyncMock(side_effect=[
        {
            "PATH": "/user/bin:/usr/bin",
            "JAVA_HOME": "/user/jdk",
            "BASH_ENV": "/user/inject.sh",
            "BASH_FUNC_hidden%%": "() { echo hidden; }",
            "DYLD_INSERT_LIBRARIES": "/user/inject.dylib",
            "LD_PRELOAD": "/user/inject.so",
        },
        {
            "PATH": "/updated/bin:/usr/bin",
            "JAVA_HOME": "/updated/jdk",
        },
    ])
    monkeypatch.setattr(environment.login_shell_environment, "capture", capture)
    composed: list[dict[str, str]] = []

    def compose(inherited):
        composed.append(dict(inherited))
        return {**inherited, "PATH": f"/managed/bin{os.pathsep}{inherited['PATH']}"}

    monkeypatch.setattr(app_command_environment, "compose", compose)

    first = await environment.bash_env(timeout_seconds=1.25)
    refreshed = await environment.bash_env(timeout_seconds=0.75)

    assert capture.await_count == 2
    assert [call.kwargs["timeout_seconds"] for call in capture.await_args_list] == [
        1.25,
        0.75,
    ]
    assert composed == [
        {
            "PATH": "/user/bin:/usr/bin",
            "JAVA_HOME": "/user/jdk",
        },
        {
            "PATH": "/updated/bin:/usr/bin",
            "JAVA_HOME": "/updated/jdk",
        },
    ]
    assert first["PATH"].split(os.pathsep) == [
        "/managed/bin",
        "/user/bin",
        "/usr/bin",
    ]
    assert refreshed["PATH"].split(os.pathsep) == [
        "/managed/bin",
        "/updated/bin",
        "/usr/bin",
    ]
    assert refreshed["JAVA_HOME"] == "/updated/jdk"


@pytest.mark.skipif(os.name == "nt", reason="POSIX login shells only")
async def test_workspace_bash_env_falls_back_without_leaking_or_swallowing_cancel(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A broken profile gets a fresh fallback; cancellation still aborts."""
    environment = WorkspaceEnvironment(tmp_path / "session")
    environment._base_environment = {"PATH": "/managed/fallback"}
    capture = AsyncMock(side_effect=RuntimeError("secret profile detail"))
    monkeypatch.setattr(environment.login_shell_environment, "capture", capture)

    with caplog.at_level(logging.WARNING):
        fallback = await environment.bash_env(timeout_seconds=2)

    assert fallback == {"PATH": "/managed/fallback"}
    fallback["PATH"] = "/mutated"
    assert environment.subprocess_env()["PATH"] == "/managed/fallback"
    assert "secret profile detail" not in caplog.text
    assert "using the startup environment snapshot" in caplog.text

    capture.side_effect = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await environment.bash_env(timeout_seconds=2)


async def test_workspace_bash_env_refreshes_windows_environment_each_call(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Windows additions, edits, and deletions are visible without an App restart."""
    environment = WorkspaceEnvironment(tmp_path / "session")
    environment.os_name = "Windows"
    environment._base_environment = {"PATH": r"C:\managed\fallback"}
    capture = Mock(side_effect=[
        {
            "PATH": r"C:\user\first;C:\Windows\System32",
            "AMPHI_CHANGED": "v1",
            "AMPHI_REMOVED": "present",
        },
        {
            "PATH": r"C:\user\second;C:\Windows\System32",
            "AMPHI_CHANGED": "v2",
            "AMPHI_ADDED": "fresh",
        },
    ])
    monkeypatch.setattr(environment.windows_user_environment, "capture", capture)
    composed: list[dict[str, str]] = []

    def compose(inherited):
        composed.append(dict(inherited))
        return {**inherited, "PATH": rf"C:\managed\bin;{inherited['PATH']}"}

    monkeypatch.setattr(app_command_environment, "compose", compose)

    first = await environment.bash_env(timeout_seconds=1.25)
    refreshed = await environment.bash_env(timeout_seconds=0.75)

    assert capture.call_count == 2
    assert composed == [
        {
            "PATH": r"C:\user\first;C:\Windows\System32",
            "AMPHI_CHANGED": "v1",
            "AMPHI_REMOVED": "present",
        },
        {
            "PATH": r"C:\user\second;C:\Windows\System32",
            "AMPHI_CHANGED": "v2",
            "AMPHI_ADDED": "fresh",
        },
    ]
    assert first["AMPHI_REMOVED"] == "present"
    assert "AMPHI_REMOVED" not in refreshed
    assert refreshed["AMPHI_CHANGED"] == "v2"
    assert refreshed["AMPHI_ADDED"] == "fresh"
    assert refreshed["PATH"].startswith(r"C:\managed\bin;")


async def test_workspace_bash_env_falls_back_when_windows_capture_fails(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A Win32 failure uses an isolated startup snapshot without leaking details."""
    environment = WorkspaceEnvironment(tmp_path / "session")
    environment.os_name = "Windows"
    environment._base_environment = {"PATH": r"C:\managed\fallback"}
    capture = Mock(side_effect=RuntimeError("secret native environment value"))
    monkeypatch.setattr(environment.windows_user_environment, "capture", capture)

    with caplog.at_level(logging.WARNING):
        fallback = await environment.bash_env(timeout_seconds=2)

    assert fallback == {"PATH": r"C:\managed\fallback"}
    fallback["PATH"] = r"C:\mutated"
    assert environment.subprocess_env()["PATH"] == r"C:\managed\fallback"
    assert "secret native environment value" not in caplog.text
    assert "startup environment snapshot" in caplog.text


def test_bootstrap_noop_and_replaces_host_uv_state(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """The bootstrap never overreaches: it leaves the env untouched in dev (not
    frozen, no override) and when the override points at a missing dir. Once a
    bundle exists, app-owned uv paths replace inherited daemon settings."""
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_UV_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_UV_RUNTIME_DIR", raising=False)
    monkeypatch.setattr("sys.frozen", False, raising=False)
    assert bundled_uv_runtime.bundled_bin_dir() is None
    assert bundled_uv_runtime.bin_dir() is None
    env = {"PATH": "/usr/bin"}
    bundled_uv_runtime.bootstrap_env(env)
    assert env == {"PATH": "/usr/bin"}

    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(tmp_path / "nope"))
    env = {"PATH": "/usr/bin"}
    bundled_uv_runtime.bootstrap_env(env)
    assert env == {"PATH": "/usr/bin"}

    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(tmp_path))
    bundled_uv_runtime.reset_cache()
    env = {
        "PATH": "/usr/bin",
        "uv_cache_dir": "/custom/cache",
        "UV_PYTHON_INSTALL_DIR": "/custom/python",
    }
    bundled_uv_runtime.bootstrap_env(env)
    assert "uv_cache_dir" not in env
    assert env["UV_CACHE_DIR"] == str(bundled_uv_runtime.data_home / "uv" / "cache")
    assert env["UV_PYTHON_INSTALL_DIR"] == str(
        bundled_uv_runtime.data_home / "uv" / "python"
    )


def test_bootstrap_prepends_path_and_isolates_uv(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """A bundled uv runtime wins on PATH and pins uv to private dirs."""
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(tmp_path))
    env = {"PATH": "/usr/bin"}
    bundled_uv_runtime.bootstrap_env(env)

    assert env["PATH"] == f"{tmp_path}{os.pathsep}/usr/bin"
    assert env["UV_CACHE_DIR"].endswith(os.path.join("uv", "cache"))
    assert env["UV_PYTHON_INSTALL_DIR"].endswith(os.path.join("uv", "python"))
    assert env["UV_PYTHON_PREFERENCE"] == "only-managed"


def test_python_runtime_owns_packaged_interpreter_discovery(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Python discovery is independent from uv environment bootstrapping."""
    uv_bin = tmp_path / "uv-bin"
    runtime = tmp_path / "python-runtime"
    installation = runtime / "cpython-3.13.6-test"
    python = installation / ("python.exe" if os.name == "nt" else "bin/python3")
    uv_bin.mkdir()
    python.parent.mkdir(parents=True)
    python.write_text("")
    (runtime / "runtime.json").write_text(
        json.dumps(
            {
                "version": 1,
                "pythonVersion": "3.13.6",
                "target": "test",
                "executable": python.relative_to(runtime).as_posix(),
            }
        )
    )
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(uv_bin))
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON_RUNTIME_DIR", str(runtime))

    env = {
        "PATH": "/usr/bin",
        "UV_PYTHON": "/system/python",
        "UV_PYTHON_DOWNLOADS": "automatic",
        "PYTHONPYCACHEPREFIX": "/daemon/pycache",
    }
    resources = BundledRuntimeResources(source_root=tmp_path)
    uv_runtime = BundledUvRuntime(resources=resources, data_home=tmp_path)
    python_runtime = BundledUPythonRuntime(
        uv_runtime=uv_runtime,
        resources=resources,
        data_home=tmp_path,
    )
    uv_runtime.bootstrap_env(env)

    assert python_runtime.bundled_executable() == python.resolve()
    assert env["UV_PYTHON"] == "/system/python"
    assert env["UV_PYTHON_DOWNLOADS"] == "automatic"
    assert env["UV_PYTHON_PREFERENCE"] == "only-managed"
    assert env["PYTHONPYCACHEPREFIX"] == "/daemon/pycache"
    assert env["PATH"].split(os.pathsep)[:2] == [str(uv_bin), "/usr/bin"]


def test_bundled_python_runtime_is_shared_and_accepts_direct_installs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """One app-level environment persists packages across command contexts."""
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is required for the shared base integration test")
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(Path(uv).parent))
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON", sys.executable)
    runtime = BundledUvRuntime(data_home=tmp_path)
    first = BundledUPythonRuntime(uv_runtime=runtime, data_home=tmp_path)

    python = first.ensure()
    assert python == tmp_path / "python" / "base" / (
        "Scripts/python.exe" if os.name == "nt" else "bin/python"
    )
    assert python is not None and python.is_file()
    environment = {
        "PATH": os.defpath,
        "UV_PROJECT": "/daemon/project",
        "PYTHONHOME": "/host/python",
        "PYTHONPATH": "/host/modules",
        "PIP_TARGET": "/host/target",
        "PIP_CONFIG_FILE": "/host/pip.conf",
    }
    runtime.bootstrap_env(environment)
    first.apply(environment)
    assert "UV_PROJECT" not in environment
    assert environment["VIRTUAL_ENV"] == str(first.root)
    assert environment["UV_PROJECT_ENVIRONMENT"] == str(first.root)
    assert environment["UV_PYTHON"] == str(python)
    assert environment["PATH"].split(os.pathsep)[0] == str(first.bin_dir)
    assert "PYTHONHOME" not in environment
    assert "PYTHONPATH" not in environment
    assert "PIP_TARGET" not in environment
    assert environment["PIP_CONFIG_FILE"] == os.devnull
    assert environment["PIP_USER"] == "0"
    assert first.version() == platform.python_version()
    pip_module = subprocess.run(
        [str(python), "-I", "-m", "pip", "--version"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert pip_module.returncode == 0, pip_module.stderr
    assert str(first.root) in pip_module.stdout
    pip_command = subprocess.run(
        ["pip", "--version"],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert pip_command.returncode == 0, pip_command.stderr
    assert str(first.root) in pip_command.stdout

    wheel = tmp_path / "shared_probe-1.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, mode="w") as archive:
        archive.writestr("shared_probe.py", "VALUE = 'shared-base'\n")
        archive.writestr(
            "shared_probe-1.0.dist-info/METADATA",
            "Metadata-Version: 2.1\nName: shared-probe\nVersion: 1.0\n",
        )
        archive.writestr(
            "shared_probe-1.0.dist-info/WHEEL",
            "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\n"
            "Tag: py3-none-any\n",
        )
        archive.writestr("shared_probe-1.0.dist-info/RECORD", "")
    install = subprocess.run(
        [str(uv), "pip", "install", "--no-index", str(wheel)],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert install.returncode == 0, install.stderr

    second = BundledUPythonRuntime(uv_runtime=runtime, data_home=tmp_path)
    assert second.ensure() == python
    probe = subprocess.run(
        [str(python), "-c", "import shared_probe; print(shared_probe.VALUE)"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert probe.returncode == 0, probe.stderr
    assert probe.stdout.strip() == "shared-base"


def test_bundled_python_runtime_does_not_fall_back_to_host_uv(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Only the app-packaged uv may create the app-owned base."""
    host_uv = shutil.which("uv")
    if host_uv is None:
        pytest.skip("uv is required to exercise the host fallback")
    monkeypatch.setenv("PATH", str(Path(host_uv).parent))
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(tmp_path / "missing-uv"))
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON", sys.executable)
    runtime = BundledUvRuntime(data_home=tmp_path)

    assert runtime.executable() == Path(host_uv).resolve()
    with pytest.raises(RuntimeError, match="Bundled uv is unavailable"):
        BundledUPythonRuntime(uv_runtime=runtime, data_home=tmp_path).ensure()


def test_bundled_python_runtime_repairs_pip_in_place_and_retries(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A compatible existing base is preserved and a failed pip repair is retryable."""
    uv_runtime = BundledUvRuntime(
        data_home=tmp_path,
        resources=BundledRuntimeResources(source_root=tmp_path),
    )
    bundled_python = tmp_path / "bundled-python"
    bundled_uv = tmp_path / "bundled-uv"
    bundled_python.write_text("", encoding="utf-8")
    bundled_uv.write_text("", encoding="utf-8")
    runtime = BundledUPythonRuntime(uv_runtime=uv_runtime, data_home=tmp_path)
    repairs: list[str] = []

    monkeypatch.setattr(runtime, "bundled_executable", lambda: bundled_python)
    monkeypatch.setattr(uv_runtime, "bundled_executable", lambda: bundled_uv)
    monkeypatch.setattr(runtime, "_runtime_identity", lambda _python: {"identity": "same"})
    monkeypatch.setattr(runtime, "_recover_interrupted_install", lambda _identity: None)
    monkeypatch.setattr(
        runtime,
        "_probe",
        lambda root, _identity: _probe.BaseProbe(_probe.ProbeResult.VALID, root),
    )
    monkeypatch.setattr(
        runtime,
        "_create",
        lambda *_args: pytest.fail("compatible base was replaced during pip repair"),
    )

    def repair() -> None:
        repairs.append("attempt")
        if len(repairs) == 1:
            raise RuntimeError("repair interrupted")

    monkeypatch.setattr(runtime, "_ensure_pip", repair)

    with pytest.raises(RuntimeError, match="repair interrupted"):
        runtime.ensure()
    assert runtime.ensure() == runtime.python_executable
    assert repairs == ["attempt", "attempt"]


def test_ensure_pip_replaces_a_pip_that_cannot_be_used(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """``ensurepip --upgrade`` installs nothing over a pip already sitting there.

    So a pip that arrived without its console scripts -- unpacked rather than
    installed, or written by a tool that skipped them -- imports fine, silently
    satisfies the upgrade, and never grows the launcher that every later
    attempt then fails on. Reproduced message for message on a macOS install,
    where it left the app repeating "still being prepared" forever: the state
    was detected correctly and the repair for it was a no-op.
    """
    base, site, launcher = _base_with_half_installed_pip(monkeypatch, tmp_path)

    base._ensure_pip()

    assert launcher.is_file()
    # The package directory is deliberately left for ensurepip to write over.
    # Deleting it as well is what turns a delete that only half lands into a
    # base where pip no longer imports and the upgrade is still satisfied.
    assert (site / "pip").is_dir()


def test_ensure_pip_leaves_a_healthy_pip_alone_when_the_probe_misfires(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Not every "pip is unavailable" means the pip on disk is the broken kind.

    ``_pip_available`` folds a stat that was refused and a probe that timed out
    into the same False as a genuinely half-installed pip. Answering all of
    them by deleting from site-packages would let one slow ``import pip`` on a
    loaded machine throw away the pip in a base the user installs into.
    """
    base, site, launcher = _base_with_half_installed_pip(monkeypatch, tmp_path)
    launcher.write_text("pip", encoding="utf-8")  # healthy: the launcher is there
    monkeypatch.setattr(
        base,
        "_pip_imports",
        lambda: False,  # what a 10s timeout or a refused read looks like
    )

    with pytest.raises(RuntimeError, match="Failed to install pip"):
        base._ensure_pip()

    assert sorted(path.name for path in site.iterdir()) == ["pip", "pip-25.2.dist-info"]
    assert (site / "pip-25.2.dist-info" / "RECORD").is_file()


def _base_with_half_installed_pip(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Build a base whose pip imports but has no launcher, and fake its python.

    The interpreter reports where site-packages is, so the fixture puts it
    somewhere no layout rule would guess: a test that hard-codes the same
    branch as the code cannot catch that branch being wrong.
    """
    base, *_rest = _shared_base(tmp_path)
    site = base.root / "somewhere" / "site-packages"
    site.mkdir(parents=True)
    (site / "pip").mkdir()
    (site / "pip-25.2.dist-info").mkdir()
    # Inside the metadata, so a caller can tell "never touched" from "deleted
    # and written again" -- the fake below recreates the directory, which on
    # its own would hide a deletion completely.
    (site / "pip-25.2.dist-info" / "RECORD").write_text("pip/__init__.py", encoding="utf-8")
    base.bin_dir.mkdir(parents=True)
    launcher = base.bin_dir / ("pip.exe" if os.name == "nt" else "pip")

    def fake_run(command, **_kwargs):
        argv = [str(part) for part in command]
        if "ensurepip" in argv:
            # Real ensurepip installs nothing -- and so writes no launcher --
            # while a dist-info records the version it bundles. Keying off the
            # package directory instead would model it backwards.
            if any(site.glob("pip-*.dist-info")):
                return subprocess.CompletedProcess(
                    command, 0, stdout="Requirement already satisfied: pip", stderr=""
                )
            (site / "pip-25.2.dist-info").mkdir(exist_ok=True)
            launcher.write_text("pip", encoding="utf-8")
            return subprocess.CompletedProcess(
                command, 0, stdout="Successfully installed pip-25.2", stderr=""
            )
        if "sysconfig" in argv[-1]:
            return subprocess.CompletedProcess(command, 0, stdout=f"{site}\n", stderr="")
        return subprocess.CompletedProcess(  # import pip
            command, 0 if (site / "pip").is_dir() else 1
        )

    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", fake_run)
    return base, site, launcher


def test_frozen_app_requires_bundled_python(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A damaged packaged app must not silently execute with host Python."""
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON", str(tmp_path / "missing-python"))

    with pytest.raises(RuntimeError, match="Bundled Python is unavailable"):
        BundledUPythonRuntime(
            uv_runtime=BundledUvRuntime(data_home=tmp_path),
            data_home=tmp_path,
        ).ensure()


def test_bundled_python_runtime_rejects_a_symlinked_parent(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Base staging and cleanup stay inside the app-owned Python directory."""
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is required for the shared base boundary test")
    data_home = tmp_path / "data"
    outside = tmp_path / "outside"
    data_home.mkdir()
    outside.mkdir()
    try:
        (data_home / "python").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable")
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(Path(uv).parent))
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON", sys.executable)

    with pytest.raises(RuntimeError, match="must not be a symlink"):
        BundledUPythonRuntime(
            uv_runtime=BundledUvRuntime(data_home=data_home),
            data_home=data_home,
        ).ensure()


def _stage_venv(command, **_kwargs):
    """Materialise the layout ``uv venv`` would leave in the staging directory."""
    stage = Path(command[-1])
    python = stage / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    (stage / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    return subprocess.CompletedProcess(command, 0, stdout="", stderr="")


def _shared_base(tmp_path: Path):
    """Build a shared base plus the inputs ``_create`` expects."""
    base = BundledUPythonRuntime(
        uv_runtime=BundledUvRuntime(data_home=tmp_path),
        data_home=tmp_path,
    )
    bundled_python = tmp_path / "bundled-python"
    bundled_python.write_text("python", encoding="utf-8")
    uv_executable = tmp_path / "uv"
    uv_executable.write_text("uv", encoding="utf-8")
    identity = {"python": str(bundled_python.resolve()), "pythonSha256": "test"}
    return base, uv_executable, bundled_python, identity


def _stage_replace_failing(times: int, on_fail=None):
    """Fail the staged swap ``times`` times, the way a held handle would."""
    real_replace = os.replace
    calls: list[tuple[str, str]] = []

    def replace(source, target):
        calls.append((str(source), str(target)))
        if ".base.stage." in str(source):
            staged = sum(1 for src, _ in calls if ".base.stage." in src)
            if staged <= times:
                if on_fail is not None:
                    on_fail(Path(target))
                # Windows raises this as WinError 5 when any file inside the
                # staged directory is still open elsewhere.
                raise PermissionError(errno.EACCES, "Access is denied")
        return real_replace(source, target)

    return replace, calls


def _detach_replace_failing(times: int):
    """Fail the detach of the previous base ``times`` times."""
    real_replace = os.replace
    calls: list[tuple[str, str]] = []

    def replace(source, target):
        calls.append((str(source), str(target)))
        if ".base.backup." in str(target):
            detached = sum(1 for _, dst in calls if ".base.backup." in dst)
            if detached <= times:
                raise PermissionError(errno.EACCES, "Access is denied")
        return real_replace(source, target)

    return replace, calls


def test_publish_retries_when_the_previous_base_is_locked(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The handle can sit in the outgoing base rather than the staged one.

    A daemon killed without a graceful shutdown leaves children holding
    ``base/Scripts/python.exe``, which denies the rename of ``base`` itself.
    That is the same transient failure and needs the same retry.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "previous.txt").write_text("keep", encoding="utf-8")
    monkeypatch.setattr(BundledUPythonRuntime, "PUBLISH_BACKOFF_SEC", 0)
    replace, _calls = _detach_replace_failing(times=2)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", _stage_venv)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.os.replace", replace)

    with caplog.at_level(logging.WARNING):
        base._create(uv_executable, bundled_python, identity)

    assert base._probe(base.root, identity).usable
    assert not (base.root / "previous.txt").exists()
    assert not list(base.root.parent.glob(".base.stage.*"))
    assert not list(base.root.parent.glob(".base.backup.*"))
    assert "attempt 3" in caplog.text


def test_publish_retries_transient_sharing_violation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A handle held inside the staged venv must not sink service startup.

    Windows Defender routinely opens the interpreter ``uv`` just copied, which
    makes renaming the staging directory fail for a few hundred milliseconds.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.parent.mkdir(parents=True)
    monkeypatch.setattr(BundledUPythonRuntime, "PUBLISH_BACKOFF_SEC", 0)
    replace, calls = _stage_replace_failing(times=2)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", _stage_venv)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.os.replace", replace)

    with caplog.at_level(logging.WARNING):
        base._create(uv_executable, bundled_python, identity)

    assert base._probe(base.root, identity).usable
    assert sum(1 for source, _ in calls if ".base.stage." in source) == 3
    assert not list(base.root.parent.glob(".base.stage.*"))
    assert not list(base.root.parent.glob(".base.backup.*"))
    assert "attempt 3" in caplog.text


def test_publish_redetaches_when_target_reappears(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A base that comes back mid-publish is detached again, not merged into.

    Retrying the swap alone cannot clear a destination that reappeared: on
    Windows an existing directory is exactly what makes ``os.replace`` fail.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.parent.mkdir(parents=True)
    monkeypatch.setattr(BundledUPythonRuntime, "PUBLISH_BACKOFF_SEC", 0)

    def resurrect(target: Path) -> None:
        target.mkdir(parents=True, exist_ok=True)
        (target / "intruder.txt").write_text("stale", encoding="utf-8")

    replace, calls = _stage_replace_failing(times=1, on_fail=resurrect)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", _stage_venv)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.os.replace", replace)

    base._create(uv_executable, bundled_python, identity)

    assert base._probe(base.root, identity).usable
    assert not (base.root / "intruder.txt").exists()
    assert sum(1 for source, _ in calls if ".base.stage." in source) == 2
    assert not list(base.root.parent.glob(".base.backup.*"))


def test_publish_aborts_and_preserves_backup_when_restore_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Losing the ability to put the previous base back is terminal.

    Retrying past a failed restore would stack swaps on a state we can no
    longer reason about, so the backup is left on disk for the next start.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "previous.txt").write_text("keep", encoding="utf-8")
    monkeypatch.setattr(BundledUPythonRuntime, "PUBLISH_BACKOFF_SEC", 0)

    real_replace = os.replace
    calls: list[tuple[str, str]] = []

    def replace(source, target):
        calls.append((str(source), str(target)))
        if ".base.stage." in str(source) or ".base.backup." in str(source):
            raise OSError("replace failed")
        return real_replace(source, target)

    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", _stage_venv)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.os.replace", replace)

    with pytest.raises(OSError, match="replace failed"):
        base._create(uv_executable, bundled_python, identity)

    assert len(calls) == 3
    backups = list(base.root.parent.glob(".base.backup.*"))
    assert len(backups) == 1
    assert (backups[0] / "previous.txt").read_text(encoding="utf-8") == "keep"
    assert not list(base.root.parent.glob(".base.stage.*"))


def _deny_lstat(monkeypatch: pytest.MonkeyPatch, *, name: str, times: int = -1):
    """Deny ``lstat`` on ``name`` the way a held Windows handle does."""
    real_lstat = Path.lstat
    denials: list[str] = []

    def deny(self: Path):
        if self.name == name and (times < 0 or len(denials) < times):
            denials.append(str(self))
            raise PermissionError(errno.EACCES, "Access is denied")
        return real_lstat(self)

    monkeypatch.setattr(Path, "lstat", deny)
    return denials


def _wire_ensure(monkeypatch: pytest.MonkeyPatch, base, uv_executable, bundled_python, identity):
    """Give ``ensure`` its packaged inputs without touching real resources."""
    monkeypatch.setattr(base, "bundled_executable", lambda: bundled_python)
    monkeypatch.setattr(base.uv_runtime, "bundled_executable", lambda: uv_executable)
    monkeypatch.setattr(base, "_runtime_identity", lambda _python: identity)
    monkeypatch.setattr(base, "_ensure_pip", lambda: None)
    monkeypatch.setattr(_probe, "PROBE_BACKOFF_SEC", 0)


def test_ensure_refuses_to_rebuild_a_base_it_cannot_read(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """An unreadable base is unknown, not broken, and must survive the round.

    Windows denies stat on a file another process holds exclusively, so a
    perfectly healthy environment reads as missing for as long as the handle
    lives. Rebuilding on that verdict is what turned a transient handle into a
    daemon that could not start.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    _wire_ensure(monkeypatch, base, uv_executable, bundled_python, identity)
    monkeypatch.setattr(
        base,
        "_create",
        lambda *_args: pytest.fail("an unreadable base was rebuilt"),
    )
    _deny_lstat(monkeypatch, name="pyvenv.cfg")

    with pytest.raises(EnvNotReady):
        base.ensure()

    monkeypatch.undo()
    assert (base.root / "pyvenv.cfg").read_text(encoding="utf-8") == "home = test\n"


def _deny_lstat_while_poisoned(monkeypatch: pytest.MonkeyPatch, *, marker: Path, name: str):
    """Deny ``lstat`` on ``name`` for as long as ``marker`` sits beside it.

    A base whose ACL no longer grants the running user denies every read until
    it is moved aside -- unlike the held handle ``_deny_lstat`` models, it never
    clears. Scoping the denial to the directory carrying ``marker`` reproduces
    exactly that and leaves the rebuilt base readable.
    """
    real_lstat = Path.lstat
    denials: list[str] = []

    def deny(self: Path):
        if self.name == name and (self.parent / marker.name).exists():
            denials.append(str(self))
            raise PermissionError(errno.EACCES, "Access is denied")
        return real_lstat(self)

    monkeypatch.setattr(Path, "lstat", deny)
    return denials


def test_a_base_that_never_becomes_readable_is_moved_aside_and_rebuilt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A permanently unreadable base must not strand the app forever.

    Waiting is the right answer only to a handle that clears. A base created
    under a different security context denies every read for good, and the
    daemon retried that verdict on a widening backoff until the user gave up on
    an app that only ever said it was still preparing.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    poisoned = base.root / "poisoned.marker"
    poisoned.write_text("acl", encoding="utf-8")
    _wire_ensure(monkeypatch, base, uv_executable, bundled_python, identity)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", _stage_venv)
    _deny_lstat_while_poisoned(monkeypatch, marker=poisoned, name="pyvenv.cfg")

    # Driven at the shipped count, one whole round per iteration, because the
    # streak living across rounds is the entire mechanism. A guard that resets
    # between rounds -- every bug this one has had -- never leaves this loop.
    for _ in range(_probe.QUARANTINE_AFTER_ROUNDS):
        with pytest.raises(EnvNotReady):
            base.ensure()
        assert not list(base.root.parent.glob(f"{_probe.QUARANTINE_PREFIX}*"))

    assert base.ensure() == base.python_executable

    monkeypatch.undo()
    quarantined = list(base.root.parent.glob(f"{_probe.QUARANTINE_PREFIX}*"))
    assert len(quarantined) == 1
    # Moved aside, never deleted, and onto the prefix every recovery path
    # already globs: nobody could read it, so nobody knows what it was worth.
    assert (quarantined[0] / "poisoned.marker").read_text(encoding="utf-8") == "acl"
    assert base._probe(base.root, identity).usable


def test_a_base_whose_handle_clears_keeps_everything_installed_in_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The packages in a base that comes back must survive the round trip.

    This is the guarantee the streak exists for, so it is asserted against the
    shipped :data:`~._probe.QUARANTINE_AFTER_ROUNDS` rather than a patched one:
    a base that reads as unreadable and then reads fine again is the healthy
    base behind a held handle, and it must never be moved aside.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    python = base.root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    (base.root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    (base.root / base.MANIFEST_NAME).write_text(json.dumps(identity), encoding="utf-8")
    installed = base.root / "lib" / "installed_package.py"
    installed.parent.mkdir(parents=True)
    installed.write_text("value = 1", encoding="utf-8")
    _wire_ensure(monkeypatch, base, uv_executable, bundled_python, identity)
    monkeypatch.setattr(
        base,
        "_create",
        lambda *_args: pytest.fail("a base that came back was rebuilt"),
    )
    denials = _deny_lstat(monkeypatch, name="pyvenv.cfg", times=_probe.PROBE_ATTEMPTS)

    with pytest.raises(EnvNotReady):
        base.ensure()

    # Same base, next retry, handle gone -- exactly what the supervisor does.
    assert base.ensure() == base.python_executable
    assert len(denials) == _probe.PROBE_ATTEMPTS
    assert installed.read_text(encoding="utf-8") == "value = 1"
    assert not list(base.root.parent.glob(f"{_probe.QUARANTINE_PREFIX}*"))


def test_a_base_that_cannot_be_moved_aside_stays_retryable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A blocked move is the transient case, so it must not trigger a rebuild.

    Windows refuses to rename a directory while any handle inside it is open,
    which is precisely the healthy-base-behind-a-handle state the tri-state
    probe exists to protect. Failing the move keeps the base and the retries.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    poisoned = base.root / "poisoned.marker"
    poisoned.write_text("held", encoding="utf-8")
    _wire_ensure(monkeypatch, base, uv_executable, bundled_python, identity)
    monkeypatch.setattr(
        base,
        "_create",
        lambda *_args: pytest.fail("a base that could not be moved aside was rebuilt"),
    )
    real_replace = os.replace
    moves: list[Path] = []

    def blocked(source, target):
        # Scoped to the base, and recorded: patching os.replace on the shared
        # module hits every caller in the interpreter, and a test that never
        # observes the block passes just as well with the feature removed.
        if Path(source) == base.root:
            moves.append(Path(source))
            raise PermissionError(errno.EACCES, "Access is denied")
        return real_replace(source, target)

    monkeypatch.setattr("src.amphi_agent.runtime._probe.os.replace", blocked)
    _deny_lstat_while_poisoned(monkeypatch, marker=poisoned, name="pyvenv.cfg")

    for _ in range(_probe.QUARANTINE_AFTER_ROUNDS + 1):
        with pytest.raises(EnvNotReady):
            base.ensure()

    monkeypatch.undo()
    assert moves == [base.root]
    assert (base.root / "pyvenv.cfg").read_text(encoding="utf-8") == "home = test\n"
    assert not list(base.root.parent.glob(f"{_probe.QUARANTINE_PREFIX}*"))


def test_probe_retries_a_read_that_clears_on_its_own(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The handle usually clears in milliseconds, so the probe re-reads first."""
    base, _uv_executable, _bundled_python, identity = _shared_base(tmp_path)
    python = base.root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    (base.root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    (base.root / base.MANIFEST_NAME).write_text(json.dumps(identity), encoding="utf-8")
    monkeypatch.setattr(_probe, "PROBE_BACKOFF_SEC", 0)
    denials = _deny_lstat(monkeypatch, name="pyvenv.cfg", times=2)

    probe = base._probe(base.root, identity)

    assert len(denials) == 2
    assert probe.result is _probe.ProbeResult.VALID


def test_ensure_still_rebuilds_a_base_that_reads_as_broken(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A base missing its marker files reads fine and is genuinely unusable."""
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "stale.txt").write_text("old", encoding="utf-8")
    _wire_ensure(monkeypatch, base, uv_executable, bundled_python, identity)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", _stage_venv)

    assert base.ensure() == base.python_executable
    assert not (base.root / "stale.txt").exists()
    assert base._probe(base.root, identity).usable


def test_recover_keeps_a_backup_it_cannot_read(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """An unreadable backup may be the last intact copy, so it is not deleted.

    The readable-but-incompatible sibling still goes, which is what makes this
    a targeted skip rather than a cleanup that gave up.
    """
    base, _uv_executable, _bundled_python, identity = _shared_base(tmp_path)
    base.root.parent.mkdir(parents=True)
    locked = base.root.parent / ".base.backup.locked"
    stale = base.root.parent / ".base.backup.aaa-stale"
    for backup in (locked, stale):
        backup.mkdir()
        (backup / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    (locked / "locked.marker").write_text("held", encoding="utf-8")
    monkeypatch.setattr(_probe, "PROBE_BACKOFF_SEC", 0)
    _deny_lstat(monkeypatch, name="locked.marker")
    real_probe = base._probe

    def probe(root: Path, probed_identity: dict[str, str]):
        if root == locked:
            return _probe.probe_base(root, lambda: _probe.is_regular_file(locked / "locked.marker"))
        return real_probe(root, probed_identity)

    monkeypatch.setattr(base, "_probe", probe)

    base._recover_interrupted_install(identity)

    assert locked.is_dir()
    assert not stale.exists()


# Captured before any test patches it. ``monkeypatch.setattr`` on a dotted
# path like ``_python_env.subprocess.run`` rebinds the attribute on the shared
# ``subprocess`` module object, so a test that stubs the venv builder also
# stubs every other caller in the process -- including this file's icacls.
_UNPATCHED_RUN = subprocess.run


@contextlib.contextmanager
def _stripped_dacl(path: Path):
    """Leave ``path`` with an empty DACL, then hand it back readable.

    ``icacls /inheritance:r`` copies nothing back, so a directory that only
    ever had inherited ACEs is left with none at all. Every read of its
    contents is then denied even for the owner, who keeps only READ_CONTROL
    and WRITE_DAC -- the shape the base had on the machine that reported this,
    and the reason the owner can still hand it back on the way out.

    Skips rather than passes when the poisoning does not take, and skips rather
    than raises when it cannot be applied at all: a test that cannot establish
    its precondition has proven nothing, and these run inside the packaging job
    that publishes the installer -- an environment probe must never be what
    stops a release from being built.
    """
    stripped = _UNPATCHED_RUN(
        ["icacls", str(path), "/inheritance:r"],
        capture_output=True,
        text=True,
    )

    def restore() -> None:
        for candidate in (path, *path.parent.glob(f"{_probe.QUARANTINE_PREFIX}*")):
            _UNPATCHED_RUN(
                [
                    "icacls",
                    str(candidate),
                    "/grant",
                    f"{getpass.getuser()}:(OI)(CI)F",
                    "/T",
                    "/C",
                ],
                capture_output=True,
            )

    if stripped.returncode != 0:
        pytest.skip(f"icacls could not strip the DACL: {stripped.stderr.strip()}")
    # A bare ``next(path.iterdir())`` turns an empty directory into
    # "generator raised StopIteration" out of ``__enter__``, which skips the
    # ``finally`` and leaves the DACL stripped for whatever runs next.
    entries = list(path.iterdir())
    assert entries, "the caller must put something in the base to probe"
    try:
        entries[0].lstat()
    except PermissionError:
        pass
    except OSError as exc:
        restore()
        pytest.skip(f"stripping the DACL denied reads the wrong way: {exc}")
    else:
        restore()
        pytest.skip("this runner keeps access to a stripped DACL")
    try:
        yield
    finally:
        restore()


@pytest.mark.skipif(sys.platform != "win32", reason="ACLs are a Windows behaviour")
def test_a_stripped_dacl_is_exactly_what_the_probe_calls_unreadable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Pin the reported failure to a real ACL, not a simulated one.

    Every other test here fakes the denial by patching ``Path.lstat``. This one
    builds the actual condition and checks the error the field reported --
    ``WinError 5`` rather than the sharing violation a merely-open file raises
    -- so the whole quarantine path is known to trigger on the real thing.
    """
    root = tmp_path / "base"
    root.mkdir()
    (root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    monkeypatch.setattr(_probe, "PROBE_BACKOFF_SEC", 0)

    with _stripped_dacl(root):
        probe = _probe.probe_base(
            root, lambda: _probe.is_regular_file(root / "pyvenv.cfg")
        )

    assert probe.result is _probe.ProbeResult.UNREADABLE
    assert isinstance(probe.error, PermissionError)
    assert probe.error.winerror == 5


@pytest.mark.skipif(sys.platform != "win32", reason="ACLs are a Windows behaviour")
def test_a_base_nobody_can_read_can_still_be_moved_aside(tmp_path: Path) -> None:
    """The assumption the whole fix rests on, checked against real Windows.

    Renaming needs delete access on the parent rather than on the base itself.
    If that were wrong the guard would strand the app exactly where it already
    was, so it is asserted rather than reasoned about.
    """
    root = tmp_path / "base"
    root.mkdir()
    (root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    target = tmp_path / f"{_probe.QUARANTINE_PREFIX}moved"

    with _stripped_dacl(root):
        os.replace(root, target)

    assert (target / "pyvenv.cfg").read_text(encoding="utf-8") == "home = test\n"
    assert not root.exists()


@pytest.mark.skipif(sys.platform != "win32", reason="exclusive handles are a Windows behaviour")
def test_an_open_handle_makes_the_move_impossible(tmp_path: Path) -> None:
    """The structural half of the protection, checked rather than claimed.

    A healthy base behind a held handle is what must never be quarantined.
    Windows refuses to rename a directory holding an open file, so that case
    cannot reach a rebuild even if the grace period were misconfigured to zero.
    """
    import ctypes

    root = tmp_path / "base"
    root.mkdir()
    (root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateFileW(
        str(root / "pyvenv.cfg"),
        0x80000000,  # GENERIC_READ
        0,  # dwShareMode — deny every other opener
        None,
        3,  # OPEN_EXISTING
        0x80,  # FILE_ATTRIBUTE_NORMAL
        None,
    )
    assert handle != -1, ctypes.get_last_error()
    try:
        with pytest.raises(OSError):
            os.replace(root, tmp_path / f"{_probe.QUARANTINE_PREFIX}blocked")
    finally:
        kernel32.CloseHandle(handle)

    assert (root / "pyvenv.cfg").read_text(encoding="utf-8") == "home = test\n"


@pytest.mark.skipif(sys.platform != "win32", reason="ACLs are a Windows behaviour")
def test_a_really_poisoned_base_heals_itself(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """End to end on the reported failure: poisoned base in, working base out.

    No patched ``lstat`` anywhere -- the denial comes from the filesystem, and
    ``ensure`` is the same entry point the daemon's supervisor calls.
    """
    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    (base.root / "installed_package.py").write_text("value = 1", encoding="utf-8")
    _wire_ensure(monkeypatch, base, uv_executable, bundled_python, identity)
    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", _stage_venv)

    with _stripped_dacl(base.root):
        for _ in range(_probe.QUARANTINE_AFTER_ROUNDS):
            with pytest.raises(EnvNotReady):
                base.ensure()
        assert base.ensure() == base.python_executable

    quarantined = list(base.root.parent.glob(f"{_probe.QUARANTINE_PREFIX}*"))
    assert len(quarantined) == 1
    assert (quarantined[0] / "installed_package.py").read_text(
        encoding="utf-8"
    ) == "value = 1"
    assert base._probe(base.root, identity).usable


@pytest.mark.skipif(sys.platform != "win32", reason="exclusive handles are a Windows behaviour")
def test_an_exclusive_handle_does_not_even_make_the_base_unreadable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """An open file is not what a denied read looks like, measured on Windows.

    ``CreateFileW`` with ``dwShareMode=0`` is what an installer or an antivirus
    scanner does to a freshly written interpreter, and this test asserted the
    probe answered it with ``EnvNotReady``. It never ran -- the Windows job
    takes a node-id whitelist and this was not on it -- and on a real runner it
    is simply false: ``os.lstat`` falls back to listing the parent directory
    when ``CreateFileW`` is refused, and no file handle blocks that. The probe
    reads the base as perfectly usable, which is the outcome that matters.
    """
    import ctypes

    base, uv_executable, bundled_python, identity = _shared_base(tmp_path)
    python = base.root / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    (base.root / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    (base.root / base.MANIFEST_NAME).write_text(json.dumps(identity), encoding="utf-8")
    _wire_ensure(monkeypatch, base, uv_executable, bundled_python, identity)
    monkeypatch.setattr(
        base,
        "_create",
        lambda *_args: pytest.fail("a base behind a held handle was rebuilt"),
    )

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateFileW(
        str(base.root / "pyvenv.cfg"),
        0x80000000,  # GENERIC_READ
        0,  # dwShareMode — deny every other opener
        None,
        3,  # OPEN_EXISTING
        0x80,  # FILE_ATTRIBUTE_NORMAL
        None,
    )
    assert handle != -1, ctypes.get_last_error()
    try:
        assert base.ensure() == base.python_executable
        assert (base.root / base.MANIFEST_NAME).is_file()
    finally:
        kernel32.CloseHandle(handle)

    assert base.ensure() == base.python_executable


def test_recover_aborts_when_root_removal_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A base that cannot be deleted must not be overwritten by ``os.replace``.

    Swapping onto leftovers surfaces as a second, far more confusing failure
    than the one that actually blocked the delete.
    """
    base, _uv_executable, _bundled_python, identity = _shared_base(tmp_path)
    base.root.mkdir(parents=True)
    (base.root / "damaged.txt").write_text("stuck", encoding="utf-8")
    backup = base.root.parent / ".base.backup.reusable"
    python = backup / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    (backup / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    (backup / base.MANIFEST_NAME).write_text(json.dumps(identity), encoding="utf-8")

    def refuse(*_args, **_kwargs):
        raise OSError("rmtree failed")

    monkeypatch.setattr("src.amphi_agent.runtime._python_env.shutil.rmtree", refuse)

    with pytest.raises(RuntimeError, match="damaged.txt|shared Python base"):
        base._recover_interrupted_install(identity)

    assert (base.root / "damaged.txt").read_text(encoding="utf-8") == "stuck"
    assert (backup / base.MANIFEST_NAME).is_file()


def test_bundled_python_rejects_manifest_path_escape(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "python-runtime"
    runtime.mkdir()
    outside = tmp_path / ("python.exe" if os.name == "nt" else "python3")
    outside.write_text("")
    (runtime / "runtime.json").write_text(json.dumps({"executable": f"../{outside.name}"}))
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON_RUNTIME_DIR", str(runtime))

    assert bundled_python_runtime.bundled_executable() is None


def test_bootstrap_is_idempotent(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Running twice does not prepend the bin dir a second time."""
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(tmp_path))
    env = {"PATH": "/usr/bin"}
    bundled_uv_runtime.bootstrap_env(env)
    bundled_uv_runtime.bootstrap_env(env)
    assert env["PATH"] == f"{tmp_path}{os.pathsep}/usr/bin"


def test_frozen_executable_resolves_packaged_resources(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    resources = tmp_path / "Resources"
    amphi = resources / "bin" / ("amphi.exe" if os.name == "nt" else "amphi")
    uv_bin = resources / "uv_runtime" / "bin"
    node_bin = resources / "node_runtime" / "bin"
    for directory in (amphi.parent, uv_bin, node_bin):
        directory.mkdir(parents=True)
    amphi.write_text("", encoding="utf-8")
    (node_bin / ("node.exe" if os.name == "nt" else "node")).write_text(
        "",
        encoding="utf-8",
    )
    for name in (
        "AMPHI_BUNDLED_BIN_DIR",
        "AMPHI_BUNDLED_RESOURCES_DIR",
        "AMPHI_BUNDLED_UV_BIN_DIR",
        "AMPHI_BUNDLED_UV_RUNTIME_DIR",
        "AMPHI_BUNDLED_NODE_RUNTIME_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(amphi))

    uv_runtime = BundledUvRuntime()
    node_runtime = BundledNodeRuntime(resources=uv_runtime.resources)

    assert uv_runtime.bundled_bin_dir() == str(amphi.parent)
    assert uv_runtime.resources.directory() == resources
    assert uv_runtime.bin_dir() == str(uv_bin)
    assert node_runtime.runtime_dir() == resources / "node_runtime"
    assert node_runtime.bin_dir() == node_bin


def test_environment_composition_prioritizes_bundled_cli_directory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import src.amphi_agent.runtime._environment as environment_module

    bundled_bin = tmp_path / "Resources" / "bin"
    bundled_bin.mkdir(parents=True)
    amphi = bundled_bin / ("amphi.exe" if os.name == "nt" else "amphi")
    amphi.write_text("", encoding="utf-8")
    monkeypatch.setattr(sys, "executable", str(amphi))
    shim = AgentCLIShim(tmp_path / "command-shims")
    monkeypatch.setattr(environment_module, "agent_cli_shim", shim)
    monkeypatch.setenv("AMPHI_BUNDLED_BIN_DIR", str(bundled_bin))
    monkeypatch.setenv("PATH", os.pathsep.join(("/usr/local/bin", "/usr/bin")))
    monkeypatch.setattr(bundled_uv_runtime, "bootstrap_env", lambda _env: None)
    monkeypatch.setattr(bundled_uv_runtime, "bundled_bin_dir", lambda: str(bundled_bin))
    monkeypatch.setattr(bundled_uv_runtime, "bin_dir", lambda: None)
    monkeypatch.setattr(bundled_python_runtime, "apply", lambda _env: None)
    monkeypatch.setattr(bundled_node_runtime, "bin_dir", lambda: None)
    monkeypatch.setattr(bundled_node_base_runtime, "apply", lambda _env: None)

    env = environment_module._compose_user_command_env()
    fresh = {"PATH": "/fresh/login/bin", "FRESH_LOGIN": "yes"}
    recomposed = environment_module._compose_user_command_env(fresh)

    assert env["PATH"].split(os.pathsep)[:2] == [str(shim.root), str(bundled_bin)]
    assert recomposed["PATH"].split(os.pathsep) == [
        str(shim.root),
        str(bundled_bin),
        "/fresh/login/bin",
    ]
    assert recomposed[AgentCLIShim.LAUNCHER_ENV] == str(amphi.absolute())
    assert recomposed["FRESH_LOGIN"] == "yes"
    assert fresh == {"PATH": "/fresh/login/bin", "FRESH_LOGIN": "yes"}


def test_environment_composition_prioritizes_source_daemon_cli_over_stale_install(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import src.amphi_agent.runtime._environment as environment_module

    daemon_bin = tmp_path / "checkout" / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    shared_python_bin = tmp_path / "shared-python" / "bin"
    shared_node_shim = tmp_path / "shared-node" / ".amphi" / "bin"
    shared_node_bin = tmp_path / "shared-node" / "bin"
    stale_bin = tmp_path / "installed-app" / "bin"
    daemon_bin.mkdir(parents=True)
    for directory in (shared_python_bin, shared_node_shim, shared_node_bin, stale_bin):
        directory.mkdir(parents=True)
    cli_name = "amphi.exe" if os.name == "nt" else "amphi"
    python_name = "python.exe" if os.name == "nt" else "python"
    launcher = daemon_bin / cli_name
    launcher.write_text("current", encoding="utf-8")
    launcher.chmod(0o755)
    for directory in (shared_python_bin, shared_node_shim, shared_node_bin, stale_bin):
        (directory / cli_name).write_text("stale", encoding="utf-8")
    monkeypatch.setattr(sys, "executable", str(daemon_bin / python_name))
    shim = AgentCLIShim(tmp_path / "command-shims")
    uv_runtime = Mock()
    uv_runtime.bundled_bin_dir.return_value = None
    uv_runtime.bin_dir.return_value = None
    python_runtime = Mock()
    python_runtime.bin_dir = shared_python_bin
    python_runtime.apply.side_effect = lambda env: env.update({
        "UV_PYTHON": str(shared_python_bin / python_name),
    })
    node_runtime = Mock()
    node_runtime.bin_dir.return_value = None
    node_base = Mock()
    node_base.root = shared_node_bin.parent
    node_base.shim_dir = shared_node_shim
    node_base.bin_dir = shared_node_bin
    node_base.apply.side_effect = lambda env: env.update({
        "npm_config_prefix": str(node_base.root),
    })
    monkeypatch.setattr(environment_module, "agent_cli_shim", shim)
    monkeypatch.setattr(environment_module, "bundled_uv_runtime", uv_runtime)
    monkeypatch.setattr(environment_module, "bundled_python_runtime", python_runtime)
    monkeypatch.setattr(environment_module, "bundled_node_runtime", node_runtime)
    monkeypatch.setattr(environment_module, "bundled_node_base_runtime", node_base)

    inherited = {"PATH": os.pathsep.join((str(stale_bin), "/usr/bin"))}
    env = environment_module._compose_user_command_env(inherited)

    assert env["PATH"].split(os.pathsep) == [
        str(shim.root),
        str(shared_node_shim),
        str(shared_python_bin),
        str(shared_node_bin),
        str(stale_bin),
        "/usr/bin",
    ]
    assert str(daemon_bin) not in env["PATH"].split(os.pathsep)
    assert env[AgentCLIShim.LAUNCHER_ENV] == str(launcher.absolute())


def test_agent_cli_shim_uses_a_posix_symlink_and_cleans_temporary_entry(tmp_path: Path) -> None:
    launcher = tmp_path / "daemon" / "amphi"
    launcher.parent.mkdir()
    launcher.write_text("launcher", encoding="utf-8")
    shim = AgentCLIShim(tmp_path / "shims", platform="posix")

    assert shim.prepare(launcher) == shim.root

    entry = shim.root / "amphi"
    assert entry.is_symlink()
    assert entry.resolve() == launcher.resolve()
    assert {path.name for path in shim.root.iterdir()} == {"amphi"}


def test_agent_cli_shim_uses_an_ascii_windows_forwarder(tmp_path: Path) -> None:
    launcher = tmp_path / "包含空格%SDK%" / "amphi.exe"
    launcher.parent.mkdir()
    launcher.write_text("launcher", encoding="utf-8")
    shim = AgentCLIShim(tmp_path / "shims", platform="nt")

    assert shim.prepare(launcher) == shim.root

    assert (shim.root / "amphi.cmd").read_bytes() == (
        b'@echo off\r\n"%AMPHI_AGENT_CLI_LAUNCHER%" %*\r\n'
    )
    assert {path.name for path in shim.root.iterdir()} == {"amphi.cmd"}


def test_bundled_uv_runtime_bin_dir_prefers_uv_runtime(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    resources = tmp_path / "Resources"
    amphi_bin = resources / "bin"
    uv_bin = resources / "uv_runtime" / "bin"
    amphi_bin.mkdir(parents=True)
    uv_bin.mkdir(parents=True)
    monkeypatch.setenv("AMPHI_BUNDLED_BIN_DIR", str(amphi_bin))

    assert bundled_uv_runtime.bin_dir() == str(uv_bin)


def test_bundled_uv_runtime_bin_dir_falls_back_to_legacy_bin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / ("uv.exe" if os.name == "nt" else "uv")).write_text("")
    monkeypatch.setenv("AMPHI_BUNDLED_BIN_DIR", str(bin_dir))

    assert bundled_uv_runtime.bin_dir() == str(bin_dir)


def test_uv_runtime_executable_prefers_the_bundle(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "uv-runtime" / "bin"
    bin_dir.mkdir(parents=True)
    executable = bin_dir / ("uv.exe" if os.name == "nt" else "uv")
    executable.write_text("", encoding="utf-8")
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(bin_dir))

    def fail_fallback(*_args, **_kwargs) -> None:
        raise AssertionError("PATH fallback used")

    monkeypatch.setattr(
        "src.amphi_agent.runtime._python_env.shutil.which",
        fail_fallback,
    )

    assert BundledUvRuntime().executable() == executable.resolve()


def test_uv_runtime_executable_falls_back_to_the_service_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    executable = tmp_path / ("uv.exe" if os.name == "nt" else "uv")
    executable.write_text("", encoding="utf-8")
    empty_bundle = tmp_path / "empty-bundle"
    empty_bundle.mkdir()
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(empty_bundle))
    monkeypatch.setenv("PATH", "/service/bin")

    def resolve_from_path(command, *, path):
        return str(executable) if (command, path) == ("uv", "/service/bin") else None

    monkeypatch.setattr(
        "src.amphi_agent.runtime._python_env.shutil.which",
        resolve_from_path,
    )

    assert BundledUvRuntime().executable() == executable.resolve()


def test_uv_runtime_version_is_normalized_and_cached(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    executable = tmp_path / ("uv.exe" if os.name == "nt" else "uv")
    executable.write_text("", encoding="utf-8")
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(tmp_path))
    runtime = BundledUvRuntime()
    calls: list[list[str]] = []

    def fake_run(command, **options):
        assert options["timeout"] == 5
        calls.append(list(command))
        return subprocess.CompletedProcess(
            command,
            0,
            stdout="uv 0.9.5 (test build)\n",
            stderr="",
        )

    monkeypatch.setattr("src.amphi_agent.runtime._python_env.subprocess.run", fake_run)

    assert runtime.version() == "0.9.5"
    assert runtime.version() == "0.9.5"
    runtime.reset_cache()
    assert runtime.version() == "0.9.5"
    assert calls == [[str(executable.resolve()), "--version"]] * 2


def test_uv_runtime_is_optional_when_neither_bundle_nor_path_has_uv(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    for name in (
        "AMPHI_BUNDLED_BIN_DIR",
        "AMPHI_BUNDLED_RESOURCES_DIR",
        "AMPHI_BUNDLED_UV_BIN_DIR",
        "AMPHI_BUNDLED_UV_RUNTIME_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(
        "src.amphi_agent.runtime._python_env.shutil.which",
        lambda _command, *, path: None,
    )
    runtime = BundledUvRuntime(
        resources=BundledRuntimeResources(source_root=tmp_path),
    )

    assert runtime.executable() is None
    assert runtime.version() is None


def test_runtime_discovery_is_cached_until_explicit_reset(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    uv_runtime = BundledUvRuntime(
        data_home=tmp_path,
        resources=BundledRuntimeResources(source_root=tmp_path),
    )
    uv_bin = tmp_path / "uv" / "bin"
    uv_bin.mkdir(parents=True)
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(uv_bin))

    assert uv_runtime.bin_dir() == str(uv_bin)
    monkeypatch.delenv("AMPHI_BUNDLED_UV_BIN_DIR")
    assert uv_runtime.bin_dir() == str(uv_bin)
    uv_runtime.reset_cache()
    assert uv_runtime.bin_dir() is None

    node_runtime = BundledNodeRuntime(resources=uv_runtime.resources)
    node_root = tmp_path / "node"
    node_bin = node_root / "bin"
    node_bin.mkdir(parents=True)
    (node_bin / "node").write_text("", encoding="utf-8")
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(node_root))

    assert node_runtime.bin_dir() == node_bin
    monkeypatch.delenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR")
    assert node_runtime.bin_dir() == node_bin
    node_runtime.reset_cache()
    assert node_runtime.bin_dir() is None


def test_node_runtime_resolves_posix_layout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """POSIX bundles expose the executable at ``<root>/bin/node``."""
    root = tmp_path / "node_runtime"
    executable = _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeRuntime()

    assert runtime.runtime_dir() == root
    assert runtime.bin_dir() == root / "bin"
    assert runtime.executable() == executable
    assert runtime.npm_cli() == (root / "lib/node_modules/npm/bin/npm-cli.js").resolve()
    assert runtime.npx_cli() == (root / "lib/node_modules/npm/bin/npx-cli.js").resolve()


def test_node_runtime_resolves_windows_layout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Windows bundles keep ``node.exe`` at the root, with no ``bin/`` at all."""
    root = tmp_path / "node_runtime"
    executable = _make_node_runtime(root, windows=True)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeRuntime()

    assert runtime.bin_dir() == root
    assert runtime.executable() == executable
    assert runtime.npm_cli() == (root / "node_modules/npm/bin/npm-cli.js").resolve()
    assert runtime.npx_cli() == (root / "node_modules/npm/bin/npx-cli.js").resolve()


def test_node_runtime_absent_in_dev_checkout(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Without a packaged bundle every accessor degrades to None, never raises."""
    monkeypatch.delenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR", raising=False)
    monkeypatch.setattr("sys.frozen", False, raising=False)
    runtime = BundledNodeRuntime(
        resources=BundledRuntimeResources(source_root=tmp_path),
    )

    assert runtime.runtime_dir() is None
    assert runtime.bin_dir() is None
    assert runtime.executable() is None

    env = {"PATH": "/usr/bin"}
    runtime.apply_path(env)
    assert env == {"PATH": "/usr/bin"}


def test_node_runtime_prepends_path_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The read-only runtime injects only its packaged Node executable."""
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeRuntime()

    env = {"PATH": f"/usr/bin{os.pathsep}/bin"}
    runtime.apply_path(env)
    runtime.apply_path(env)

    entries = env["PATH"].split(os.pathsep)
    assert str(root / "bin") in entries, "bundle must be on PATH"
    assert entries.index(str(root / "bin")) < entries.index("/usr/bin"), (
        "bundle must outrank the host PATH"
    )
    assert entries.count(str(root / "bin")) == 1, "apply_path must be idempotent"
    assert entries[-2:] == ["/usr/bin", "/bin"], "host PATH kept, just demoted"


def test_node_runtime_apply_path_seeds_empty_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeRuntime()

    env: dict[str, str] = {}
    runtime.apply_path(env)

    assert env["PATH"].split(os.pathsep) == [str(root / "bin")]


def test_node_base_forces_one_writable_environment_and_trusted_path_order(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Every npm command is pinned to one app-owned base, regardless of input."""
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    data_home = tmp_path / "data"
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    node_runtime = BundledNodeRuntime()
    runtime = BundledNodeBaseRuntime(node_runtime=node_runtime, data_home=data_home)

    env = {
        "PATH": os.pathsep.join(("/usr/local/bin", "/usr/bin")),
        "NPM_CONFIG_PREFIX": "/operator/prefix",
        "npm_CONFIG_cache": "/operator/cache",
        "NPM_CONFIG_GLOBAL": "false",
        "NODE_PATH": os.pathsep.join(("/operator/modules", str(runtime.modules_dir))),
        "NODE_OPTIONS": "--trace-warnings",
    }
    runtime.apply(env)
    runtime.apply(env)

    assert env["npm_config_prefix"] == str(data_home / "node" / "base")
    assert env["npm_config_cache"] == str(data_home / "node" / "cache")
    assert env["npm_config_global"] == "true"
    assert env["npm_config_npx_cache"] == str(runtime.root / ".amphi" / "npx")
    assert "NPM_CONFIG_PREFIX" not in env
    assert "npm_CONFIG_cache" not in env
    assert "NPM_CONFIG_GLOBAL" not in env
    assert env["PATH"].split(os.pathsep) == [
        str(runtime.shim_dir),
        str(root / "bin"),
        str(runtime.bin_dir),
        "/usr/local/bin",
        "/usr/bin",
    ]
    assert env["NODE_PATH"].split(os.pathsep) == [
        str(runtime.modules_dir),
    ]
    resolver_option = (
        f"--require {json.dumps(runtime.resolver_path.resolve().as_posix())}"
    )
    assert env["NODE_OPTIONS"].count(resolver_option) == 1
    assert "--trace-warnings" not in env["NODE_OPTIONS"]
    assert (runtime.shim_dir / "npm").is_file()
    assert (runtime.shim_dir / "npx").is_file()
    assert runtime.resolver_path.is_file()
    assert (runtime.root / runtime.MANIFEST_NAME).is_file()
    assert runtime.cache.is_dir()
    assert root not in runtime.root.parents


def test_node_base_is_a_noop_without_a_bundle_in_development(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """A source checkout does not manufacture an app base without packaged Node."""
    monkeypatch.delenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR", raising=False)
    monkeypatch.setattr("sys.frozen", False, raising=False)
    runtime = BundledNodeBaseRuntime(
        node_runtime=BundledNodeRuntime(
            resources=BundledRuntimeResources(source_root=tmp_path),
        ),
        data_home=tmp_path / "data",
    )

    env = {"PATH": "/usr/bin", "npm_config_prefix": "/operator/prefix"}
    runtime.apply(env)

    assert env == {"PATH": "/usr/bin", "npm_config_prefix": "/operator/prefix"}
    assert runtime.ensure() is None
    assert not runtime.root.exists()


def test_node_base_refuses_to_rebuild_a_base_it_cannot_read(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The Node base answers a denied stat exactly like the Python base does.

    Both bases sit under the same app data directory and meet the same held
    handles, so a probe that lies on one and not the other only moves which
    ecosystem loses its packages.
    """
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeBaseRuntime(
        node_runtime=BundledNodeRuntime(),
        data_home=tmp_path / "data",
    )
    assert runtime.ensure() == runtime.root
    package = runtime.modules_dir / "kept-package" / "index.js"
    package.parent.mkdir(parents=True)
    package.write_text("keep", encoding="utf-8")
    runtime.reset()
    monkeypatch.setattr(_probe, "PROBE_BACKOFF_SEC", 0)
    monkeypatch.setattr(
        runtime,
        "_create",
        lambda *_args: pytest.fail("an unreadable base was rebuilt"),
    )
    _deny_lstat(monkeypatch, name=runtime.MANIFEST_NAME)

    with pytest.raises(EnvNotReady):
        runtime.ensure()

    monkeypatch.undo()
    assert package.read_text(encoding="utf-8") == "keep"


def test_node_base_that_never_becomes_readable_is_moved_aside_and_rebuilt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The Node base leaves the same dead end the same way the Python base does.

    Both bases live under one app data directory and are created by the same
    process, so whatever poisons one poisons the other.
    """
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeBaseRuntime(
        node_runtime=BundledNodeRuntime(),
        data_home=tmp_path / "data",
    )
    assert runtime.ensure() == runtime.root
    package = runtime.modules_dir / "kept-package" / "index.js"
    package.parent.mkdir(parents=True)
    package.write_text("keep", encoding="utf-8")
    poisoned = runtime.root / "poisoned.marker"
    poisoned.write_text("acl", encoding="utf-8")
    runtime.reset()
    monkeypatch.setattr(_probe, "PROBE_BACKOFF_SEC", 0)
    _deny_lstat_while_poisoned(monkeypatch, marker=poisoned, name=runtime.MANIFEST_NAME)

    for _ in range(_probe.QUARANTINE_AFTER_ROUNDS):
        with pytest.raises(EnvNotReady):
            runtime.ensure()
    assert runtime.ensure() == runtime.root

    monkeypatch.undo()
    quarantined = list(runtime.root.parent.glob(f"{_probe.QUARANTINE_PREFIX}*"))
    assert len(quarantined) == 1
    kept = quarantined[0] / package.relative_to(runtime.root)
    assert kept.read_text(encoding="utf-8") == "keep"


def test_node_base_heals_when_only_its_support_files_are_unreadable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The Node base has a second way in, and it used to be a dead end.

    ``ensure`` probes this base up to three times per round, and a verdict that
    reset the streak on every readable probe could never age the one unreadable
    probe that came last -- the support files. The livelock this guard exists
    to end therefore survived, in the base that had a test claiming otherwise.

    The rebuild is checked too, not just the quarantine: reacting to a
    quarantined support-files verdict by refreshing shims writes them into a
    root that is no longer there, leaving a base holding the shims and nothing
    else, handed back as ready.
    """
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeBaseRuntime(
        node_runtime=BundledNodeRuntime(),
        data_home=tmp_path / "data",
    )
    assert runtime.ensure() == runtime.root
    package = runtime.modules_dir / "kept-package" / "index.js"
    package.parent.mkdir(parents=True)
    package.write_text("keep", encoding="utf-8")
    # Beside the resolver, so only the support-files probe is denied: the
    # identity probe never reads inside .amphi.
    poisoned = runtime.root / ".amphi" / "poisoned.marker"
    poisoned.write_text("acl", encoding="utf-8")
    runtime.reset()
    monkeypatch.setattr(_probe, "PROBE_BACKOFF_SEC", 0)
    _deny_lstat_while_poisoned(monkeypatch, marker=poisoned, name="resolver.cjs")

    for _ in range(_probe.QUARANTINE_AFTER_ROUNDS):
        with pytest.raises(EnvNotReady):
            runtime.ensure()
    assert runtime.ensure() == runtime.root

    monkeypatch.undo()
    assert (runtime.root / runtime.MANIFEST_NAME).is_file()
    assert runtime.modules_dir.is_dir()
    quarantined = list(runtime.root.parent.glob(f"{_probe.QUARANTINE_PREFIX}*"))
    assert len(quarantined) == 1
    kept = quarantined[0] / package.relative_to(runtime.root)
    assert kept.read_text(encoding="utf-8") == "keep"


def test_node_base_refreshes_support_files_without_discarding_packages(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A product-side resolver refresh preserves the compatible package tree."""
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeBaseRuntime(
        node_runtime=BundledNodeRuntime(),
        data_home=tmp_path / "data",
    )
    runtime.apply({"PATH": "/usr/bin"})
    package_marker = runtime.modules_dir / "kept-package" / "index.js"
    package_marker.parent.mkdir()
    package_marker.write_text("keep", encoding="utf-8")
    runtime.resolver_path.write_text("stale", encoding="utf-8")

    runtime.apply({"PATH": "/usr/bin"})

    assert package_marker.read_text(encoding="utf-8") == "keep"
    assert "registerHooks" in runtime.resolver_path.read_text(encoding="utf-8")


def test_node_base_uses_windows_global_layout_and_cmd_shims(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Windows global packages and executables live directly below the prefix."""
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=True)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    node_runtime = BundledNodeRuntime()
    runtime = BundledNodeBaseRuntime(node_runtime=node_runtime, data_home=tmp_path / "data")
    monkeypatch.setattr(runtime, "_is_windows", lambda: True)

    env = {"PATH": "/host/bin"}
    runtime.apply(env)

    assert runtime.modules_dir == runtime.root / "node_modules"
    assert runtime.bin_dir == runtime.root
    assert (runtime.shim_dir / "npm.cmd").is_file()
    assert (runtime.shim_dir / "npx.cmd").is_file()
    assert env["PATH"].split(os.pathsep) == [
        str(runtime.shim_dir),
        str(root),
        str(runtime.root),
        "/host/bin",
    ]


def test_node_base_resolves_cjs_and_esm_base_first_across_workspaces(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Both module systems resolve the one shared base before cwd packages."""
    root = tmp_path / "node_runtime"
    system_node, _bundled_node = _make_real_node_runtime(root)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    node_runtime = BundledNodeRuntime()
    runtime = BundledNodeBaseRuntime(
        node_runtime=node_runtime,
        data_home=tmp_path / "data with spaces",
    )
    env = {"PATH": os.environ.get("PATH", "")}
    runtime.apply(env)

    cjs = runtime.modules_dir / "amphi-shared-cjs"
    cjs.mkdir(parents=True)
    (cjs / "package.json").write_text(
        json.dumps({"name": "amphi-shared-cjs", "version": "1.0.0", "main": "index.cjs"}),
        encoding="utf-8",
    )
    (cjs / "index.cjs").write_text("module.exports = 'base-cjs';\n", encoding="utf-8")
    esm = runtime.modules_dir / "amphi-shared-esm"
    esm.mkdir(parents=True)
    (esm / "package.json").write_text(
        json.dumps({
            "name": "amphi-shared-esm",
            "version": "1.0.0",
            "type": "module",
            "exports": "./index.mjs",
        }),
        encoding="utf-8",
    )
    (esm / "index.mjs").write_text("export default 'base-esm';\n", encoding="utf-8")

    workspaces = [tmp_path / "session-a", tmp_path / "session-b"]
    for index, workspace in enumerate(workspaces):
        local_modules = workspace / "node_modules"
        local_cjs = local_modules / "amphi-shared-cjs"
        local_esm = local_modules / "amphi-shared-esm"
        local_cjs.mkdir(parents=True)
        local_esm.mkdir(parents=True)
        (local_cjs / "package.json").write_text(
            json.dumps({"main": "index.cjs"}), encoding="utf-8",
        )
        (local_cjs / "index.cjs").write_text(
            f"module.exports = 'local-cjs-{index}';\n", encoding="utf-8",
        )
        (local_esm / "package.json").write_text(
            json.dumps({"type": "module", "exports": "./index.mjs"}), encoding="utf-8",
        )
        (local_esm / "index.mjs").write_text(
            f"export default 'local-esm-{index}';\n", encoding="utf-8",
        )

    check = subprocess.run(
        [str(system_node), "--check", str(runtime.root / ".amphi" / "npm-proxy.cjs")],
        env=env,
        capture_output=True,
        text=True,
    )
    assert check.returncode == 0, check.stderr

    script = (
        "const cjs = require('amphi-shared-cjs'); "
        "import('amphi-shared-esm').then(({default: esm}) => "
        "process.stdout.write(`${cjs}|${esm}`));"
    )
    for workspace in workspaces:
        completed = subprocess.run(
            [str(system_node), "--eval", script],
            cwd=workspace,
            env=env,
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr
        assert completed.stdout == "base-cjs|base-esm"

        worker_script = """
const { Worker } = require('node:worker_threads');
const source = `
  const { parentPort } = require('node:worker_threads');
  const cjs = require('amphi-shared-cjs');
  import('amphi-shared-esm')
    .then(({ default: esm }) => parentPort.postMessage(cjs + '|' + esm))
    .catch((error) => { throw error; });
`;
const worker = new Worker(source, { eval: true });
worker.once('message', (value) => process.stdout.write(value));
worker.once('error', (error) => { console.error(error); process.exitCode = 1; });
"""
        worker = subprocess.run(
            [str(system_node), "--eval", worker_script],
            cwd=workspace,
            env=env,
            capture_output=True,
            text=True,
        )
        assert worker.returncode == 0, worker.stderr
        assert worker.stdout == "base-cjs|base-esm"


def test_node_base_install_is_visible_from_another_workspace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A real npm install writes only the base and is reusable from another cwd."""
    if os.name == "nt":
        pytest.skip("The real Windows layout is covered by packaged-app testing")
    root = tmp_path / "node_runtime"
    system_node, _bundled_node = _make_real_node_runtime(root)
    _attach_host_npm(root)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeBaseRuntime(
        node_runtime=BundledNodeRuntime(),
        data_home=tmp_path / "data",
    )
    env = {"PATH": os.environ.get("PATH", "")}
    runtime.apply(env)

    package = tmp_path / "package"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps({
            "name": "amphi-install-probe",
            "version": "1.0.0",
            "main": "index.cjs",
        }),
        encoding="utf-8",
    )
    (package / "index.cjs").write_text(
        "module.exports = 'shared-install';\n",
        encoding="utf-8",
    )
    first_workspace = tmp_path / "session-a"
    second_workspace = tmp_path / "session-b"
    first_workspace.mkdir()
    second_workspace.mkdir()

    installed = subprocess.run(
        ["npm", "install", str(package)],
        cwd=first_workspace,
        env=env,
        capture_output=True,
        text=True,
    )
    assert installed.returncode == 0, installed.stderr
    assert not (first_workspace / "node_modules").exists()
    assert not (first_workspace / "package-lock.json").exists()
    assert (runtime.modules_dir / "amphi-install-probe").exists()

    probe = subprocess.run(
        [str(system_node), "--eval", "console.log(require('amphi-install-probe'))"],
        cwd=second_workspace,
        env=env,
        capture_output=True,
        text=True,
    )
    assert probe.returncode == 0, probe.stderr
    assert probe.stdout.strip() == "shared-install"
    assert not (second_workspace / "node_modules").exists()


def test_node_base_npm_and_npx_shims_keep_installs_in_the_shared_base(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The trusted shims force npm and npx subprocesses onto the shared base."""
    root = tmp_path / "node_runtime"
    _system_node, _bundled_node = _make_real_node_runtime(root)
    npm_bin = root / "lib" / "node_modules" / "npm" / "bin"
    recorder = (
        "console.log(JSON.stringify({kind: '__KIND__', args: process.argv.slice(2), "
        "prefix: process.env.npm_config_prefix, cache: process.env.npm_config_cache, "
        "global: process.env.npm_config_global}));\n"
    )
    (npm_bin / "npm-cli.js").write_text(
        recorder.replace("__KIND__", "npm"), encoding="utf-8",
    )
    (npm_bin / "npx-cli.js").write_text(
        recorder.replace("__KIND__", "npx"), encoding="utf-8",
    )
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    node_runtime = BundledNodeRuntime()
    runtime = BundledNodeBaseRuntime(node_runtime=node_runtime, data_home=tmp_path / "data")
    env = {"PATH": os.environ.get("PATH", ""), "NPM_CONFIG_GLOBAL": "false"}
    runtime.apply(env)

    installed = subprocess.run(
        [
            "npm",
            "--prefix",
            "/operator/prefix",
            "--cache=/operator/cache",
            "--no-global",
            "install",
            "amphi-example@1.2.3",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )
    assert installed.returncode == 0, installed.stderr
    npm_record = json.loads(installed.stdout.strip())
    assert npm_record == {
        "kind": "npm",
        "args": [
            "--global",
            f"--prefix={runtime.root}",
            f"--cache={runtime.cache}",
            "install",
            "amphi-example@1.2.3",
        ],
        "prefix": str(runtime.root),
        "cache": str(runtime.cache),
        "global": "true",
    }

    executed = subprocess.run(
        ["npx", "amphi-example", "--help"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )
    assert executed.returncode == 0, executed.stderr
    records = [json.loads(line) for line in executed.stdout.splitlines()]
    assert records[0]["kind"] == "npm"
    assert records[0]["args"] == [
        "install", "--global", "--no-save", "amphi-example",
    ]
    assert records[1]["kind"] == "npx"
    assert records[1]["args"] == ["amphi-example", "--help"]
    assert all(record["prefix"] == str(runtime.root) for record in records)
    assert all(record["global"] == "true" for record in records)


def test_node_runtime_points_playwright_at_bundle(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    root = tmp_path / "node_runtime"
    executable = _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    _clear_playwright_node_path(monkeypatch)
    runtime = BundledNodeRuntime()

    runtime.apply_playwright_env()

    assert os.environ["PLAYWRIGHT_NODEJS_PATH"] == str(executable)


def test_node_runtime_respects_existing_playwright_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """An explicit PLAYWRIGHT_NODEJS_PATH wins over the bundle (tests / power users)."""
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    monkeypatch.setenv("PLAYWRIGHT_NODEJS_PATH", "/custom/node")
    runtime = BundledNodeRuntime()

    runtime.apply_playwright_env()

    assert os.environ["PLAYWRIGHT_NODEJS_PATH"] == "/custom/node"


def test_node_runtime_defers_to_playwright_vendor_copy_in_dev(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """In a dev checkout Playwright's own driver/node is left to resolve itself."""
    monkeypatch.delenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR", raising=False)
    _clear_playwright_node_path(monkeypatch)
    monkeypatch.setattr("sys.frozen", False, raising=False)
    monkeypatch.setattr(
        BundledNodeRuntime, "_playwright_vendored_node_exists", staticmethod(lambda: True)
    )
    runtime = BundledNodeRuntime(
        resources=BundledRuntimeResources(source_root=tmp_path),
    )

    runtime.apply_playwright_env()

    assert "PLAYWRIGHT_NODEJS_PATH" not in os.environ


def test_node_runtime_falls_back_to_system_node(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Last resort: a system node new enough for Playwright's driver."""
    monkeypatch.delenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR", raising=False)
    _clear_playwright_node_path(monkeypatch)
    monkeypatch.setattr("sys.frozen", False, raising=False)
    monkeypatch.setattr(
        BundledNodeRuntime, "_playwright_vendored_node_exists", staticmethod(lambda: False)
    )
    monkeypatch.setattr("shutil.which", lambda _name: "/usr/local/bin/node")
    monkeypatch.setattr(
        BundledNodeRuntime, "_major_version", staticmethod(lambda _exe: 22)
    )
    runtime = BundledNodeRuntime(
        resources=BundledRuntimeResources(source_root=tmp_path),
    )

    runtime.apply_playwright_env()

    assert os.environ["PLAYWRIGHT_NODEJS_PATH"] == "/usr/local/bin/node"


def test_node_runtime_rejects_too_old_system_node(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A system node below Playwright's floor is ignored rather than used blindly."""
    monkeypatch.delenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR", raising=False)
    _clear_playwright_node_path(monkeypatch)
    monkeypatch.setattr("sys.frozen", False, raising=False)
    monkeypatch.setattr(
        BundledNodeRuntime, "_playwright_vendored_node_exists", staticmethod(lambda: False)
    )
    monkeypatch.setattr("shutil.which", lambda _name: "/usr/local/bin/node")
    monkeypatch.setattr(
        BundledNodeRuntime, "_major_version", staticmethod(lambda _exe: 16)
    )
    runtime = BundledNodeRuntime(
        resources=BundledRuntimeResources(source_root=tmp_path),
    )

    runtime.apply_playwright_env()

    assert "PLAYWRIGHT_NODEJS_PATH" not in os.environ


def test_node_runtime_reads_version_from_manifest(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Version comes from runtime.json, never from spawning ``node --version``.

    It feeds the agent's ``<Workspace>`` block, which is rebuilt every turn, so
    a subprocess there would be paid on every single turn.
    """
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    (root / "runtime.json").write_text(
        json.dumps({
            "version": 1,
            "nodeVersion": "v22.23.1",
            "target": "darwin-arm64",
            "executable": "bin/node",
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeRuntime()

    assert runtime.version() == "v22.23.1"


def test_node_runtime_probes_packaged_executable_version_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "node_runtime"
    executable = _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeRuntime()
    calls: list[list[str]] = []

    def fake_run(command, **_options):
        calls.append(list(command))
        return subprocess.CompletedProcess(command, 0, stdout="v22.23.1\n", stderr="")

    monkeypatch.setattr("src.amphi_agent.runtime._node_env.subprocess.run", fake_run)

    assert runtime.executable_version() == "v22.23.1"
    assert runtime.executable_version() == "v22.23.1"
    assert calls == [[str(executable.resolve()), "--version"]]


def test_node_runtime_version_degrades_to_none(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """A missing, unparseable, or incomplete manifest never raises."""
    root = tmp_path / "node_runtime"
    _make_node_runtime(root, windows=False)
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(root))
    runtime = BundledNodeRuntime()

    assert runtime.version() is None                       # absent

    (root / "runtime.json").write_text("{not json", encoding="utf-8")
    assert runtime.version() is None                       # unparseable

    (root / "runtime.json").write_text(json.dumps({"version": 1}), encoding="utf-8")
    assert runtime.version() is None                       # no nodeVersion key


def test_node_runtime_version_none_without_bundle(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR", raising=False)
    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR", raising=False)
    monkeypatch.setattr("sys.frozen", False, raising=False)

    uv_runtime = BundledUvRuntime(
        resources=BundledRuntimeResources(source_root=tmp_path),
    )
    assert BundledNodeRuntime(resources=uv_runtime.resources).version() is None
