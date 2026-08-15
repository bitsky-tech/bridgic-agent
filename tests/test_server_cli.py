from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from src.amphi_cli._server import ServerCLI
from src.amphi_service.server import (
    ServerError,
    ServerInstance,
    ServerOptions,
    ServerStatus,
)
from src.amphi_service.server.supervisor import SupervisorError


def _instance() -> ServerInstance:
    return ServerInstance(
        host="127.0.0.1",
        port=7421,
        pid=1234,
        started_at="2026-07-28T12:00:00",
        token="private-token",
    )


@dataclass(frozen=True)
class _AutostartStatus:
    manager: str = "test-supervisor"
    supported: bool = True
    enabled: bool = True
    active: bool = True
    detail: str | None = None
    definition: Path | None = None


class _Manager:
    def __init__(
        self,
        *,
        runtime_path: Path = Path("/runtime.json"),
        autostart_definition: Path = Path("/runtime/autostart.conf"),
    ) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.instance = _instance()
        self.serve_result = True
        self.runtime_path = runtime_path
        self.autostart_definition = autostart_definition

    def start(self, options: ServerOptions, *, timeout: float) -> Any:
        self.calls.append(("start", (options, timeout)))
        return SimpleNamespace(instance=self.instance, started=True, owner="detached")

    def stop(self, *, timeout: float, force: bool) -> Any:
        self.calls.append(("stop", (timeout, force)))
        return SimpleNamespace(outcome="stopped", pid=self.instance.pid)

    def restart(
        self,
        options: ServerOptions,
        *,
        start_timeout: float,
        stop_timeout: float,
        force: bool,
    ) -> Any:
        self.calls.append(
            ("restart", (options, start_timeout, stop_timeout, force))
        )
        return SimpleNamespace(instance=self.instance, started=True, owner="detached")

    def status(self) -> ServerStatus:
        self.calls.append(("status", None))
        return ServerStatus("running", self.runtime_path, self.instance)

    def serve(self, options: ServerOptions) -> bool:
        self.calls.append(("serve", options))
        return self.serve_result

    def enable_autostart(self, options: ServerOptions, *, timeout: float) -> Any:
        self.calls.append(("autostart-enable", (options, timeout)))
        return SimpleNamespace(status=_AutostartStatus(), instance=self.instance)

    def disable_autostart(self, *, timeout: float) -> Any:
        self.calls.append(("autostart-disable", timeout))
        return SimpleNamespace(
            status=_AutostartStatus(enabled=False, active=False),
            instance=None,
        )

    def configure_autostart(
        self,
        enabled: bool,
        options: ServerOptions = ServerOptions(),
        *,
        timeout: float,
    ) -> Any:
        self.calls.append(("autostart-configure", (enabled, options, timeout)))
        return SimpleNamespace(
            status=_AutostartStatus(enabled=enabled, active=False),
            instance=None,
        )

    def autostart_status(self) -> _AutostartStatus:
        self.calls.append(("autostart-status", None))
        return _AutostartStatus(definition=self.autostart_definition)


def test_start_passes_all_options_to_the_manager(capsys) -> None:
    manager = _Manager()

    exit_code = ServerCLI(manager=manager).main(
        [
            "start",
            "--host",
            "0.0.0.0",
            "--port",
            "8123",
            "--log-level",
            "debug",
            "--timeout",
            "2.5",
        ]
    )

    assert exit_code == 0
    assert manager.calls == [
        (
            "start",
            (
                ServerOptions(
                    host="0.0.0.0",
                    port=8123,
                    log_level="debug",
                ),
                2.5,
            ),
        )
    ]
    assert "Service started" in capsys.readouterr().out


def test_stop_passes_timeout_and_force_to_the_manager(capsys) -> None:
    manager = _Manager()

    assert (
        ServerCLI(manager=manager).main(
            ["stop", "--timeout", "1.25", "--force"]
        )
        == 0
    )

    assert manager.calls == [("stop", (1.25, True))]
    assert "Service stopped (pid 1234)." in capsys.readouterr().out


def test_restart_keeps_start_and_stop_timeouts_distinct(capsys) -> None:
    manager = _Manager()

    assert (
        ServerCLI(manager=manager).main(
            [
                "restart",
                "--port",
                "8000",
                "--timeout",
                "5",
                "--stop-timeout",
                "2",
                "--force",
            ]
        )
        == 0
    )

    assert manager.calls == [
        (
            "restart",
            (
                ServerOptions(port=8000),
                5,
                2,
                True,
            ),
        )
    ]
    assert "Service restarted" in capsys.readouterr().out


def test_serve_passes_reload(capsys) -> None:
    manager = _Manager()
    manager.serve_result = False

    assert ServerCLI(manager=manager).main(["serve", "--reload"]) == 1

    assert manager.calls == [
        (
            "serve",
            ServerOptions(reload=True),
        )
    ]
    assert "already owns the server lock" in capsys.readouterr().out


