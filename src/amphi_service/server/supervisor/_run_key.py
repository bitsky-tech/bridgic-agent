"""Windows per-user login autostart through the HKCU Run key."""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Callable
from typing import Optional

from ._base import (
    AutostartStatus,
    AutostartSupervisor,
    ServerLaunchSpec,
    SupervisorError,
    UnsupportedSupervisor,
)

RUN_KEY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE_NAME = "Amphi Daemon"
STARTUP_APPROVED_KEY_PATH = (
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
)
STARTUP_APPROVED_ENABLED_STATES = frozenset({0, 2})


def _split_arguments(command: str) -> Optional[str]:
    """Return everything after the executable token, or ``None`` if unparseable.

    The launcher path is quoted whenever it contains a space, and
    ``subprocess.list2cmdline`` (what :meth:`enable` writes) always quotes the
    default ``%LOCALAPPDATA%\\Programs\\Bridgic Agent`` location for exactly
    that reason.
    So a quoted first token is parsed as a quoted run and everything after it is
    preserved verbatim.

    Unquoted values are only trusted when the first whitespace-delimited token
    looks like an executable. Splitting an unquoted value on the first space is
    what naively "works" and is precisely wrong for the common case::

        C:\\Users\\John Smith\\...\\amphi-autostart.exe server start

    There the first token is ``C:\\Users\\John``, so a naive split promotes
    ``Smith\\...\\amphi-autostart.exe`` to argv[1]. At the next logon argparse
    rejects that argument and autostart dies silently — while ``status()`` still
    reports ``enabled=True``, so nothing in the GUI ever says so. Returning
    ``None`` instead lets the caller fall back to a known-good command.
    """
    if command.startswith('"'):
        closing = command.find('"', 1)
        if closing == -1:
            return None  # unterminated quote — cannot tell path from arguments
        arguments = command[closing + 1 :]
    else:
        head, _, _ = command.partition(" ")
        if not head.lower().endswith(".exe"):
            return None
        arguments = command[len(head) :]

    # An executable with no arguments at all is not something any writer of this
    # value produces — `server start` is always there. Preserving "nothing" would
    # mean writing a launcher invocation that starts nothing at the next logon
    # while `status()` still reports enabled, which is the exact failure this
    # function exists to avoid.
    return arguments if arguments.strip() else None


