"""Composition root for app-managed runtimes and user command environments.

The daemon may run inside a developer virtual environment, but commands run on
the user's behalf always use the app-owned uv, Python, and Node runtimes plus
one writable app-level base per ecosystem. Browser automation connects to the
Electron-owned Chromium through the bundled Node-backed Playwright driver.
"""

import asyncio
import contextlib
import logging
import os
import platform
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping, Optional

from ._errors import BundledRuntimeUnavailable, EnvNotReady
from ._node_env import BundledNodeBaseRuntime, BundledNodeRuntime
from ._python_env import BundledUPythonRuntime, BundledUvRuntime
from ._resources import BundledRuntimeResources
from ._shell_env import UserLoginShellEnvironment
from ._windows_env import WindowsUserEnvironment

logger = logging.getLogger(__name__)

# Readiness states reported to the daemon and, through it, to clients.
ENV_PREPARING = "preparing"
ENV_READY = "ready"
ENV_FAILED = "failed"

_REMOVED_COMMAND_ENV_NAMES = frozenset(name.casefold() for name in (
    "AMPHI_AGENT_CLI_LAUNCHER",
    "PLAYWRIGHT_NODEJS_PATH",
    "UV_PROJECT",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONUSERBASE",
    "PIP_PREFIX",
    "PIP_TARGET",
    "PIP_USER",
    "VIRTUAL_ENV",
    "UV_PROJECT_ENVIRONMENT",
))


@dataclass(frozen=True)
class AppEnvironmentStatus:
    """Immutable readiness verdict for the process-wide command environment."""

    state: str
    error: Optional[str] = None

    @property
    def retryable(self) -> bool:
        """Return whether another preparation attempt could still succeed."""
        return self.state != ENV_FAILED

    def unavailable_message(self) -> str:
        """Explain why no command environment is available yet.

        Agent commands surface this verbatim in the conversation, so it has to
        separate "wait a moment" from "this install is broken".
        """
        if self.state == ENV_FAILED:
            return f"The Agent runtime environment failed to prepare: {self.error}"
        if self.error:
            return (
                "The Agent runtime environment is still being prepared "
                f"(the last attempt failed with: {self.error})"
            )
        return "The Agent runtime environment is still being prepared"


@dataclass(frozen=True)
class AppCommandEnvironmentSnapshot:
    """Immutable process-level command environment and runtime metadata."""

    environment: Mapping[str, str]
    managed_environment: Mapping[str, str]
    uv_executable: Optional[Path]
    uv_version: Optional[str]
    python_executable: Optional[Path]
    python_version: Optional[str]
    node_executable: Optional[Path]
    node_version: Optional[str]

    def command_env(self) -> dict[str, str]:
        """Return an isolated mutable environment for one command."""
        return dict(self.environment)

    def compose(self, inherited: Mapping[str, str]) -> dict[str, str]:
        """Overlay immutable App runtime bindings onto a user environment."""
        result = dict(inherited)
        managed_names = {
            name.casefold() for name in self.managed_environment if name != "PATH"
        }
        removed_names = managed_names | _REMOVED_COMMAND_ENV_NAMES
        for name in list(result):
            if name.casefold() in removed_names:
                result.pop(name, None)

        inherited_path = result.pop("PATH", "")
        managed_path = self.managed_environment.get("PATH", "")
        managed_entries = [
            entry for entry in managed_path.split(os.pathsep) if entry
        ]
        normalized = {os.path.normcase(entry) for entry in managed_entries}
        inherited_entries = [
            entry
            for entry in inherited_path.split(os.pathsep)
            if entry and os.path.normcase(entry) not in normalized
        ]
        result.update(
            (name, value)
            for name, value in self.managed_environment.items()
            if name != "PATH"
        )
        result["PATH"] = os.pathsep.join([*managed_entries, *inherited_entries])
        return result


