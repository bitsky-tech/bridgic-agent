"""Cross-platform notification subprocess coverage."""

from __future__ import annotations

import subprocess

import pytest

from src.amphi_service.runtime import _notify


def test_windows_notification_uses_windowless_powershell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = list(cmd)
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(_notify.platform, "system", lambda: "Windows")
    monkeypatch.setattr(_notify.subprocess, "run", fake_run)

    _notify.notify("标题", "内容")

    assert captured["cmd"][:5] == [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
    ]
    assert captured["kwargs"]["creationflags"] == 0x08000000
    assert captured["kwargs"]["capture_output"] is True
