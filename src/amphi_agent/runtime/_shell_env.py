"""Probe the POSIX user's login-shell environment for a separate command shell."""

from __future__ import annotations

import asyncio
import math
import os
import secrets
import signal
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

try:
    import pwd as _pwd
except ImportError:  # pragma: no cover - the module is intentionally POSIX-only
    _pwd = None


DEFAULT_PROBE_TIMEOUT_SECONDS = 5.0
MAX_PROBE_OUTPUT_BYTES = 1_048_576
PROBE_COMMAND = "/usr/bin/printf '\\000%s\\000' '{marker}'; exec /usr/bin/env -0"

_LOGIN_SHELLS = frozenset({"bash", "zsh", "sh", "dash", "ksh"})
_TRANSIENT_ENVIRONMENT_KEYS = frozenset({"PWD", "OLDPWD", "SHLVL", "_"})
_LOCALE_ENVIRONMENT_KEYS = (
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
)


class UserLoginShellEnvironmentError(RuntimeError):
    """Base error for resolving or probing a POSIX login shell."""


class LoginShellResolutionError(UserLoginShellEnvironmentError):
    """The current POSIX user's login identity could not be resolved safely."""


class UnsupportedLoginShellError(UserLoginShellEnvironmentError):
    """The configured login shell is valid but has no supported probe syntax."""


class LoginShellProbeError(UserLoginShellEnvironmentError):
    """The login shell did not publish a usable exported environment."""


class LoginShellProbeTimeoutError(LoginShellProbeError):
    """The login-shell environment probe exceeded its bounded timeout."""


class LoginShellProbeOutputLimitError(LoginShellProbeError):
    """The login-shell environment probe exceeded its output limit."""


@dataclass(frozen=True)
class _LoginIdentity:
    name: str
    home: Path
    shell: Path