class WorkspaceEnvironment:
    """Bind the app-level runtime environment to one Agent Workspace."""

    _UNSAFE_USER_ENV_NAMES = frozenset({
        "BASHOPTS",
        "BASH_ENV",
        "BASH_XTRACEFD",
        "CDPATH",
        "ENV",
        "GLOBIGNORE",
        "IFS",
        "PROMPT_COMMAND",
        "PS4",
        "SHELLOPTS",
        "ZDOTDIR",
    })
    _UNSAFE_USER_ENV_PREFIXES = ("BASH_FUNC_", "DYLD_", "LD_")

    def __init__(self, session_root: Path) -> None:
        self.session_root = Path(session_root).expanduser().resolve()
        system = platform.uname()
        self.os_name = system.system
        self.os_release = system.release
        self.architecture = system.machine
        self._base_environment: Optional[dict[str, str]] = None
        self.uv_executable: Optional[Path] = None
        self.uv_version: Optional[str] = None
        self.python_executable: Optional[Path] = None
        self.python_version: Optional[str] = None
        self.node_executable: Optional[Path] = None
        self.node_version: Optional[str] = None
        self.login_shell_environment = UserLoginShellEnvironment()
        self.windows_user_environment = WindowsUserEnvironment()

    @staticmethod
    def prepare_app_environment() -> AppCommandEnvironmentSnapshot:
        """Prepare and publish the process-wide environment during App startup."""
        return app_command_environment.prepare()

    @staticmethod
    def app_environment_status() -> AppEnvironmentStatus:
        """Return the readiness of the startup-prepared process environment."""
        return app_command_environment.status()

    def prepare(self) -> None:
        """Bind the startup-published process snapshot to this Workspace."""
        if self._base_environment is not None:
            return
        snapshot = app_command_environment.snapshot()
        self._base_environment = snapshot.command_env()
        self.uv_executable = snapshot.uv_executable
        self.uv_version = snapshot.uv_version
        self.python_executable = snapshot.python_executable
        self.python_version = snapshot.python_version
        self.node_executable = snapshot.node_executable
        self.node_version = snapshot.node_version

    def subprocess_env(self) -> dict[str, str]:
        """Return a fresh app-injected environment for Workspace commands."""
        if self._base_environment is None:
            raise RuntimeError("Workspace environment has not been prepared")
        return dict(self._base_environment)

    async def bash_env(self, timeout_seconds: float) -> dict[str, str]:
        """Return a fresh platform user environment with app runtimes reapplied.

        Parameters
        ----------
        timeout_seconds : float
            Maximum time available to capture the user's current environment.

        Returns
        -------
        dict[str, str]
            An isolated environment for one platform shell command. Failed
            captures fall back to the startup-published snapshot.
        """
        fallback = self.subprocess_env()
        try:
            if self.os_name == "Windows":
                inherited = await asyncio.wait_for(
                    asyncio.to_thread(self.windows_user_environment.capture),
                    timeout=timeout_seconds,
                )
            else:
                inherited = await self.login_shell_environment.capture(
                    timeout_seconds=timeout_seconds,
                )
            if not inherited:
                raise RuntimeError("user environment capture returned no variables")
            sanitized = {
                name: value
                for name, value in inherited.items()
                if not self._is_unsafe_user_env_name(name)
            }
            return app_command_environment.compose(sanitized)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - environment refresh fails open to snapshot
            logger.warning(
                "Could not refresh the user command environment; "
                "using the startup environment snapshot"
            )
            return fallback

    @classmethod
    def _is_unsafe_user_env_name(cls, name: str) -> bool:
        normalized = name.upper()
        return (
            normalized in cls._UNSAFE_USER_ENV_NAMES
            or normalized.startswith(cls._UNSAFE_USER_ENV_PREFIXES)
        )


