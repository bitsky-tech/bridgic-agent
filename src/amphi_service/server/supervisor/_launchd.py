"""macOS launchd supervisor for a per-user Bridgic Agent daemon."""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from ._base import (
    AutostartStatus,
    AutostartSupervisor,
    ServerLaunchSpec,
    SupervisorError,
    UnsupportedSupervisor,
)

LABEL = "ai.bridgic.agent.daemon"
NOT_FOUND_RETURN_CODES = frozenset({3, 113})


class LaunchdSupervisor(AutostartSupervisor):
    """Manage the Bridgic Agent per-user LaunchAgent.

    Parameters
    ----------
    runner : Callable[..., subprocess.CompletedProcess]
        Injectable command runner compatible with ``subprocess.run``.
    platform : str | None
        Platform override used by pure tests.
    home : Path | None
        Home-directory override used to locate the plist and logs.
    uid : int | None
        User identifier for the launchd GUI domain.
    """

    MANAGER = "launchd"
    COMMAND_TIMEOUT = 15.0

    def __init__(
        self,
        *,
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        platform: str | None = None,
        home: Path | None = None,
        uid: int | None = None,
    ) -> None:
        self.runner = runner
        self.platform = sys.platform if platform is None else platform
        self.home = Path.home() if home is None else Path(home)
        getuid = getattr(os, "getuid", lambda: 0)
        self.uid = getuid() if uid is None else uid

    @property
    def plist_path(self) -> Path:
        """Return the per-user LaunchAgent definition path."""
        return self.home / "Library" / "LaunchAgents" / f"{LABEL}.plist"

    @property
    def log_directory(self) -> Path:
        """Return the conventional per-user log directory."""
        return self.home / "Library" / "Logs" / "Amphi"

    @property
    def domain(self) -> str:
        return f"gui/{self.uid}"

    @property
    def target(self) -> str:
        return f"{self.domain}/{LABEL}"

    def render_plist(self, spec: ServerLaunchSpec) -> bytes:
        """Render a foreground LaunchAgent definition.

        ``EnvironmentVariables`` is not optional polish. Unlike the detached
        path — where the daemon inherits whoever ran the CLI — launchd hands a
        LaunchAgent a bare ``PATH=/usr/bin:/bin:/usr/sbin:/sbin`` and nothing
        else. Without this key the daemon cannot find ``uv``, and the failure
        surfaces much later as ``FileNotFoundError: 'uv'`` when the first
        conversation tries to create its workspace. See ``USER_ENVIRONMENT_KEYS``.

        Omitted entirely when the spec carries no environment, so a plist stays
        byte-identical to the pre-existing shape rather than gaining an empty
        dict that reads like a deliberate "run with nothing".
        """
        definition: dict[str, object] = {
            "Label": LABEL,
            "ProgramArguments": spec.argv,
            "WorkingDirectory": str(spec.working_directory),
            "RunAtLoad": True,
            "KeepAlive": {"SuccessfulExit": False},
            "ThrottleInterval": 30,
            "StandardOutPath": str(self.log_directory / "daemon.stdout.log"),
            "StandardErrorPath": str(self.log_directory / "daemon.stderr.log"),
        }
        if spec.environment:
            definition["EnvironmentVariables"] = dict(spec.environment)
        return plistlib.dumps(definition, fmt=plistlib.FMT_XML, sort_keys=False)

    def install(self, spec: ServerLaunchSpec) -> AutostartStatus:
        """Atomically install the LaunchAgent without loading or restarting it."""
        self._install_definition(spec)
        return AutostartStatus(
            manager=self.MANAGER,
            supported=True,
            enabled=True,
            active=None,
            definition=self.plist_path,
        )

    def _install_definition(self, spec: ServerLaunchSpec) -> None:
        """Persist a definition without inspecting or changing loaded state."""
        self._require_supported()
        try:
            self.plist_path.parent.mkdir(parents=True, exist_ok=True)
            self.log_directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise SupervisorError(
                f"could not create launchd directories under {self.home}"
            ) from exc
        self._write_definition(self.render_plist(spec))

    def enable(self, spec: ServerLaunchSpec) -> AutostartStatus:
        """Atomically install, reload, and start the LaunchAgent."""
        self._install_definition(spec)
        self._bootout()
        result = self._run(
            ("launchctl", "bootstrap", self.domain, str(self.plist_path))
        )
        self._require_success(result, "launchctl bootstrap")
        return self.status()

    def uninstall(self) -> AutostartStatus:
        """Remove the LaunchAgent definition without unloading the current job."""
        self._remove_definition()
        return AutostartStatus(
            manager=self.MANAGER,
            supported=True,
            enabled=False,
            active=None,
            definition=self.plist_path,
        )

    def _remove_definition(self) -> None:
        """Remove a persisted definition without inspecting loaded state."""
        self._require_supported()
        try:
            self.plist_path.unlink(missing_ok=True)
        except OSError as exc:
            raise SupervisorError(
                f"could not remove launchd definition {self.plist_path}"
            ) from exc

    def disable(self) -> AutostartStatus:
        """Boot out the LaunchAgent and remove its definition."""
        self._require_supported()
        self._bootout()
        if self._is_loaded():
            raise SupervisorError(
                f"launchd job {self.target} remains loaded after bootout"
            )
        self._remove_definition()
        return AutostartStatus(
            manager=self.MANAGER,
            supported=True,
            enabled=False,
            active=False,
            definition=self.plist_path,
        )

    def activate(self) -> AutostartStatus:
        """Start or restart an installed LaunchAgent."""
        self._require_supported()
        if self._is_loaded():
            result = self._run(("launchctl", "kickstart", "-k", self.target))
            self._require_success(result, "launchctl kickstart")
        else:
            result = self._run(
                ("launchctl", "bootstrap", self.domain, str(self.plist_path))
            )
            self._require_success(result, "launchctl bootstrap")
        return self.status()

    def deactivate(self) -> AutostartStatus:
        """Boot out the LaunchAgent while preserving its definition."""
        self._require_supported()
        self._bootout()
        if self._is_loaded():
            raise SupervisorError(
                f"launchd job {self.target} remains loaded after bootout"
            )
        return AutostartStatus(
            manager=self.MANAGER,
            supported=True,
            enabled=self.plist_path.exists(),
            active=False,
            definition=self.plist_path,
        )

    def status(self) -> AutostartStatus:
        """Return installation and load state using launchctl's exit status."""
        if not self._is_supported():
            return AutostartStatus(
                manager=self.MANAGER,
                supported=False,
                enabled=False,
                detail=f"launchd is unavailable on {self.platform}",
            )
        return AutostartStatus(
            manager=self.MANAGER,
            supported=True,
            enabled=self.plist_path.exists(),
            active=self._is_loaded(),
            definition=self.plist_path,
        )

    def _is_supported(self) -> bool:
        return self.platform == "darwin"

    def _require_supported(self) -> None:
        if not self._is_supported():
            raise UnsupportedSupervisor(f"launchd is unavailable on {self.platform}")

    def _is_loaded(self) -> bool:
        result = self._run(("launchctl", "print", self.target))
        if result.returncode == 0:
            return True
        if result.returncode in NOT_FOUND_RETURN_CODES:
            return False
        self._require_success(result, "launchctl print")
        return False

    def _bootout(self) -> None:
        result = self._run(("launchctl", "bootout", self.target))
        if (
            result.returncode != 0
            and result.returncode not in NOT_FOUND_RETURN_CODES
        ):
            self._require_success(result, "launchctl bootout")

    def _run(self, arguments: Sequence[str]) -> subprocess.CompletedProcess[str]:
        try:
            return self.runner(
                list(arguments),
                capture_output=True,
                text=True,
                check=False,
                timeout=self.COMMAND_TIMEOUT,
            )
        except subprocess.TimeoutExpired as exc:
            raise SupervisorError(
                f"{arguments[0]} timed out after {self.COMMAND_TIMEOUT:.0f}s"
            ) from exc
        except OSError as exc:
            raise SupervisorError(f"could not execute {arguments[0]}") from exc

    @staticmethod
    def _require_success(result: subprocess.CompletedProcess[Any], operation: str) -> None:
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            suffix = f": {detail}" if detail else ""
            raise SupervisorError(
                f"{operation} failed with exit code {result.returncode}{suffix}"
            )

    def _write_definition(self, contents: bytes) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            dir=self.plist_path.parent,
            prefix=f".{self.plist_path.name}.",
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                os.fchmod(handle.fileno(), 0o644)
                handle.write(contents)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.plist_path)
        except OSError as exc:
            raise SupervisorError(
                f"could not write launchd definition {self.plist_path}"
            ) from exc
        finally:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


__all__ = ["LABEL", "NOT_FOUND_RETURN_CODES", "LaunchdSupervisor"]