class RunKeySupervisor(AutostartSupervisor):
    """Register a zero-elevation Windows login launcher.

    Frozen builds register the windowless launcher, which forwards
    ``amphi server start`` once at login. The Run key does not own the resulting
    detached daemon and therefore cannot provide crash restart.
    """

    MANAGER = "windows_run"
    owns_process = False

    def __init__(
        self,
        *,
        platform: Optional[str] = None,
        read_value: Optional[Callable[[], Optional[str]]] = None,
        write_value: Optional[Callable[[str], None]] = None,
        delete_value: Optional[Callable[[], None]] = None,
        read_approval: Optional[Callable[[], Optional[bytes]]] = None,
        enable_approval: Optional[Callable[[], None]] = None,
    ) -> None:
        self.platform = sys.platform if platform is None else platform
        self._read_value_override = read_value
        self._write_value_override = write_value
        self._delete_value_override = delete_value
        self._read_approval_override = read_approval
        self._enable_approval_override = enable_approval

    def install(self, spec: ServerLaunchSpec) -> AutostartStatus:
        """Enable login startup while retaining an existing command's arguments."""
        # Desktop's toggle carries default host/port values because it is not a
        # launch-options editor. Reuse repair's path-only rewrite so re-enabling
        # an entry disabled in Windows Startup Apps does not silently reset a
        # user's custom port or log level. A missing value still gets the full
        # canonical command.
        self.repair(spec)
        return self._restore_approval()

    def enable(self, spec: ServerLaunchSpec) -> AutostartStatus:
        """Write the requested login command without starting the daemon."""
        self._require_supported()
        if not spec.executable.is_file():
            raise SupervisorError(
                f"Windows autostart launcher is missing: {spec.executable}"
            )
        command = subprocess.list2cmdline(spec.argv)
        try:
            self._write_value(command)
        except OSError as exc:
            raise SupervisorError("could not write the Windows Run key") from exc
        return self._restore_approval()

    def _restore_approval(self) -> AutostartStatus:
        """Clear an explicit Startup Apps opt-out and verify effective state."""
        # Writing a Run value does not reliably undo a choice made through
        # Windows Startup Apps / Task Manager: the separate StartupApproved
        # value can remain disabled. Only this explicit user-facing `enable`
        # verb is allowed to clear that opt-out. Installer `repair` below must
        # never do so.
        try:
            self._enable_approval()
        except OSError as exc:
            raise SupervisorError(
                "could not enable the Windows StartupApproved entry"
            ) from exc
        status = self.status()
        if not status.enabled:
            raise SupervisorError(
                status.detail
                or "Windows autostart remains disabled after enabling approval"
            )
        return status

    def repair(self, spec: ServerLaunchSpec) -> AutostartStatus:
        """Point the login command at this installation without starting anything.

        This exists so the Windows installer has a way to fix up the Run key
        without becoming a second writer of it. Two writers is exactly what the
        installer used to be: NSIS wrote a hard-coded
        ``"…\\amphi-autostart.exe" server start`` while :meth:`enable` writes the
        full argv including ``--host`` / ``--port`` / ``--log-level``. Because an
        over-install runs the *old* uninstaller (which deletes the value) and
        then the new ``customInstall`` (which rewrote it), every update silently
        reset a user's configured port — and silently re-enabled autostart for
        users who had turned it off.

        Semantics:

        * value absent → write the canonical command.
        * value present → replace **only** the executable path, preserving every
          argument the user configured.

        Note what this deliberately does NOT do: decide whether autostart should
        exist at all. That is the installer's call, and it has to make it from a
        snapshot taken in ``customInit`` — by the time ``customInstall`` runs,
        electron-builder has already executed the *previous* release's
        uninstaller, and every uninstaller shipped so far deletes this value
        unconditionally. A "only write if a value already exists" mode would
        therefore look correct and lose autostart for every existing user on the
        very upgrade it was written for.

        Unlike :meth:`enable` this never starts the service: the installer runs
        before the new bundle has ever been launched, and spawning a daemon from
        inside an installer is what used to pop a console window mid-install.
        """
        self._require_supported()
        if not spec.executable.is_file():
            raise SupervisorError(
                f"Windows autostart launcher is missing: {spec.executable}"
            )
        try:
            current = self._read_value()
        except OSError as exc:
            raise SupervisorError("could not read the Windows Run key") from exc

        canonical = subprocess.list2cmdline(spec.argv)
        if current is None:
            command = canonical
        else:
            arguments = _split_arguments(current)
            if arguments is None:
                # Unparseable value (empty, unterminated quote, or an unquoted
                # path we cannot tell from its arguments). Rewriting it with the
                # canonical command loses whatever the user had configured, but
                # the alternative — splicing a new path into a string we cannot
                # parse — produces a command that fails silently at the next
                # logon while `status()` still reports enabled.
                command = canonical
            else:
                command = subprocess.list2cmdline([str(spec.executable)]) + arguments
            if command == current:
                return self.status()

        try:
            self._write_value(command)
        except OSError as exc:
            raise SupervisorError("could not write the Windows Run key") from exc
        return self.status()

    def uninstall(self) -> AutostartStatus:
        """Remove the login command without assuming process ownership."""
        self._require_supported()
        try:
            self._delete_value()
        except OSError as exc:
            raise SupervisorError("could not remove the Windows Run key") from exc
        return self.status()

    def disable(self) -> AutostartStatus:
        """Remove the Run value; Windows Run does not own the live daemon."""
        return self.uninstall()

    def activate(self) -> AutostartStatus:
        """Return status; the detached supervisor owns immediate startup."""
        self._require_supported()
        return self.status()

    def deactivate(self) -> AutostartStatus:
        """Return status; the detached supervisor owns process shutdown."""
        self._require_supported()
        return self.status()

    def status(self) -> AutostartStatus:
        """Report whether Windows will actually run the Bridgic Agent login command.

        The Run value is only the registration. Windows stores the user's
        effective Startup Apps decision separately under ``StartupApproved``;
        treating registration alone as enabled silently bypasses that opt-out.
        """
        if not self._is_supported():
            return AutostartStatus(
                manager=self.MANAGER,
                supported=False,
                enabled=False,
                detail=f"Windows Run autostart is unavailable on {self.platform}",
            )
        try:
            command = self._read_value()
        except OSError as exc:
            raise SupervisorError("could not read the Windows Run key") from exc
        if command is None:
            return AutostartStatus(
                manager=self.MANAGER,
                supported=True,
                enabled=False,
                active=None,
            )

        run_detail = rf"HKCU\{RUN_KEY_PATH}\{RUN_VALUE_NAME}"
        try:
            approval = self._read_approval()
        except OSError as exc:
            return AutostartStatus(
                manager=self.MANAGER,
                supported=True,
                enabled=False,
                active=None,
                detail=(
                    f"{run_detail}; could not read Windows StartupApproved "
                    f"state: {exc}"
                ),
            )

        # No StartupApproved value means Windows has never explicitly disabled
        # this Run entry. A present REG_BINARY stores its state in byte zero;
        # Windows uses 0/2 for effective entries and other known values (most
        # commonly 3) for disabled/non-approved entries.
        if approval is None:
            enabled = True
            detail = run_detail
        elif not approval:
            enabled = False
            detail = f"{run_detail}; Windows StartupApproved state is empty"
        elif approval[0] in STARTUP_APPROVED_ENABLED_STATES:
            enabled = True
            detail = run_detail
        else:
            enabled = False
            detail = (
                f"{run_detail}; disabled in Windows Startup Apps "
                f"(StartupApproved state {approval[0]})"
            )
        return AutostartStatus(
            manager=self.MANAGER,
            supported=True,
            enabled=enabled,
            active=None,
            detail=detail,
        )

    def _read_value(self) -> Optional[str]:
        if self._read_value_override is not None:
            return self._read_value_override()
        winreg = self._winreg()
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                RUN_KEY_PATH,
                0,
                winreg.KEY_READ,
            ) as key:
                value, _kind = winreg.QueryValueEx(key, RUN_VALUE_NAME)
        except FileNotFoundError:
            return None
        return str(value)

    def _write_value(self, command: str) -> None:
        if self._write_value_override is not None:
            self._write_value_override(command)
            return
        winreg = self._winreg()
        with winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER,
            RUN_KEY_PATH,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.SetValueEx(key, RUN_VALUE_NAME, 0, winreg.REG_SZ, command)

    def _delete_value(self) -> None:
        if self._delete_value_override is not None:
            self._delete_value_override()
            return
        winreg = self._winreg()
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                RUN_KEY_PATH,
                0,
                winreg.KEY_SET_VALUE,
            ) as key:
                winreg.DeleteValue(key, RUN_VALUE_NAME)
        except FileNotFoundError:
            return

    def _read_approval(self) -> Optional[bytes]:
        if self._read_approval_override is not None:
            return self._read_approval_override()
        winreg = self._winreg()
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                STARTUP_APPROVED_KEY_PATH,
                0,
                winreg.KEY_READ,
            ) as key:
                value, kind = winreg.QueryValueEx(key, RUN_VALUE_NAME)
        except FileNotFoundError:
            return None
        if kind != winreg.REG_BINARY or not isinstance(value, (bytes, bytearray)):
            raise OSError("StartupApproved value is not REG_BINARY")
        return bytes(value)

    def _enable_approval(self) -> None:
        if self._enable_approval_override is not None:
            self._enable_approval_override()
            return
        winreg = self._winreg()
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                STARTUP_APPROVED_KEY_PATH,
                0,
                winreg.KEY_SET_VALUE,
            ) as key:
                # Absence is Windows' default-enabled state. Deleting rather
                # than synthesizing its undocumented timestamp payload also
                # keeps this writer limited to the one byte of policy we own.
                winreg.DeleteValue(key, RUN_VALUE_NAME)
        except FileNotFoundError:
            return

    @staticmethod
    def _winreg():
        import winreg

        return winreg

    def _is_supported(self) -> bool:
        return self.platform.lower().startswith("win")

    def _require_supported(self) -> None:
        if not self._is_supported():
            raise UnsupportedSupervisor(
                f"Windows Run autostart is unavailable on {self.platform}"
            )


__all__ = [
    "RUN_KEY_PATH",
    "RUN_VALUE_NAME",
    "STARTUP_APPROVED_ENABLED_STATES",
    "STARTUP_APPROVED_KEY_PATH",
    "RunKeySupervisor",
]
