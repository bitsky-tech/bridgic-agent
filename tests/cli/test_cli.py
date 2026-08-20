import json
from typing import Any

import httpx
import pytest

from src.amphi_cli._agent import AgentCLI
from src.amphi_cli._cli import dispatch
from src.amphi_cli._server import ServerCLI


def test_dispatch_routes_the_public_command_surface(monkeypatch: pytest.MonkeyPatch) -> None:
    server_calls: list[list[str]] = []
    agent_calls: list[list[str]] = []
    monkeypatch.setattr(ServerCLI, "main", lambda self, argv: server_calls.append(list(argv)) or 0)
    monkeypatch.setattr(AgentCLI, "main", lambda self, argv: agent_calls.append(list(argv)) or 7)

    dispatch(["server", "status"])
    dispatch(["gateway", "start"])
    dispatch(["serve", "--port", "9000"])
    with pytest.raises(SystemExit, match="7"):
        dispatch(["agent", "run", "hello"])

    assert server_calls == [["status"], ["start"], ["serve", "--port", "9000"]]
    assert agent_calls == [["run", "hello"]]

    for arguments, exit_code in ((["--help"], 0), ([], 1), (["unknown"], 2)):
        with pytest.raises(SystemExit) as exc_info:
            dispatch(arguments)
        assert exc_info.value.code == exit_code


def test_agent_run_creates_a_root_session(agent_cli_harness: Any, capsys: pytest.CaptureFixture[str]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sessions":
            return httpx.Response(200, json={"id": "root-session"})
        return httpx.Response(
            200,
            json={"disposition": "completed", "answer": "root answer"},
        )

    agent_cli_harness.install_handler(handler)

    assert AgentCLI(agent_cli_harness.manager()).main(["run", "hello", "world"]) == 0
    assert capsys.readouterr().out == "root answer\n"
    assert [request.url.path for request in agent_cli_harness.requests] == [
        "/sessions",
        "/api/agent/sessions/root-session/run",
    ]
    assert json.loads(agent_cli_harness.requests[1].content) == {"input": "hello world"}
    assert agent_cli_harness.requests[1].headers["authorization"] == "Bearer test-token"

    assert AgentCLI(agent_cli_harness.manager("stopped")).main(["run", "hello"]) == 1
    assert "daemon is not running" in capsys.readouterr().err


def test_agent_run_resumes_an_awaiting_child(agent_cli_harness: Any, capsys: pytest.CaptureFixture[str]) -> None:
    poll_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal poll_count
        if request.method == "POST":
            return httpx.Response(
                200,
                json={"disposition": "awaiting", "session_id": "child-session"},
            )
        poll_count += 1
        if poll_count == 1:
            return httpx.Response(200, json={"status": "running"})
        return httpx.Response(200, json={"status": "completed", "answer": "child answer"})

    agent_cli_harness.monkeypatch.setenv(AgentCLI.SESSION_ID_ENV, "parent-session")
    agent_cli_harness.monkeypatch.setenv(AgentCLI.PARENT_TOOL_CALL_ID_ENV, "tool-call")
    agent_cli_harness.monkeypatch.setenv(AgentCLI.EXECUTION_MODE_ENV, "request")
    agent_cli_harness.monkeypatch.setattr(AgentCLI, "POLL_INTERVAL_SECONDS", 0)
    agent_cli_harness.install_handler(handler)

    assert AgentCLI(agent_cli_harness.manager()).main(["run", "delegate"]) == 0
    assert capsys.readouterr().out == "child answer\n"
    assert json.loads(agent_cli_harness.requests[0].content) == {
        "input": "delegate",
        "parent_tool_call_id": "tool-call",
        "execution_mode": "request",
    }
    assert [request.url.path for request in agent_cli_harness.requests] == [
        "/api/agent/sessions/parent-session/subagents",
        "/api/agent/sessions/child-session/run",
        "/api/agent/sessions/child-session/run",
    ]