class AgentCLIShim:
    """Expose only the current daemon's ``amphi`` launcher on command PATH."""

    LAUNCHER_ENV = "AMPHI_AGENT_CLI_LAUNCHER"

    def __init__(self, root: Path, *, platform: Optional[str] = None) -> None:
        self.root = Path(root).expanduser()
        self.platform = os.name if platform is None else platform

    def prepare(self, launcher: Optional[Path]) -> Optional[Path]:
        """Atomically bind the platform shim to ``launcher`` and return its directory."""
        if launcher is None or not launcher.is_file():
            return None
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = self.root / ("amphi.cmd" if self.platform == "nt" else "amphi")
        temporary = self.root / (
            f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        temporary.unlink(missing_ok=True)
        try:
            if self.platform == "nt":
                temporary.write_bytes(
                    f'@echo off\r\n"%{self.LAUNCHER_ENV}%" %*\r\n'.encode("ascii")
                )
            else:
                temporary.symlink_to(launcher.absolute())
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return self.root


class AppCommandEnvironment:
    """Prepare and publish the single command environment used by all Workspaces."""

    def __init__(self, *, strict: bool = True) -> None:
        self.strict = strict
        self._lock = threading.Lock()
        self._snapshot: Optional[AppCommandEnvironmentSnapshot] = None
        self._status = AppEnvironmentStatus(ENV_PREPARING)

    def prepare(self) -> AppCommandEnvironmentSnapshot:
        """Prepare both shared bases once and atomically publish their environment."""
        with self._lock:
            if self._snapshot is not None:
                return self._snapshot
            try:
                snapshot = self._build()
            except BundledRuntimeUnavailable as exc:
                # A binary the installer never wrote does not appear on its
                # own, so record the verdict that stops the retry loop.
                self._status = AppEnvironmentStatus(ENV_FAILED, str(exc))
                raise
            except Exception as exc:
                # Everything else -- a held handle, a busy file lock, a peer
                # daemon mid-install -- clears without anyone intervening.
                self._status = AppEnvironmentStatus(ENV_PREPARING, str(exc))
                raise
            self._snapshot = snapshot
            self._status = AppEnvironmentStatus(ENV_READY)
            return snapshot

    def status(self) -> AppEnvironmentStatus:
        """Return the latest readiness verdict without waiting on preparation.

        Deliberately lock-free: :meth:`prepare` can hold the lock for minutes
        behind a cross-process file lock, and the callers here are the event
        loop answering a status request and an Agent command explaining why it
        cannot run. Reading one immutable attribute is safe without it.
        """
        return self._status

    def _build(self) -> AppCommandEnvironmentSnapshot:
        """Compose one snapshot from the freshly prepared shared bases."""
        if self.strict:
            self._validate_required_resources()

        environment = _compose_user_command_env()
        managed_environment = _compose_user_command_env({})
        injected_python = environment.get("UV_PYTHON")
        python_executable = Path(injected_python).expanduser() if injected_python else None
        uv_executable = (
            bundled_uv_runtime.bundled_executable()
            if self.strict
            else bundled_uv_runtime.executable()
        )
        node_executable = bundled_node_runtime.executable()
        return AppCommandEnvironmentSnapshot(
            environment=MappingProxyType(dict(environment)),
            managed_environment=MappingProxyType(dict(managed_environment)),
            uv_executable=uv_executable,
            uv_version=(
                bundled_uv_runtime.bundled_version()
                if self.strict
                else bundled_uv_runtime.version()
            ),
            python_executable=python_executable,
            python_version=(
                bundled_python_runtime.version()
                if python_executable is not None
                else None
            ),
            node_executable=node_executable,
            node_version=bundled_node_runtime.version(),
        )

    def snapshot(self) -> AppCommandEnvironmentSnapshot:
        """Return the prepared snapshot, failing closed in production."""
        snapshot = self._snapshot
        if snapshot is not None:
            return snapshot
        if self.strict:
            raise RuntimeError(self._status.unavailable_message())
        return self.prepare()

    def command_env(self) -> dict[str, str]:
        """Return an isolated command environment from the process snapshot."""
        return self.snapshot().command_env()

    def compose(self, inherited: Mapping[str, str]) -> dict[str, str]:
        """Apply app runtime invariants to a caller-supplied environment.

        This composes a call-local environment without replacing or mutating
        the process-wide snapshot published by :meth:`prepare`.
        """
        return self.snapshot().compose(inherited)

    def reset(self) -> None:
        """Discard the process snapshot without deleting either shared base."""
        with self._lock:
            self._snapshot = None
            self._status = AppEnvironmentStatus(ENV_PREPARING)

    @staticmethod
    def _validate_required_resources() -> None:
        resources_dir = bundled_runtime_resources.directory()
        requirements = {
            "uv executable": bundled_uv_runtime.bundled_executable(),
            "Python runtime": bundled_python_runtime.bundled_executable(),
            "Node executable": bundled_node_runtime.executable(),
            "npm entry point": bundled_node_runtime.npm_cli(),
            "npx entry point": bundled_node_runtime.npx_cli(),
        }
        missing = [name for name, value in requirements.items() if value is None]
        not_executable = [
            name
            for name in ("uv executable", "Python runtime", "Node executable")
            if (value := requirements[name]) is not None
            and os.name != "nt"
            and not os.access(value, os.X_OK)
        ]
        node_version_problem: Optional[str] = None
        if (
            requirements["Node executable"] is not None
            and "Node executable" not in not_executable
        ):
            declared_node_version = bundled_node_runtime.version()
            executable_node_version = bundled_node_runtime.executable_version()
            if declared_node_version is None:
                node_version_problem = "Node runtime manifest is missing or invalid"
            elif executable_node_version is None:
                node_version_problem = "Node executable did not report a valid version"
            elif executable_node_version != declared_node_version:
                node_version_problem = (
                    "Node manifest/executable version mismatch "
                    f"({declared_node_version} != {executable_node_version})"
                )
            else:
                match = executable_node_version.removeprefix("v").split(".")
                node_major_minor = (int(match[0]), int(match[1]))
                if node_major_minor < bundled_node_runtime.RESOLVER_MIN_VERSION:
                    minimum = ".".join(
                        str(part) for part in bundled_node_runtime.RESOLVER_MIN_VERSION
                    )
                    node_version_problem = (
                        f"Node {executable_node_version} is below resolver minimum v{minimum}"
                    )
        if not missing and not not_executable and node_version_problem is None:
            return
        location = str(resources_dir) if resources_dir is not None else "unresolved"
        problems = []
        if missing:
            problems.append(f"missing {', '.join(missing)}")
        if not_executable:
            problems.append(f"not executable: {', '.join(not_executable)}")
        if node_version_problem is not None:
            problems.append(node_version_problem)
        raise BundledRuntimeUnavailable(
            "App runtime resources are incomplete at "
            f"{location}: {'; '.join(problems)}. "
            "In a source checkout run cd desktop && bun run dev:resources; "
            "for an installed app, reinstall a complete build."
        )


_DATA_HOME = Path.home() / ".bridgic" / "AmphiAgent"
agent_cli_shim = AgentCLIShim(_DATA_HOME / "command-shims")

bundled_runtime_resources = BundledRuntimeResources()
bundled_uv_runtime = BundledUvRuntime(
    resources=bundled_runtime_resources,
    data_home=_DATA_HOME,
)
bundled_python_runtime = BundledUPythonRuntime(
    uv_runtime=bundled_uv_runtime,
    resources=bundled_runtime_resources,
    data_home=_DATA_HOME,
)
bundled_node_runtime = BundledNodeRuntime(resources=bundled_runtime_resources)
bundled_node_base_runtime = BundledNodeBaseRuntime(
    node_runtime=bundled_node_runtime,
    data_home=_DATA_HOME,
)
app_command_environment = AppCommandEnvironment()


def _compose_user_command_env(
    inherited_environment: Optional[Mapping[str, str]] = None,
) -> dict[str, str]:
    def daemon_cli_launcher() -> Optional[Path]:
        executable = Path(sys.executable).expanduser()
        cli_name = "amphi.exe" if os.name == "nt" else "amphi"
        candidate = (
            executable
            if executable.name.casefold() == cli_name.casefold()
            else executable.parent / cli_name
        )
        return candidate if candidate.is_file() else None

    def prioritize_path_entries(*directories: Optional[Path | str]) -> None:
        selected: list[str] = []
        normalized: set[str] = set()
        for directory in directories:
            if directory is None:
                continue
            value = str(directory)
            key = os.path.normcase(os.path.normpath(value))
            if key in normalized:
                continue
            selected.append(value)
            normalized.add(key)
        inherited = [
            entry
            for entry in result.get("PATH", "").split(os.pathsep)
            if entry and os.path.normcase(os.path.normpath(entry)) not in normalized
        ]
        result["PATH"] = os.pathsep.join([*selected, *inherited])

    result = (
        os.environ.copy()
        if inherited_environment is None
        else dict(inherited_environment)
    )
    result.pop(AgentCLIShim.LAUNCHER_ENV, None)
    result.pop("PLAYWRIGHT_NODEJS_PATH", None)
    bundled_uv_runtime.bootstrap_env(result)
    try:
        bundled_python_runtime.apply(result)
    except EnvNotReady:
        # One ACL change breaks both bases, and a base nobody asks about never
        # ages its own verdict. Stopping here would let Node start counting
        # only once Python healed -- by which point the retry ladder is at five
        # minutes apiece, so Node would heal minutes after Python instead of
        # alongside it. Its own failure is discarded; Python's is the one to
        # report, and this environment is thrown away either way.
        with contextlib.suppress(Exception):
            bundled_node_base_runtime.apply(result)
        raise
    bundled_node_base_runtime.apply(result)

    bundled_bin_dir = bundled_uv_runtime.bundled_bin_dir()
    uv_bin_dir = bundled_uv_runtime.bin_dir()
    daemon_launcher = daemon_cli_launcher()
    cli_shim_dir = agent_cli_shim.prepare(daemon_launcher)
    if daemon_launcher is not None and cli_shim_dir is not None:
        result[AgentCLIShim.LAUNCHER_ENV] = str(daemon_launcher.absolute())
    has_node_base = result.get("npm_config_prefix") == str(
        bundled_node_base_runtime.root
    )
    prioritize_path_entries(
        cli_shim_dir,
        bundled_node_base_runtime.shim_dir if has_node_base else None,
        bundled_node_runtime.bin_dir(),
        bundled_bin_dir if bundled_bin_dir and os.path.isdir(bundled_bin_dir) else None,
        uv_bin_dir if uv_bin_dir and os.path.isdir(uv_bin_dir) else None,
        bundled_python_runtime.bin_dir if result.get("UV_PYTHON") else None,
        bundled_node_base_runtime.bin_dir if has_node_base else None,
    )
    return result


__all__ = [
    "AgentCLIShim",
    "AppCommandEnvironment",
    "AppCommandEnvironmentSnapshot",
    "AppEnvironmentStatus",
    "WorkspaceEnvironment",
    "app_command_environment",
    "bundled_node_base_runtime",
    "bundled_node_runtime",
    "bundled_python_runtime",
    "bundled_runtime_resources",
    "bundled_uv_runtime",
]
