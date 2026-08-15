"""Cross-platform desktop notification sent by the daemon (A2 / D7).

Works whether or not the Electron app is running — a scheduled run that needs a
human or fails alerts the user directly through the OS notifier (macOS
``osascript``, Linux ``notify-send``, Windows PowerShell balloon). Best-effort:
every failure is swallowed so a notification never breaks a run.

macOS caveat: ``osascript`` notifications are attributed to a generic "Script
Editor"; a bundled ``terminal-notifier`` / signed helper would give proper
"Bridgic Agent" branding + click-to-open (deferred).
"""
from __future__ import annotations

import logging
import platform
import subprocess
from typing import List

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 5.0
_WINDOWS_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def notify(title: str, message: str) -> None:
    """Show a desktop notification for ``title`` / ``message``. Never raises."""
    system = platform.system()
    try:
        if system == "Darwin":
            script = f"display notification {_applescript_str(message)} with title {_applescript_str(title)}"
            _run(["osascript", "-e", script])
        elif system == "Linux":
            _run(["notify-send", "--", title, message])
        elif system == "Windows":
            _run([
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                _windows_balloon(title, message),
            ])
        else:
            logger.info("notify: unsupported platform %s; skipped", system)
    except Exception:  # noqa: BLE001 — notification must never break a run
        logger.exception("notify failed for %r", title)


def _run(cmd: List[str]) -> None:
    spawn_options = (
        {"creationflags": _WINDOWS_CREATE_NO_WINDOW}
        if platform.system() == "Windows"
        else {}
    )
    subprocess.run(
        cmd,
        check=False,
        timeout=_TIMEOUT_SECONDS,
        capture_output=True,
        **spawn_options,
    )


def _applescript_str(value: str) -> str:
    """Quote a Python str as an AppleScript string literal (escape ``\\`` and ``"``)."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _windows_balloon(title: str, message: str) -> str:
    """Minimal tray-balloon PowerShell (no external module); best-effort MVP."""
    t = title.replace("'", "''")
    m = message.replace("'", "''")
    return (
        "[reflection.assembly]::LoadWithPartialName('System.Windows.Forms')>$null;"
        "$n=New-Object System.Windows.Forms.NotifyIcon;"
        "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;"
        f"$n.ShowBalloonTip(5000,'{t}','{m}',"
        "[System.Windows.Forms.ToolTipIcon]::Info)"
    )


__all__ = ["notify"]
