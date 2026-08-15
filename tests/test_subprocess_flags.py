"""Runtime consumers own their platform-specific subprocess behavior."""

from __future__ import annotations

import inspect
import subprocess

import pytest

from src.amphi_agent.tools import _bash
from src.amphi_service.handler import _skills_import_handler
from src.amphi_service.runtime import _notify


WIN_CREATE_NO_WINDOW = 0x08000000


def test_skill_git_commands_are_windowless_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(_skills_import_handler, "_IS_WINDOWS", True)
    monkeypatch.setattr(_skills_import_handler.subprocess, "run", fake_run)

    _skills_import_handler._run_git_command(["git", "--version"])

    assert captured["kwargs"]["creationflags"] == WIN_CREATE_NO_WINDOW


@pytest.mark.parametrize("module", [_bash, _notify, _skills_import_handler])
def test_runtime_consumers_do_not_import_runtime_subprocess_helpers(module) -> None:
    source = inspect.getsource(module)

    assert "amphi_agent.runtime" not in source
    assert "from ..runtime import" not in source
    assert "_subprocess_flags" not in source
    assert "no_window_kwargs" not in source
