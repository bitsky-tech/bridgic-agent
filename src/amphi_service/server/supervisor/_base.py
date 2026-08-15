"""Shared server launch specifications and autostart contracts."""

from __future__ import annotations

import os
import sys
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType

PYINSTALLER_RESET_ENVIRONMENT = "PYINSTALLER_RESET_ENVIRONMENT"
WINDOWS_AUTOSTART_EXECUTABLE = "amphi-autostart.exe"

#: Environment variables carried from the invoking user's session into a daemon
#: that a process-owning supervisor launches for us.
#:
#: Deliberately an allowlist, not ``os.environ`` wholesale: everything here is
#: *user session* configuration the daemon's own subprocesses need, whereas the
#: daemon's private wiring must not be frozen into a launcher definition.
#:
#: ``PATH`` is the one that has already burned us — a launchd agent is handed
#: ``/usr/bin:/bin:/usr/sbin:/sbin`` and nothing else, so ``uv`` (installed under
#: ``~/.local/bin`` or similar) is unreachable and the first conversation dies on
#: ``FileNotFoundError: 'uv'``. The rest are included on the same reasoning: they
#: are user-level settings whose absence resurfaces as a differently-shaped
#: mystery (mojibake from a missing locale, hangs behind a corporate proxy).
USER_ENVIRONMENT_KEYS: tuple[str, ...] = (
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
)


@dataclass(frozen=True, slots=True)
class ServerLaunchSpec:
    """A server CLI command, its working directory, and the user environment.

    ``environment`` is the environment the daemon must be handed **when its
    launcher does not pass ours through**. Only supervisors that own the process
    consume it (launchd writes it into ``EnvironmentVariables``); the detached
    path deliberately ignores it and inherits the caller's *full* environment,
    which is strictly richer than this allowlist. See ``USER_ENVIRONMENT_KEYS``
    for why the field exists at all.
    """

    executable: Path
    arguments: tuple[str, ...]
    working_directory: Path
    environment: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "executable", Path(self.executable))
        object.__setattr__(self, "arguments", tuple(str(argument) for argument in self.arguments))
        object.__setattr__(self, "working_directory", Path(self.working_directory))
        # Read-only view: a spec is rendered into an on-disk launcher definition,
        # so a caller mutating it after the fact would silently desync the daemon
        # from what the plist says it runs with.
        object.__setattr__(
            self, "environment", MappingProxyType(dict(self.environment))
        )

    @property
    def argv(self) -> list[str]:
        """Return the complete argument vector accepted by subprocess APIs."""
        return [str(self.executable), *self.arguments]