class UserLoginShellEnvironment:
    """Capture one fresh exported environment from the POSIX user's login shell.

    The probe starts from a deliberately small environment derived from the
    passwd entry and a narrow set of harmless host settings. It never inherits
    the daemon's ``PATH`` or application-private variables. The login shell is
    used only to emit its exported environment; callers remain responsible for
    deciding which values to import into an application command.

    Parameters
    ----------
    environ : Mapping[str, str], optional
        Source for ``SHELL``, ``TMPDIR``, and locale fallbacks. The process
        environment is consulted at capture time when omitted.
    uid : int, optional
        POSIX user id to resolve. Defaults to the current effective process
        user and exists primarily for isolated tests.
    """

    def __init__(
        self,
        *,
        environ: Optional[Mapping[str, str]] = None,
        uid: Optional[int] = None,
    ) -> None:
        self._environ = environ
        self._uid = uid

    async def capture(
        self, timeout_seconds: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    ) -> dict[str, str]:
        """Run the user's login shell and return its exported environment.

        Parameters
        ----------
        timeout_seconds : float
            Maximum time for shell startup and environment emission. Defaults
            to five seconds.

        Returns
        -------
        dict[str, str]
            Exported variables after removing probe-local shell bookkeeping.

        Raises
        ------
        LoginShellResolutionError
            If the passwd identity or every shell fallback is invalid.
        UnsupportedLoginShellError
            If a valid configured shell has unsupported command-line syntax.
        LoginShellProbeError
            If the shell fails or emits a malformed result.
        LoginShellProbeTimeoutError
            If startup exceeds ``timeout_seconds``.
        """
        timeout = self._validate_timeout(timeout_seconds)
        identity = self._resolve_identity()
        marker = secrets.token_hex(24)
        command = PROBE_COMMAND.format(marker=marker)
        argv = self._probe_argv(identity.shell, command)
        environment = self._clean_seed(identity)

        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(identity.home),
                env=environment,
                start_new_session=True,
            )
        except OSError as exc:
            raise LoginShellProbeError(
                f"Could not start login shell {identity.shell}: {exc}"
            ) from exc

        try:
            stdout, stderr = await asyncio.wait_for(
                self._read_process_output(process), timeout=timeout,
            )
        except asyncio.TimeoutError as exc:
            await self._kill_process_group(process)
            raise LoginShellProbeTimeoutError(
                f"Login shell {identity.shell} did not initialize within {timeout:g}s"
            ) from exc
        except LoginShellProbeOutputLimitError:
            await self._kill_process_group(process)
            raise
        except asyncio.CancelledError:
            await self._kill_process_group(process)
            raise
        except Exception:
            await self._kill_process_group(process)
            raise

        if process.returncode != 0:
            detail = self._error_detail(stderr, stdout)
            raise LoginShellProbeError(
                f"Login shell {identity.shell} failed with exit code "
                f"{process.returncode}: {detail}"
            )
        result = self._parse_environment(stdout, marker, identity.shell)
        result.update({
            "HOME": str(identity.home),
            "USER": identity.name,
            "LOGNAME": identity.name,
            "SHELL": str(identity.shell),
        })
        return result

    def _resolve_identity(self) -> _LoginIdentity:
        if _pwd is None or not hasattr(os, "getuid"):
            raise LoginShellResolutionError(
                "User login-shell probing is available only on POSIX"
            )
        uid = os.getuid() if self._uid is None else self._uid
        try:
            record = _pwd.getpwuid(uid)
        except (KeyError, OSError) as exc:
            raise LoginShellResolutionError(
                f"No passwd entry is available for uid {uid}"
            ) from exc

        name = getattr(record, "pw_name", "")
        home_value = getattr(record, "pw_dir", "")
        if not isinstance(name, str) or not name or "\0" in name:
            raise LoginShellResolutionError(
                f"The passwd entry for uid {uid} has no valid user name"
            )
        home = Path(home_value) if isinstance(home_value, str) else Path()
        if (
            not home_value
            or "\0" in home_value
            or not home.is_absolute()
            or not home.is_dir()
        ):
            raise LoginShellResolutionError(
                f"The passwd entry for user {name} has no valid home directory"
            )

        source = self._source_environment()
        shell = self._first_valid_shell(
            getattr(record, "pw_shell", ""),
            source.get("SHELL", ""),
            "/bin/bash",
        )
        if shell is None:
            raise LoginShellResolutionError(
                f"No executable login shell is available for user {name}"
            )
        return _LoginIdentity(name=name, home=home, shell=shell)

    def _clean_seed(self, identity: _LoginIdentity) -> dict[str, str]:
        source = self._source_environment()
        result = {
            "HOME": str(identity.home),
            "USER": identity.name,
            "LOGNAME": identity.name,
            "SHELL": str(identity.shell),
            "PATH": os.defpath,
            "TERM": "xterm-256color",
            "TMPDIR": self._safe_value(source.get("TMPDIR")) or "/tmp",
        }
        for key in _LOCALE_ENVIRONMENT_KEYS:
            if value := self._safe_value(source.get(key)):
                result[key] = value
        return result

    @staticmethod
    def _probe_argv(shell: Path, command: str) -> tuple[str, ...]:
        family = shell.name.casefold()
        if family in _LOGIN_SHELLS:
            return str(shell), "-l", "-i", "-c", command
        if family == "fish":
            return (
                str(shell),
                "--login",
                "--interactive",
                "--command",
                command,
            )
        raise UnsupportedLoginShellError(
            f"Unsupported login shell {shell}; supported shells are "
            "bash, zsh, sh, dash, ksh, and fish"
        )

    @staticmethod
    def _first_valid_shell(*candidates: Any) -> Optional[Path]:
        for value in candidates:
            if not isinstance(value, str) or not value or "\0" in value:
                continue
            candidate = Path(value)
            if (
                candidate.is_absolute()
                and candidate.is_file()
                and os.access(candidate, os.X_OK)
            ):
                return candidate
        return None

    def _source_environment(self) -> Mapping[str, str]:
        return os.environ if self._environ is None else self._environ

    @staticmethod
    def _safe_value(value: Any) -> Optional[str]:
        return value if isinstance(value, str) and value and "\0" not in value else None

    @staticmethod
    def _validate_timeout(value: float) -> float:
        if isinstance(value, bool):
            raise ValueError("timeout_seconds must be a positive finite number")
        try:
            timeout = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "timeout_seconds must be a positive finite number"
            ) from exc
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout_seconds must be a positive finite number")
        return timeout

    @staticmethod
    async def _kill_process_group(process: asyncio.subprocess.Process) -> None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
        try:
            await process.wait()
        except Exception:
            pass

    @classmethod
    async def _read_process_output(
        cls, process: asyncio.subprocess.Process,
    ) -> tuple[bytes, bytes]:
        async def read_limited(
            stream: Optional[asyncio.StreamReader], label: str,
        ) -> bytes:
            if stream is None:
                raise LoginShellProbeError(
                    f"Login shell probe did not expose a {label} stream"
                )
            result = bytearray()
            while chunk := await stream.read(65_536):
                result.extend(chunk)
                if len(result) > MAX_PROBE_OUTPUT_BYTES:
                    raise LoginShellProbeOutputLimitError(
                        f"Login shell probe {label} exceeded "
                        f"{MAX_PROBE_OUTPUT_BYTES} bytes"
                    )
            return bytes(result)

        readers = (
            asyncio.create_task(read_limited(process.stdout, "stdout")),
            asyncio.create_task(read_limited(process.stderr, "stderr")),
        )
        try:
            stdout, stderr = await asyncio.gather(*readers)
        except BaseException:
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            raise
        await process.wait()
        return stdout, stderr

    @staticmethod
    def _parse_environment(stdout: bytes, marker: str, shell: Path) -> dict[str, str]:
        sentinel = b"\0" + marker.encode("ascii") + b"\0"
        marker_index = stdout.rfind(sentinel)
        if marker_index < 0:
            raise LoginShellProbeError(
                f"Login shell {shell} exited without publishing its environment"
            )
        payload = stdout[marker_index + len(sentinel):]
        result: dict[str, str] = {}
        for item in payload.split(b"\0"):
            if not item:
                continue
            key_bytes, separator, value_bytes = item.partition(b"=")
            if not separator or not key_bytes:
                raise LoginShellProbeError(
                    f"Login shell {shell} emitted a malformed environment record"
                )
            key = os.fsdecode(key_bytes)
            if key in _TRANSIENT_ENVIRONMENT_KEYS:
                continue
            result[key] = os.fsdecode(value_bytes)
        return result

    @staticmethod
    def _error_detail(stderr: bytes, stdout: bytes) -> str:
        raw = stderr.strip() or stdout.strip()
        if not raw:
            return "(no output captured)"
        detail = os.fsdecode(raw)
        return detail if len(detail) <= 1000 else detail[:997] + "..."


__all__ = [
    "DEFAULT_PROBE_TIMEOUT_SECONDS",
    "MAX_PROBE_OUTPUT_BYTES",
    "LoginShellProbeError",
    "LoginShellProbeOutputLimitError",
    "LoginShellProbeTimeoutError",
    "LoginShellResolutionError",
    "PROBE_COMMAND",
    "UnsupportedLoginShellError",
    "UserLoginShellEnvironment",
    "UserLoginShellEnvironmentError",
]
