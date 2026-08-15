import json
from pathlib import Path

import httpx
import pytest

import src.amphi_cli._agent as agent_cli_module
from src.amphi_cli._agent import AgentCLI
from src.amphi_service.server import ServerInstance, ServerStatus


def _server() -> ServerInstance:
    return ServerInstance(
        host="127.0.0.1",
        port=7421,
        pid=123,
        started_at="2026-07-20T12:00:00",
        token="local-token",
    )


class _Manager:
    def __init__(self, status: ServerStatus) -> None:
        self._status = status

    def status(self) -> ServerStatus:
        return self._status


def _running_manager() -> _Manager:
    return _Manager(ServerStatus("running", Path("/runtime.json"), _server()))


def _install_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    real_client = httpx.Client
    monkeypatch.setattr(
        agent_cli_module.httpx,
        "Client",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )


def test_agent_run_creates_a_root_session_without_session_env(monkeypatch, capsys) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/sessions":
            return httpx.Response(201, json={"id": "session-root"})
        return httpx.Response(200, json={
            "session_id": "session-root",
            "turn_id": "turn-root",
            "disposition": "completed",
            "answer": "root answer",
        })

    monkeypatch.delenv("SESSION_ID", raising=False)
    monkeypatch.delenv("PARENT_TOOL_CALL_ID", raising=False)
    monkeypatch.delenv("EXECUTION_MODE", raising=False)
    _install_client(monkeypatch, handler)

    assert AgentCLI(manager=_running_manager()).main(["run", "inspect", "the files"]) == 0
    assert capsys.readouterr().out == "root answer\n"
    assert [request.url.path for request in requests] == [
        "/sessions",
        "/api/agent/sessions/session-root/run",
    ]
    assert all(request.headers["authorization"] == "Bearer local-token" for request in requests)


def test_agent_run_uses_session_env_as_the_child_parent(monkeypatch, capsys) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "session_id": "session-child",
            "turn_id": "turn-child",
            "disposition": "completed",
            "answer": "child answer",
        })

    monkeypatch.setenv("SESSION_ID", "session-parent")
    monkeypatch.setenv("PARENT_TOOL_CALL_ID", "call-bash")
    monkeypatch.setenv("EXECUTION_MODE", "full")
    _install_client(monkeypatch, handler)

    assert AgentCLI(manager=_running_manager()).main(["run", "analyze this"]) == 0
    assert capsys.readouterr().out == "child answer\n"
    assert [request.url.path for request in requests] == [
        "/api/agent/sessions/session-parent/subagents",
    ]
    assert json.loads(requests[0].content) == {
        "input": "analyze this",
        "parent_tool_call_id": "call-bash",
        "execution_mode": "full",
    }


def test_agent_run_waits_for_a_parked_session(monkeypatch, capsys) -> None:
    polls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        if request.method == "POST":
            return httpx.Response(200, json={
                "session_id": "session-child",
                "turn_id": "turn-child",
                "disposition": "awaiting_feedback",
                "answer": "",
            })
        polls += 1
        return httpx.Response(200, json={
            "session_id": "session-child",
            "status": "awaiting_human" if polls == 1 else "completed",
            "answer": None if polls == 1 else "resumed answer",
            "error": None,
        })

    monkeypatch.setenv("SESSION_ID", "session-parent")
    monkeypatch.delenv("EXECUTION_MODE", raising=False)
    monkeypatch.setattr(AgentCLI, "POLL_INTERVAL_SECONDS", 0)
    _install_client(monkeypatch, handler)

    assert AgentCLI(manager=_running_manager()).main(["run", "ask when needed"]) == 0
    assert capsys.readouterr().out == "resumed answer\n"
    assert polls == 2


def test_agent_run_requires_input() -> None:
    with pytest.raises(SystemExit) as exc:
        AgentCLI(manager=_running_manager()).main(["run"])
    assert exc.value.code == 2


@pytest.mark.parametrize("state", ["stopped", "stale"])
def test_agent_run_requires_a_running_service(state: str, capsys) -> None:
    server = _server() if state == "stale" else None
    manager = _Manager(ServerStatus(state, Path("/runtime.json"), server))

    assert AgentCLI(manager=manager).main(["run", "inspect"]) == 1
    assert "daemon is not running" in capsys.readouterr().err