class ServeCommand:
    """Build ``server serve`` and ``server start`` launch specifications.

    Parameters
    ----------
    executable : str | Path | None
        Python interpreter in source mode or the application executable in a
        frozen build. Defaults to ``sys.executable``.
    frozen : bool | None
        Whether the application is frozen. ``None`` detects ``sys.frozen``.
    environment : Mapping[str, str] | None
        Environment copied when a detached frozen child is launched.
    platform : str | None
        Platform override used by cross-platform launch-spec tests.
    source_root : str | Path | None
        Repository or installation root containing the ``src`` package.
    """

    def __init__(
        self,
        executable: str | Path | None = None,
        frozen: bool | None = None,
        environment: Mapping[str, str] | None = None,
        platform: str | None = None,
        source_root: str | Path | None = None,
    ) -> None:
        self.executable = Path(sys.executable if executable is None else executable)
        self.frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
        self.environment = os.environ if environment is None else environment
        self.platform = sys.platform if platform is None else platform
        self.source_root = (
            Path(__file__).resolve().parents[4]
            if source_root is None
            else Path(source_root)
        )

    def serve(
        self,
        host: str,
        port: int,
        log_level: str = "info",
    ) -> ServerLaunchSpec:
        """Return a foreground server launch specification."""
        return self._build("serve", host, port, log_level)

    def start(
        self,
        host: str,
        port: int,
        log_level: str = "info",
    ) -> ServerLaunchSpec:
        """Return a short-lived launcher suitable for login autostart."""
        return self._build("start", host, port, log_level)

    def _build(
        self,
        command: str,
        host: str,
        port: int,
        log_level: str,
    ) -> ServerLaunchSpec:
        command_arguments = (
            "server",
            command,
            "--host",
            host,
            "--port",
            str(port),
            "--log-level",
            log_level,
        )
        user_environment = self.user_environment()
        if self.frozen:
            executable = (
                self.executable.with_name(WINDOWS_AUTOSTART_EXECUTABLE)
                if command == "start" and self.platform.lower().startswith("win")
                else self.executable
            )
            return ServerLaunchSpec(
                executable=executable,
                arguments=command_arguments,
                working_directory=executable.parent,
                environment=user_environment,
            )
        return ServerLaunchSpec(
            executable=self.executable,
            arguments=("-m", "src", *command_arguments),
            working_directory=self.source_root,
            environment=user_environment,
        )

    def user_environment(self) -> dict[str, str]:
        """Snapshot the user-session variables from :attr:`environment`.

        Absent keys are omitted rather than blanked — writing ``PATH=""`` into a
        launcher definition would be worse than writing nothing, since it
        overrides whatever sane default the supervisor would have provided.

        Snapshot staleness is not a concern for launchd: ``_start_locked`` calls
        ``supervisor.enable(spec)`` on **every** start, which re-renders the
        plist, so the definition tracks the environment of the most recent start.
        """
        return {
            key: self.environment[key]
            for key in USER_ENVIRONMENT_KEYS
            if self.environment.get(key)
        }

    def build(
        self,
        host: str,
        port: int,
        log_level: str = "info",
    ) -> ServerLaunchSpec:
        """Alias for :meth:`serve` used by launch-spec builders."""
        return self.serve(host, port, log_level)

    def detached_environment(self) -> dict[str, str] | None:
        """Return the environment required by a detached frozen child."""
        if not self.frozen:
            return None
        environment = dict(self.environment)
        environment[PYINSTALLER_RESET_ENVIRONMENT] = "1"
        return environment


@dataclass(frozen=True, slots=True)
class AutostartStatus:
    """Portable effective status reported by an OS autostart manager.

    ``enabled`` means the platform would honor the registration, not merely
    that its definition exists. For example, a Windows Run value can remain
    registered while StartupApproved disables it.
    """

    manager: str
    supported: bool
    enabled: bool
    active: bool | None = None
    definition: Path | None = None
    detail: str | None = None


class SupervisorError(RuntimeError):
    """An operating-system supervisor operation failed."""


class UnsupportedSupervisor(SupervisorError):
    """The requested supervisor is unavailable on the current platform."""


class AutostartSupervisor(ABC):
    """Interface implemented by platform autostart providers."""

    owns_process = True
    """Whether this supervisor directly owns and can restart the daemon."""

    def install(self, spec: ServerLaunchSpec) -> AutostartStatus:
        """Install/update login startup without changing the current process."""
        raise UnsupportedSupervisor(
            f"{type(self).__name__} does not support configuration-only install"
        )

    def uninstall(self) -> AutostartStatus:
        """Remove login startup without changing the current process."""
        raise UnsupportedSupervisor(
            f"{type(self).__name__} does not support configuration-only uninstall"
        )

    @abstractmethod
    def enable(self, spec: ServerLaunchSpec) -> AutostartStatus:
        """Install/update login startup and apply this supervisor's lifecycle."""

    @abstractmethod
    def disable(self) -> AutostartStatus:
        """Remove login startup and apply this supervisor's lifecycle."""

    @abstractmethod
    def activate(self) -> AutostartStatus:
        """Activate the provider when it owns a process."""

    @abstractmethod
    def deactivate(self) -> AutostartStatus:
        """Deactivate the provider while preserving its configuration."""

    @abstractmethod
    def status(self) -> AutostartStatus:
        """Return the current autostart status."""


__all__ = [
    "AutostartStatus",
    "AutostartSupervisor",
    "PYINSTALLER_RESET_ENVIRONMENT",
    "ServeCommand",
    "ServerLaunchSpec",
    "SupervisorError",
    "USER_ENVIRONMENT_KEYS",
    "UnsupportedSupervisor",
    "WINDOWS_AUTOSTART_EXECUTABLE",
]
