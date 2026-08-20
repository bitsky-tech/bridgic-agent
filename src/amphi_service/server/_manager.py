"""Bridgic Agent service lifecycle management and local instance discovery."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, BinaryIO, ClassVar, Literal, Optional

from .supervisor._base import (
    AutostartStatus,
    AutostartSupervisor,
    ServeCommand,
    ServerLaunchSpec,
)


#: Relative runtime-directory parts, shared with supervisors that must derive
#: the same location from an injected home directory (see ``_launchd``).
RUNTIME_DIR_PARTS = (".bridgic", "AmphiAgent")
RUNTIME_DIR = Path.home().joinpath(*RUNTIME_DIR_PARTS)
RUNTIME_FILE = RUNTIME_DIR / "runtime.json"
#: Structured daemon log, written by the daemon's own rotating file handler
#: (see ``_logging``) on every supervisor path.
LOG_FILE = RUNTIME_DIR / "server.log"
#: Crash net: where supervisors point the daemon's raw stdout/stderr, catching
#: output produced before or outside the logging system (import-failure
#: tracebacks, stray prints). Deliberately NOT ``server.log`` — the daemon's
#: own stderr keeping that file open would make the rotating handler's rename
#: fail on Windows.
STDERR_LOG_FILE = RUNTIME_DIR / "daemon.stderr.log"
#: The stdout half of the same crash net. Only a process-owning supervisor
#: (launchd) splits the two streams; the detached path merges stdout into
#: ``STDERR_LOG_FILE``.
STDOUT_LOG_FILE = RUNTIME_DIR / "daemon.stdout.log"
LOCK_FILE = RUNTIME_DIR / "gateway.lock"
CONTROL_LOCK_FILE = RUNTIME_DIR / "control.lock"
DEFAULT_WS_PATH = "/ws"
WINDOWS_CREATE_NO_WINDOW = getattr(
    subprocess,
    "CREATE_NO_WINDOW",
    0x08000000,
)


class ServerError(RuntimeError):
    """Base error for service lifecycle operations."""


class ServerStartTimeout(ServerError):
    """The launched service failed to publish a healthy registration."""

    def __init__(
        self,
        *,
        timeout: float,
        log_path: Path,
        stderr_log_path: Optional[Path] = None,
        pid: Optional[int] = None,
        diagnostic: Optional[str] = None,
    ) -> None:
        process = f" (pid {pid})" if pid is not None else ""
        # Name both files: which one holds the answer depends on how far the
        # daemon got. ``server.log`` exists only once logging is configured,
        # so anything that killed the process before that (a failed import, a
        # missing dependency) is in the crash-net file instead.
        if diagnostic is None:
            diagnostic = f"Check the daemon log: {log_path}"
            if stderr_log_path is not None:
                diagnostic += (
                    f" (and {stderr_log_path} for a crash before logging started)"
                )
            diagnostic += "."
        super().__init__(
            f"Service was launched{process} but did not become ready within "
            f"{timeout:.1f}s. {diagnostic}"
        )
        self.pid = pid
        self.timeout = timeout
        self.log_path = log_path
        self.stderr_log_path = stderr_log_path
        self.diagnostic = diagnostic


class ServerInstanceLockHeld(ServerError):
    """Another process already owns the service instance lock."""


@dataclass(frozen=True)
class ServerLockState:
    """Stable kernel-lock state with optional modern owner metadata."""

    locked: bool
    owner_pid: Optional[int] = None


@dataclass(frozen=True)
class ServerOptions:
    """Configuration for one foreground service process."""

    host: str = "127.0.0.1"
    port: int = 7421
    log_level: str = "info"
    reload: bool = False


@dataclass(frozen=True)
class ServerInstance:
    """A service instance published in ``runtime.json``."""

    host: str
    port: int
    pid: int
    started_at: str
    token: Optional[str] = None
    lock_file: Optional[str] = None
    ws_path: str = DEFAULT_WS_PATH
    version: Optional[str] = None
    #: Where this daemon actually writes its structured log. ``None`` means
    #: file logging could not be set up (or a pre-log_file daemon wrote the
    #: registration) — clients then fall back to guessing, exactly as before.
    log_file: Optional[str] = None

    def base_url(self) -> str:
        """Return a loopback-safe HTTP base URL for this instance."""
        host = (
            "127.0.0.1"
            if self.host == "0.0.0.0"
            else "::1"
            if self.host == "::"
            else self.host
        )
        authority = f"[{host}]" if ":" in host else host
        return f"http://{authority}:{self.port}"

    def public_dict(self) -> dict[str, Any]:
        """Return the registration fields safe to expose through the CLI."""
        data = asdict(self)
        data.pop("token", None)
        return data


@dataclass(frozen=True)
class GatewayMeta:
    """In-process service metadata exposed by gateway handlers."""

    bind_host: Optional[str]
    bind_port: Optional[int]
    version: str
    started_at: str
    started_at_monotonic: float
    ws_path: str


@dataclass(frozen=True)
class ServerStatus:
    """Current discovery state of the local service."""

    state: Literal["running", "stopped", "stale"]
    runtime_file: Path
    instance: Optional[ServerInstance] = None

    def to_dict(self) -> dict[str, Any]:
        """Render the stable JSON payload consumed by Desktop."""
        if self.state == "stopped" or self.instance is None:
            return {
                "status": self.state,
                "runtime_file": str(self.runtime_file),
            }
        if self.state == "running":
            return {
                "status": "running",
                "host": self.instance.host,
                "port": self.instance.port,
                "base_url": self.instance.base_url(),
                "pid": self.instance.pid,
                "started_at": self.instance.started_at,
                "runtime_file": str(self.runtime_file),
                # The daemon's own answer to "where are the logs?". None when
                # file logging is degraded or the daemon predates the field —
                # clients fall back to guessing beside runtime_file.
                "log_file": self.instance.log_file,
            }
        return {
            "status": "stale",
            "registration": self.instance.public_dict(),
            "runtime_file": str(self.runtime_file),
            "note": "registration file present but pid/lock/socket probe failed",
        }


@dataclass(frozen=True)
class ServerStartResult:
    """Outcome of a background start or restart."""

    instance: ServerInstance
    started: bool
    owner: Literal["existing", "detached", "autostart"]


@dataclass(frozen=True)
class ServerStopResult:
    """Outcome of a stop request."""

    outcome: Literal["not_registered", "stale_cleared", "stopped"]
    pid: Optional[int] = None


@dataclass(frozen=True)
class AutostartResult:
    """Autostart configuration state plus the started service, if any."""

    status: AutostartStatus
    instance: Optional[ServerInstance] = None


class ServerRegistration:
    """Own atomic ``runtime.json`` persistence and liveness probing."""

    SOCKET_PROBE_TIMEOUT: ClassVar[float] = 0.5
    READY_POLL_INTERVAL: ClassVar[float] = 0.1

    def __init__(
        self,
        path: Path = RUNTIME_FILE,
        *,
        lock_path: Optional[Path] = None,
    ) -> None:
        self.path = path
        self.lock_path = lock_path or path.parent / LOCK_FILE.name

    def read(self) -> Optional[ServerInstance]:
        """Read a registration, returning ``None`` for missing or invalid data."""
        if not self.path.exists():
            return None
        try:
            data: dict[str, Any] = json.loads(self.path.read_text(encoding="utf-8"))
            return ServerInstance(
                host=str(data["host"]),
                port=int(data["port"]),
                pid=int(data["pid"]),
                started_at=str(data["started_at"]),
                token=self._optional_str(data.get("token")),
                lock_file=self._optional_str(data.get("lock_file")),
                ws_path=str(data.get("ws_path", DEFAULT_WS_PATH)),
                version=self._optional_str(data.get("version")),
                log_file=self._optional_str(data.get("log_file")),
            )
        except (
            KeyError,
            TypeError,
            ValueError,
            OSError,
            json.JSONDecodeError,
            UnicodeDecodeError,
        ):
            return None

    def write(
        self,
        *,
        instance_lock: ServerInstanceLock,
        host: str,
        port: int,
        pid: int,
        started_at: Optional[str] = None,
        token: Optional[str] = None,
        lock_file: Optional[Path] = None,
        ws_path: str = DEFAULT_WS_PATH,
        version: Optional[str] = None,
        log_file: Optional[Path] = None,
    ) -> ServerInstance:
        """Atomically publish a service instance with private file permissions."""
        self._require_instance_lock(instance_lock, operation="publishing")
        if instance_lock.owner_pid != pid:
            raise ServerError(
                f"Service registration pid {pid} does not own "
                f"the instance lock {self.lock_path}."
            )
        instance = ServerInstance(
            host=host,
            port=port,
            pid=pid,
            started_at=started_at or time.strftime("%Y-%m-%dT%H:%M:%S"),
            token=token,
            lock_file=str(lock_file) if lock_file is not None else None,
            ws_path=ws_path,
            version=version,
            log_file=str(log_file) if log_file is not None else None,
        )
        temporary = self.path.with_name(
            f".{self.path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(
                json.dumps(asdict(instance), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self._chmod_private(temporary)
            os.replace(temporary, self.path)
            self._chmod_private(self.path)
        except OSError as exc:
            raise ServerError(
                f"Could not publish service registration {self.path}."
            ) from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        return instance

    def clear(
        self,
        expected: ServerInstance,
        *,
        instance_lock: ServerInstanceLock,
    ) -> bool:
        """Delete ``expected`` while the caller owns the instance lock."""
        self._require_instance_lock(instance_lock, operation="clearing")
        if self.read() != expected:
            return False
        try:
            self.path.unlink()
        except FileNotFoundError:
            return False
        except OSError:
            return False
        return True

    def is_alive(self, instance: ServerInstance) -> bool:
        """Return whether the registered PID still owns the lock and socket."""
        lock_state = ServerInstanceLock.inspect(self.lock_path)
        return (
            self.pid_alive(instance.pid)
            and lock_state.locked
            and (
                lock_state.owner_pid is None
                or lock_state.owner_pid == instance.pid
            )
            and self._socket_open(instance.host, instance.port)
        )

    def wait_for_ready(
        self,
        *,
        host: str,
        port: int,
        timeout: float,
    ) -> Optional[ServerInstance]:
        """Poll until a matching, verified registration appears."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            instance = self.read()
            if (
                instance is not None
                and instance.host == host
                and instance.port == port
                and self.is_alive(instance)
            ):
                return instance
            time.sleep(self.READY_POLL_INTERVAL)
        return None

    @staticmethod
    def pid_alive(pid: int) -> bool:
        """Return whether ``pid`` identifies a process visible to this user."""
        if pid <= 0:
            return False
        if sys.platform == "win32":
            return ServerRegistration._pid_alive_windows(pid)
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError, OSError):
            return False
        return True

    @staticmethod
    def _pid_alive_windows(pid: int) -> bool:
        """Probe a Windows PID without requesting termination rights."""
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        error_access_denied = 5
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
        )
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

        handle = kernel32.OpenProcess(
            process_query_limited_information,
            False,
            pid,
        )
        if handle:
            kernel32.CloseHandle(handle)
            return True
        return ctypes.get_last_error() == error_access_denied

    @staticmethod
    def _optional_str(value: Any) -> Optional[str]:
        return None if value is None else str(value)

    @classmethod
    def _socket_open(cls, host: str, port: int) -> bool:
        target = "127.0.0.1" if host == "0.0.0.0" else "::1" if host == "::" else host
        try:
            with socket.create_connection(
                (target, port), timeout=cls.SOCKET_PROBE_TIMEOUT
            ):
                return True
        except OSError:
            return False

    @staticmethod
    def _chmod_private(path: Path) -> None:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def _require_instance_lock(
        self,
        instance_lock: ServerInstanceLock,
        *,
        operation: str,
    ) -> None:
        if not instance_lock.held or instance_lock.path != self.lock_path:
            raise ServerError(
                f"The service instance lock {self.lock_path} must be held while "
                f"{operation} registration."
            )