def test_status_prints_manager_json_without_the_token(capsys) -> None:
    manager = _Manager()

    assert ServerCLI(manager=manager).main(["status"]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "running"
    assert payload["pid"] == 1234
    assert "token" not in payload
    assert manager.calls == [("status", None)]


def test_status_json_survives_a_non_ascii_runtime_path(capsys) -> None:
    # The desktop client reads this JSON off a pipe and decodes it as UTF-8,
    # while a non-UTF-8 console locale (cp936 on Chinese Windows) would encode
    # the path in that locale instead. Staying ASCII keeps the bytes identical
    # under every locale, so the client never receives a corrupted path.
    runtime_path = Path(r"C:\Users\张三\.bridgic\AmphiAgent\runtime.json")
    manager = _Manager(runtime_path=runtime_path)

    assert ServerCLI(manager=manager).main(["status"]) == 0

    printed = capsys.readouterr().out
    assert printed.isascii()
    assert json.loads(printed)["runtime_file"] == str(runtime_path)


def test_autostart_enable_sets_the_process_owner(capsys) -> None:
    manager = _Manager()

    assert (
        ServerCLI(manager=manager).main(
            [
                "autostart",
                "enable",
                "--host",
                "127.0.0.1",
                "--port",
                "9000",
                "--timeout",
                "6",
            ]
        )
        == 0
    )

    assert manager.calls == [
        (
            "autostart-enable",
            (
                ServerOptions(
                    host="127.0.0.1",
                    port=9000,
                ),
                6,
            ),
        )
    ]
    assert "Autostart enabled via test-supervisor" in capsys.readouterr().out


def test_autostart_disable_delegates_to_the_manager(capsys) -> None:
    manager = _Manager()

    assert (
        ServerCLI(manager=manager).main(
            ["autostart", "disable", "--timeout", "3"]
        )
        == 0
    )

    assert manager.calls == [("autostart-disable", 3)]
    assert "Autostart disabled via test-supervisor" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("verb", "enabled"),
    [("enable", True), ("disable", False)],
)
def test_autostart_configure_only_preserves_the_current_service(
    capsys,
    verb: str,
    enabled: bool,
) -> None:
    manager = _Manager()

    assert (
        ServerCLI(manager=manager).main(
            ["autostart", verb, "--configure-only", "--timeout", "3"]
        )
        == 0
    )

    assert manager.calls == [
        ("autostart-configure", (enabled, ServerOptions(), 3))
    ]
    assert "current service unchanged" in capsys.readouterr().out


def test_autostart_status_serializes_its_definition_path(capsys) -> None:
    manager = _Manager()

    assert ServerCLI(manager=manager).main(["autostart", "status"]) == 0

    assert json.loads(capsys.readouterr().out) == {
        "manager": "test-supervisor",
        "supported": True,
        "enabled": True,
        "active": True,
        "detail": None,
        "definition": "/runtime/autostart.conf",
    }
    assert manager.calls == [("autostart-status", None)]


def test_autostart_status_json_survives_a_non_ascii_definition_path(capsys) -> None:
    # Same pipe-encoding contract as the status command above.
    definition = Path(r"C:\Users\张三\AppData\Roaming\autostart.conf")
    manager = _Manager(autostart_definition=definition)

    assert ServerCLI(manager=manager).main(["autostart", "status"]) == 0

    printed = capsys.readouterr().out
    assert printed.isascii()
    assert json.loads(printed)["definition"] == str(definition)


def test_manager_errors_are_reported_as_cli_failures(capsys) -> None:
    manager = _Manager()

    def fail(_options: ServerOptions, *, timeout: float) -> Any:
        raise ServerError(f"could not launch in {timeout}s")

    manager.start = fail

    assert ServerCLI(manager=manager).main(["start", "--timeout", "0.5"]) == 1
    assert (
        "amphi server start: could not launch in 0.5s"
        in capsys.readouterr().err
    )


def test_supervisor_errors_are_reported_as_cli_failures(capsys) -> None:
    manager = _Manager()

    def fail() -> _AutostartStatus:
        raise SupervisorError("autostart unavailable")

    manager.autostart_status = fail

    assert ServerCLI(manager=manager).main(["autostart", "status"]) == 1
    assert "autostart unavailable" in capsys.readouterr().err


def test_unexpected_runtime_errors_are_not_hidden() -> None:
    manager = _Manager()

    def fail() -> ServerStatus:
        raise RuntimeError("programming error")

    manager.status = fail

    with pytest.raises(RuntimeError, match="programming error"):
        ServerCLI(manager=manager).main(["status"])


@pytest.mark.parametrize(
    "arguments",
    [
        ["start", "--port", "0"],
        ["start", "--port", "65536"],
        ["start", "--timeout", "-1"],
        ["stop", "--timeout", "nan"],
        ["restart", "--stop-timeout", "inf"],
        ["autostart", "enable", "--unknown-option"],
    ],
)
def test_invalid_server_option_is_rejected(
    arguments: list[str],
) -> None:
    with pytest.raises(SystemExit) as caught:
        ServerCLI(manager=_Manager()).main(arguments)

    assert caught.value.code == 2
