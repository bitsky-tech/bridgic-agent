from __future__ import annotations

import importlib
import json
import runpy
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from src import amphi_cli
from src.amphi_cli import _cli
from src.amphi_cli._server import ServerCLI

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_help_and_missing_command_have_distinct_exit_codes(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as help_exit:
        amphi_cli.dispatch(["--help"])
    assert help_exit.value.code == 0
    help_text = capsys.readouterr().out
    assert "usage: amphi" in help_text
    assert "tui" not in help_text

    with pytest.raises(SystemExit) as missing_exit:
        amphi_cli.dispatch([])
    assert missing_exit.value.code == 1
    assert "usage: amphi" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("argv", "expected_exit_code"),
    [
        (["--help"], 0),
        (["unknown"], 2),
        (["server", "--help"], 0),
        (["agent", "--help"], 0),
    ],
)
def test_non_execution_paths_are_lazy_and_do_not_mutate_environment(
    argv: list[str],
    expected_exit_code: int,
) -> None:
    script = """
import json
import os
import sys
from src.amphi_cli import dispatch

before = dict(os.environ)
try:
    dispatch(json.loads(sys.argv[1]))
except SystemExit as exc:
    assert exc.code == int(sys.argv[2])

assert "src.amphi_agent" not in sys.modules
assert "src.amphi_agent.runtime" not in sys.modules
assert "src.amphi_service._app" not in sys.modules
assert "uvicorn" not in sys.modules
assert dict(os.environ) == before
"""

    result = subprocess.run(
        [sys.executable, "-c", script, json.dumps(argv), str(expected_exit_code)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("argv", "forwarded"),
    [
        (["server", "status"], ["status"]),
        (["gateway", "stop"], ["stop"]),
        (["serve", "--port", "8000"], ["serve", "--port", "8000"]),
    ],
)
def test_service_commands_delegate_to_server_cli(
    monkeypatch: pytest.MonkeyPatch,
    argv: list[str],
    forwarded: list[str],
) -> None:
    received: list[list[str]] = []

    def fake_main(_self: ServerCLI, args: list[str]) -> int:
        received.append(args)
        return 0

    monkeypatch.setattr(ServerCLI, "main", fake_main)

    amphi_cli.dispatch(argv)

    assert received == [forwarded]


def test_service_command_preserves_nonzero_exit_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ServerCLI, "main", lambda _self, _args: 9)

    with pytest.raises(SystemExit) as exc:
        amphi_cli.dispatch(["server", "status"])

    assert exc.value.code == 9


def test_agent_command_delegates_and_preserves_exit_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[list[str]] = []

    from src.amphi_cli._agent import AgentCLI

    def fake_main(_self: AgentCLI, argv: list[str]) -> int:
        received.append(argv)
        return 7

    monkeypatch.setattr(AgentCLI, "main", fake_main)

    with pytest.raises(SystemExit) as exc:
        amphi_cli.dispatch(["agent", "run", "inspect"])

    assert exc.value.code == 7
    assert received == [["run", "inspect"]]


def test_removed_tui_command_reports_usage(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc:
        amphi_cli.dispatch(["tui"])

    assert exc.value.code == 2
    error = capsys.readouterr().err
    assert "unknown subcommand: 'tui'" in error
    assert "usage: amphi" in error


def test_package_exports_the_canonical_dispatcher() -> None:
    assert amphi_cli.dispatch is _cli.dispatch


def test_source_launcher_delegates_to_the_public_dispatcher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(amphi_cli, "dispatch", lambda: calls.append("dispatch"))
    monkeypatch.delitem(sys.modules, "src.__main__", raising=False)

    runpy.run_module("src", run_name="__main__")

    assert calls == ["dispatch"]


def test_frozen_launcher_delegates_to_the_public_dispatcher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(amphi_cli, "dispatch", lambda: calls.append("dispatch"))

    runpy.run_path(str(PROJECT_ROOT / "build" / "amphi_entry.py"), run_name="__main__")

    assert calls == ["dispatch"]


def test_project_script_targets_the_public_dispatcher() -> None:
    with (PROJECT_ROOT / "pyproject.toml").open("rb") as file:
        project = tomllib.load(file)

    target = project["project"]["scripts"]["amphi"]
    assert target == "src.amphi_cli:dispatch"
    module_name, attribute = target.split(":", maxsplit=1)
    assert getattr(importlib.import_module(module_name), attribute) is amphi_cli.dispatch