class ServerInstanceLock:
    """Hold a stable kernel lock and publish its current holder PID."""

    OWNER_OFFSET: ClassVar[int] = 1
    OWNER_STABILITY_DELAY: ClassVar[float] = 0.005
    OWNER_STABILITY_ATTEMPTS: ClassVar[int] = 3

    def __init__(self, path: Path = LOCK_FILE) -> None:
        self.path = path
        self._handle: Optional[BinaryIO] = None
        self._owner_pid: Optional[int] = None

    @property
    def held(self) -> bool:
        """Return whether this object currently owns the lock."""
        return self._handle is not None

    @property
    def owner_pid(self) -> Optional[int]:
        """Return the PID published by this lock object while it is held."""
        return self._owner_pid if self.held else None

    def acquire(self) -> None:
        """Acquire the lock without waiting."""
        if self.held:
            raise ServerInstanceLockHeld(
                f"Lock already held by this instance ({self.path})."
            )
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle = self.path.open("a+b")
        except OSError as exc:
            raise ServerError(f"Could not open service lock {self.path}.") from exc
        try:
            self._lock_handle(handle)
        except OSError as exc:
            handle.close()
            raise ServerInstanceLockHeld(
                f"Another service process holds {self.path}."
            ) from exc
        owner_pid = os.getpid()
        try:
            self._ensure_lock_byte(handle)
            self._write_owner(handle, owner_pid)
        except OSError as exc:
            try:
                self._unlock_handle(handle)
            finally:
                handle.close()
            raise ServerError(
                f"Could not publish the owner of service lock {self.path}."
            ) from exc
        self._handle = handle
        self._owner_pid = owner_pid

    def release(self) -> None:
        """Release the kernel lock while preserving its stable filesystem inode."""
        if self._handle is None:
            return
        try:
            if self._read_owner(self._handle) == self._owner_pid:
                self._write_owner(self._handle, None)
        except OSError:
            pass
        try:
            self._unlock_handle(self._handle)
        except OSError:
            pass
        self._handle.close()
        self._handle = None
        self._owner_pid = None

    @classmethod
    def inspect(cls, path: Path) -> ServerLockState:
        """Distinguish an unlocked file from legacy and PID-aware owners."""
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            handle = path.open("a+b")
        except OSError as exc:
            raise ServerError(f"Could not inspect service lock {path}.") from exc

        try:
            for _ in range(cls.OWNER_STABILITY_ATTEMPTS):
                before = cls._read_owner(handle)
                if cls._try_probe_lock(handle):
                    return ServerLockState(locked=False)
                time.sleep(cls.OWNER_STABILITY_DELAY)
                after = cls._read_owner(handle)
                if cls._try_probe_lock(handle):
                    return ServerLockState(locked=False)
                if before == after:
                    return ServerLockState(locked=True, owner_pid=before)
            return ServerLockState(locked=True)
        finally:
            handle.close()

    @classmethod
    def read_owner(cls, path: Path) -> Optional[int]:
        """Return an explicit owner PID, excluding free and legacy locks."""
        return cls.inspect(path).owner_pid

    @classmethod
    def _try_probe_lock(cls, handle: BinaryIO) -> bool:
        try:
            cls._lock_handle(handle)
        except OSError:
            return False
        try:
            return True
        finally:
            cls._unlock_handle(handle)

    @classmethod
    def _ensure_lock_byte(cls, handle: BinaryIO) -> None:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()

    @classmethod
    def _read_owner(cls, handle: BinaryIO) -> Optional[int]:
        handle.seek(cls.OWNER_OFFSET)
        try:
            owner = int(handle.read().decode("ascii").strip())
        except (UnicodeDecodeError, ValueError):
            return None
        return owner if owner > 0 else None

    @classmethod
    def _write_owner(cls, handle: BinaryIO, owner_pid: Optional[int]) -> None:
        handle.seek(0)
        handle.truncate(cls.OWNER_OFFSET)
        if owner_pid is not None:
            handle.seek(cls.OWNER_OFFSET)
            handle.write(str(owner_pid).encode("ascii"))
        handle.flush()
        try:
            os.fsync(handle.fileno())
        except OSError:
            pass

    @staticmethod
    def _lock_handle(handle: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return

        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def _unlock_handle(handle: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            return

        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class ServerControlLock:
    """Serialize lifecycle mutations across independent CLI processes."""

    POLL_INTERVAL: ClassVar[float] = 0.05

    def __init__(self, path: Path = CONTROL_LOCK_FILE, *, timeout: float) -> None:
        self._lock = ServerInstanceLock(path)
        self.timeout = max(0.0, timeout)

    def __enter__(self) -> ServerControlLock:
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self._lock.acquire()
                return self
            except ServerInstanceLockHeld:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ServerError(
                        f"Timed out waiting {self.timeout:.1f}s for "
                        f"lifecycle control lock {self._lock.path}."
                    )
                time.sleep(min(self.POLL_INTERVAL, remaining))

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        self._lock.release()


class ServerManager:
    """Coordinate service discovery, foreground execution, and supervisors."""

    DEFAULT_START_TIMEOUT: ClassVar[float] = 40.0
    DEFAULT_STOP_TIMEOUT: ClassVar[float] = 8.0
    STOP_POLL_INTERVAL: ClassVar[float] = 0.1
    SHUTDOWN_REQUEST_TIMEOUT: ClassVar[float] = 2.0
    PROCESS_COMMAND_TIMEOUT: ClassVar[float] = 15.0
    # taskkill's exit code cannot be trusted on its own: /T exits non-zero
    # when any enumerated child died during the sweep, and TerminateProcess
    # is asynchronous, so a kill that landed can leave the pid briefly
    # alive. The verdict is the pid's liveness after this grace window.
    TERMINATE_VERIFY_TIMEOUT: ClassVar[float] = 2.0

    def __init__(
        self,
        *,
        registration: Optional[ServerRegistration] = None,
        command: Optional[ServeCommand] = None,
        detached: Any = None,
        autostart: Optional[AutostartSupervisor] = None,
        platform: Optional[str] = None,
    ) -> None:
        self.registration = registration or ServerRegistration()
        self._platform = platform or sys.platform
        self.command = command or ServeCommand(platform=self._platform)
        self.log_path = self.registration.path.parent / LOG_FILE.name
        #: Where the supervisors point raw stdout/stderr. Holds whatever the
        #: daemon printed before (or instead of) configuring file logging, so
        #: it is the file that explains a daemon which never became ready.
        self.stderr_log_path = self.registration.path.parent / STDERR_LOG_FILE.name
        self.lock_path = getattr(
            self.registration,
            "lock_path",
            self.registration.path.parent / LOCK_FILE.name,
        )
        self.control_lock_path = self.registration.path.parent / CONTROL_LOCK_FILE.name
        self._detached = detached
        self._autostart = autostart

    def status(self) -> ServerStatus:
        """Return the current three-state service discovery snapshot."""
        instance = self.registration.read()
        if instance is None:
            return ServerStatus("stopped", self.registration.path)
        state: Literal["running", "stale"] = (
            "running" if self.registration.is_alive(instance) else "stale"
        )
        return ServerStatus(state, self.registration.path, instance)

    def start(
        self,
        options: ServerOptions = ServerOptions(),
        *,
        timeout: float = DEFAULT_START_TIMEOUT,
    ) -> ServerStartResult:
        """Start through an enabled process owner or a detached process."""
        with ServerControlLock(self.control_lock_path, timeout=timeout):
            return self._start_locked(options, timeout=timeout)

    def _start_locked(
        self,
        options: ServerOptions,
        *,
        timeout: float,
    ) -> ServerStartResult:
        """Start while the caller owns the lifecycle control lock."""
        current = self.status()
        if current.state == "running" and current.instance is not None:
            return ServerStartResult(current.instance, False, "existing")
        if current.instance is not None and not self._clear_registration(
            current.instance
        ):
            return self._wait_for_transition(options, timeout=timeout)
        if not self._instance_lock_available():
            return self._wait_for_transition(options, timeout=timeout)

        spec = self._launch_spec(options)
        supervisor = self._enabled_autostart_supervisor()
        diagnostic: Optional[str] = None
        if supervisor is not None:
            supervisor_status = supervisor.enable(spec)
            diagnostic = self._autostart_diagnostic(supervisor_status)
            owner: Literal["detached", "autostart"] = "autostart"
            pid = None
        else:
            pid = self._detached_supervisor().start(spec)
            owner = "detached"

        instance = self.registration.wait_for_ready(
            host=options.host,
            port=options.port,
            timeout=timeout,
        )
        if instance is None:
            raise ServerStartTimeout(
                timeout=timeout,
                log_path=self.log_path,
                stderr_log_path=self.stderr_log_path,
                pid=pid,
                diagnostic=diagnostic,
            )
        return ServerStartResult(instance, True, owner)

    def stop(
        self,
        *,
        timeout: float = DEFAULT_STOP_TIMEOUT,
        force: bool = False,
    ) -> ServerStopResult:
        """Stop the registered service without removing autostart configuration."""
        with ServerControlLock(self.control_lock_path, timeout=timeout):
            return self._stop_locked(timeout=timeout, force=force)

    def _stop_locked(self, *, timeout: float, force: bool) -> ServerStopResult:
        """Stop while the caller owns the lifecycle control lock."""
        supervisor = self._enabled_autostart_supervisor()
        instance = self.registration.read()
        initial_lock = self._instance_lock_state()
        if instance is None:
            if supervisor is not None:
                supervisor.deactivate()
            current_lock = self._instance_lock_state()
            if not current_lock.locked:
                if not initial_lock.locked:
                    return ServerStopResult("not_registered")
                return ServerStopResult("stopped", initial_lock.owner_pid)
            stopped_pid = self._stop_lock_owner(
                current_lock,
                timeout=timeout,
                force=force,
            )
            self._ensure_stopped_registration_cleared(stopped_pid=stopped_pid)
            return ServerStopResult("stopped", stopped_pid)

        if not self.registration.is_alive(instance):
            if supervisor is not None:
                supervisor.deactivate()
            current_lock = self._instance_lock_state()
            if current_lock.locked:
                stopped_pid = self._stop_lock_owner(
                    current_lock,
                    timeout=timeout,
                    force=force,
                )
                self._ensure_stopped_registration_cleared(
                    expected=instance,
                    stopped_pid=stopped_pid,
                )
                return ServerStopResult("stopped", stopped_pid)

            self._ensure_stopped_registration_cleared(expected=instance)
            if initial_lock.locked:
                return ServerStopResult(
                    "stopped",
                    initial_lock.owner_pid or instance.pid,
                )
            return ServerStopResult("stale_cleared", instance.pid)

        graceful = False if force else self._request_graceful_shutdown(instance)
        if graceful and self._wait_for_exit(instance.pid, timeout):
            if self._instance_lock_state().locked:
                raise ServerError(
                    f"Service instance lock {self.lock_path} remains held "
                    f"after pid {instance.pid} exited."
                )
            # Deactivate on the SUCCESS path too. Every other branch below
            # already does, and skipping it here made "stop" mean different
            # things depending on whether the graceful shutdown happened to
            # work: the job stayed loaded, `RunAtLoad` brought the daemon back
            # at the next login, and `autostart status` kept reporting
            # active=True (it reports job-loaded, not process-alive) while
            # nothing was running.
            if supervisor is not None:
                supervisor.deactivate()
            self._ensure_stopped_registration_cleared(
                expected=instance,
                stopped_pid=instance.pid,
            )
            return ServerStopResult("stopped", instance.pid)

        if supervisor is not None:
            supervisor.deactivate()
        current_lock = self._instance_lock_state()
        if current_lock.locked:
            stopped_pid = self._stop_lock_owner(
                current_lock,
                timeout=min(timeout, 2.0) if graceful else timeout,
                force=True if graceful else force,
            )
        else:
            stopped_pid = initial_lock.owner_pid or instance.pid

        self._ensure_stopped_registration_cleared(
            expected=instance,
            stopped_pid=stopped_pid,
        )
        return ServerStopResult("stopped", stopped_pid)

    def _stop_lock_owner(
        self,
        lock_state: ServerLockState,
        *,
        timeout: float,
        force: bool,
    ) -> int:
        """Stop an explicitly identified owner and require lock release."""
        if not lock_state.locked or lock_state.owner_pid is None:
            raise ServerError(
                f"Service instance lock {self.lock_path} is held without "
                "verifiable owner metadata; refusing an unsafe process kill."
            )
        owner_pid = lock_state.owner_pid
        self._stop_process(owner_pid, timeout=timeout, force=force)
        remaining = self._instance_lock_state()
        if remaining.locked:
            detail = (
                f"pid {remaining.owner_pid}"
                if remaining.owner_pid is not None
                else "a legacy owner"
            )
            raise ServerError(
                f"Service instance lock {self.lock_path} remains held by {detail}."
            )
        return owner_pid

    def _stop_process(self, pid: int, *, timeout: float, force: bool) -> None:
        """Terminate ``pid`` and fail if the process survives the hard fallback."""
        if not self._terminate(pid, force=force):
            return
        if self._wait_for_exit(pid, timeout):
            return
        if not force:
            if not self._terminate(pid, force=True):
                return
        if (
            not self._wait_for_exit(pid, min(timeout, 2.0))
            and self._instance_lock_state().owner_pid == pid
        ):
            raise ServerError(
                f"Service pid {pid} did not exit after forced termination."
            )

    def restart(
        self,
        options: ServerOptions = ServerOptions(),
        *,
        start_timeout: float = DEFAULT_START_TIMEOUT,
        stop_timeout: float = DEFAULT_STOP_TIMEOUT,
        force: bool = False,
    ) -> ServerStartResult:
        """Stop, preserve autostart configuration, and start by platform policy."""
        with ServerControlLock(
            self.control_lock_path,
            timeout=max(0.0, start_timeout) + max(0.0, stop_timeout),
        ):
            self._stop_locked(timeout=stop_timeout, force=force)
            return self._start_locked(options, timeout=start_timeout)

    def serve(self, options: ServerOptions = ServerOptions()) -> bool:
        """Run the service in the foreground; return false on an owned lock."""
        from ._uvicorn import UvicornRunner

        runner = UvicornRunner(
            registration=self.registration,
            instance_lock=ServerInstanceLock(self.lock_path),
        )
        try:
            runner.run(options)
        except ServerInstanceLockHeld:
            return False
        return True

    def enable_autostart(
        self,
        options: ServerOptions,
        *,
        timeout: float = DEFAULT_START_TIMEOUT,
    ) -> AutostartResult:
        """Enable platform autostart and ensure the service is running."""
        with ServerControlLock(
            self.control_lock_path,
            timeout=max(0.0, timeout) + self.DEFAULT_STOP_TIMEOUT,
        ):
            supervisor = self._require_autostart_supervisor()
            self._stop_locked(timeout=self.DEFAULT_STOP_TIMEOUT, force=False)

            status = supervisor.enable(
                self._autostart_spec(supervisor, options)
            )
            pid = None
            if not getattr(supervisor, "owns_process", True):
                pid = self._detached_supervisor().start(
                    self._launch_spec(options)
                )
            instance = self.registration.wait_for_ready(
                host=options.host,
                port=options.port,
                timeout=timeout,
            )
            if instance is None:
                raise ServerStartTimeout(
                    timeout=timeout,
                    log_path=self.log_path,
                    stderr_log_path=self.stderr_log_path,
                    pid=pid,
                    diagnostic=self._autostart_diagnostic(status),
                )
            return AutostartResult(status, instance)

    def disable_autostart(
        self,
        *,
        timeout: float = DEFAULT_STOP_TIMEOUT,
    ) -> AutostartResult:
        """Stop the service and remove its platform autostart configuration."""
        with ServerControlLock(self.control_lock_path, timeout=timeout):
            supervisor = self._require_autostart_supervisor()
            self._stop_locked(timeout=timeout, force=False)
            status = supervisor.disable()
            return AutostartResult(status)

    def configure_autostart(
        self,
        enabled: bool,
        options: ServerOptions = ServerOptions(),
        *,
        timeout: float = DEFAULT_STOP_TIMEOUT,
    ) -> AutostartResult:
        """Change login startup without stopping, starting, or adopting a service.

        This is the settings-toggle contract.  It deliberately differs from
        :meth:`enable_autostart` and :meth:`disable_autostart`, whose historical
        lifecycle side effects remain available to installers and operators.
        """
        with ServerControlLock(self.control_lock_path, timeout=timeout):
            supervisor = self._require_autostart_supervisor()
            status = (
                supervisor.install(self._autostart_spec(supervisor, options))
                if enabled
                else supervisor.uninstall()
            )
            return AutostartResult(status)

    def repair_autostart(self, options: ServerOptions) -> AutostartStatus:
        """Point the existing autostart registration at this installation.

        Distinct from :meth:`enable_autostart` in two ways that matter to the
        Windows installer, which is the only caller:

        * It never starts the service. The installer runs before the new bundle
          has been launched even once, and spawning a daemon from inside an
          installer is what used to flash a console window mid-install.
        * It never takes the control lock or stops a running service. By the
          time ``customInstall`` runs, the installer has already stopped the
          daemon; grabbing the lock here would only add a way to deadlock.

        Providers that do not implement ``repair`` (launchd) are a no-op: they
        re-render their definition on every start anyway, so there is nothing an
        installer needs to fix up.
        """
        supervisor = self._optional_autostart_supervisor()
        repair = getattr(supervisor, "repair", None) if supervisor is not None else None
        if supervisor is None or repair is None:
            return self.autostart_status()
        return repair(self._autostart_spec(supervisor, options))

    def autostart_status(self) -> AutostartStatus:
        """Return autostart state without loading the service runtime."""
        supervisor = self._optional_autostart_supervisor()
        if supervisor is None:
            return AutostartStatus(
                manager="none",
                supported=False,
                enabled=False,
                active=False,
                detail=f"Autostart is unsupported on {self._platform}.",
            )
        return supervisor.status()

    def _launch_spec(self, options: ServerOptions) -> ServerLaunchSpec:
        return self.command.serve(
            host=options.host,
            port=options.port,
            log_level=options.log_level,
        )

    def _autostart_spec(
        self,
        supervisor: AutostartSupervisor,
        options: ServerOptions,
    ) -> ServerLaunchSpec:
        if getattr(supervisor, "owns_process", True):
            return self._launch_spec(options)
        return self.command.start(
            host=options.host,
            port=options.port,
            log_level=options.log_level,
        )

    def _detached_supervisor(self) -> Any:
        if self._detached is None:
            from .supervisor._detached import DetachedSupervisor

            self._detached = DetachedSupervisor(
                command=self.command,
                # Crash net, not server.log: the daemon writes its structured
                # log itself (see _logging), and its own stderr holding
                # server.log open would break rotation on Windows.
                log_path=self.stderr_log_path,
                platform=self._platform,
            )
        return self._detached

    def _optional_autostart_supervisor(self) -> Optional[AutostartSupervisor]:
        if self._autostart is not None:
            return self._autostart
        if self._platform == "darwin":
            from .supervisor._launchd import LaunchdSupervisor

            self._autostart = LaunchdSupervisor(platform=self._platform)
        elif self._platform.startswith("win"):
            from .supervisor._run_key import RunKeySupervisor

            self._autostart = RunKeySupervisor(platform=self._platform)
        return self._autostart

    def _require_autostart_supervisor(self) -> AutostartSupervisor:
        supervisor = self._optional_autostart_supervisor()
        if supervisor is None:
            raise ServerError(f"Autostart is unsupported on {self._platform}.")
        return supervisor

    def _enabled_autostart_supervisor(self) -> Optional[AutostartSupervisor]:
        supervisor = self._optional_autostart_supervisor()
        if supervisor is None:
            return None
        return (
            supervisor
            if getattr(supervisor, "owns_process", True)
            and supervisor.status().enabled
            else None
        )

    def _clear_registration(self, expected: ServerInstance) -> bool:
        """Compare-delete a registration while excluding foreground writers."""
        instance_lock = ServerInstanceLock(self.lock_path)
        try:
            instance_lock.acquire()
        except ServerInstanceLockHeld:
            return False
        try:
            return self.registration.clear(
                expected,
                instance_lock=instance_lock,
            )
        finally:
            instance_lock.release()

    def _ensure_stopped_registration_cleared(
        self,
        *,
        expected: Optional[ServerInstance] = None,
        stopped_pid: Optional[int] = None,
    ) -> None:
        """Clear only the stopped owner's registration or fail explicitly."""
        current = self.registration.read()
        if current is None:
            return
        if current != expected and (
            stopped_pid is None or current.pid != stopped_pid
        ):
            raise ServerError(
                "Service registration changed while stopping; "
                f"refusing to clear {self.registration.path}."
            )
        if self._clear_registration(current):
            return
        remaining = self.registration.read()
        if remaining is None:
            return
        raise ServerError(
            f"Could not clear stopped service registration "
            f"{self.registration.path}; instance lock is still owned."
        )

    def _instance_lock_state(self) -> ServerLockState:
        """Inspect whether the stable instance lock is free, legacy, or PID-aware."""
        return ServerInstanceLock.inspect(self.lock_path)

    def _instance_owner_pid(self) -> Optional[int]:
        """Read the stable PID currently proven by the instance lock."""
        return self._instance_lock_state().owner_pid

    def _instance_lock_available(self) -> bool:
        instance_lock = ServerInstanceLock(self.lock_path)
        try:
            instance_lock.acquire()
        except ServerInstanceLockHeld:
            return False
        instance_lock.release()
        return True

    def _wait_for_transition(
        self,
        options: ServerOptions,
        *,
        timeout: float,
    ) -> ServerStartResult:
        """Adopt an instance that already owns the lock instead of double-spawning."""
        instance = self.registration.wait_for_ready(
            host=options.host,
            port=options.port,
            timeout=timeout,
        )
        if instance is None:
            raise ServerStartTimeout(
                timeout=timeout,
                log_path=self.log_path,
                stderr_log_path=self.stderr_log_path,
            )
        return ServerStartResult(instance, False, "existing")

    def _autostart_diagnostic(self, status: AutostartStatus) -> str:
        # Both branches name the crash net, not server.log: a daemon that
        # never became ready usually died before it configured file logging,
        # so its traceback is in the raw stdout/stderr redirect.
        if status.manager == "launchd":
            return (
                "Check launchctl status and the daemon logs under "
                f"{self.stderr_log_path.parent} ({self.stderr_log_path.name})."
            )
        if status.manager == "windows_run":
            return (
                "Check the current user's HKCU Run entry and the detached "
                f"daemon log at {self.stderr_log_path}."
            )
        return f"Check the {status.manager} supervisor diagnostics."

    def _request_graceful_shutdown(self, instance: ServerInstance) -> bool:
        if not instance.token:
            return False
        request = urllib.request.Request(
            f"{instance.base_url()}/api/gateway/shutdown",
            method="POST",
            headers={"Authorization": f"Bearer {instance.token}"},
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.SHUTDOWN_REQUEST_TIMEOUT
            ) as response:
                return 200 <= response.status < 300
        except (OSError, urllib.error.URLError):
            return False

    def _wait_for_exit(self, pid: int, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.registration.pid_alive(pid):
                return True
            time.sleep(self.STOP_POLL_INTERVAL)
        return not self.registration.pid_alive(pid)

    def _terminate(self, pid: int, *, force: bool) -> bool:
        """Terminate only when ``pid`` is still the verified instance owner."""
        if self._instance_owner_pid() != pid:
            return False
        try:
            if self._platform.startswith("win"):
                result = subprocess.run(
                    ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                    check=False,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.PROCESS_COMMAND_TIMEOUT,
                    creationflags=WINDOWS_CREATE_NO_WINDOW,
                )
                if result.returncode != 0 and not self._wait_for_exit(
                    pid, self.TERMINATE_VERIFY_TIMEOUT
                ):
                    detail = result.stderr.strip() or result.stdout.strip()
                    raise ServerError(
                        f"Could not terminate service pid {pid}: {detail}"
                    )
                return True
            os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            return True
        except subprocess.TimeoutExpired as exc:
            raise ServerError(
                f"Timed out while stopping service pid {pid}."
            ) from exc
        except PermissionError as exc:
            raise ServerError(
                f"Permission denied while stopping service pid {pid}."
            ) from exc
        except OSError as exc:
            raise ServerError(f"Could not stop service pid {pid}.") from exc
        return True


__all__ = [
    "AutostartResult",
    "DEFAULT_WS_PATH",
    "GatewayMeta",
    "CONTROL_LOCK_FILE",
    "LOCK_FILE",
    "LOG_FILE",
    "RUNTIME_DIR_PARTS",
    "RUNTIME_FILE",
    "STDERR_LOG_FILE",
    "STDOUT_LOG_FILE",
    "ServerError",
    "ServerControlLock",
    "ServerInstance",
    "ServerInstanceLock",
    "ServerInstanceLockHeld",
    "ServerLockState",
    "ServerManager",
    "ServerOptions",
    "ServerRegistration",
    "ServerStartResult",
    "ServerStartTimeout",
    "ServerStatus",
    "ServerStopResult",
]
