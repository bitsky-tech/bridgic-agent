from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Callable

import httpx
import pytest

from src.amphi_cli import _agent as agent_module
from src.amphi_service.server import ServerInstance, ServerStatus


@dataclass
class AgentCliHarness:
    monkeypatch: pytest.MonkeyPatch
    requests: list[httpx.Request] = field(default_factory=list)

    def manager(self, state: str = "running") -> SimpleNamespace:
        instance = None
        if state == "running":
            instance = ServerInstance(
                host="127.0.0.1",
                port=7421,
                pid=123,
                started_at="2026-01-01T00:00:00Z",
                token="test-token",
            )
        status = ServerStatus(state=state, runtime_file=Path("runtime.json"), instance=instance)
        return SimpleNamespace(status=lambda: status)

    def install_handler(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        def record(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            return handler(request)

        transport = httpx.MockTransport(record)
        client_type = httpx.Client
        self.monkeypatch.setattr(
            agent_module.httpx,
            "Client",
            lambda **kwargs: client_type(transport=transport, **kwargs),
        )


@pytest.fixture
def agent_cli_harness(monkeypatch: pytest.MonkeyPatch) -> AgentCliHarness:
    for variable in (
        agent_module.AgentCLI.SESSION_ID_ENV,
        agent_module.AgentCLI.PARENT_TOOL_CALL_ID_ENV,
        agent_module.AgentCLI.EXECUTION_MODE_ENV,
    ):
        monkeypatch.delenv(variable, raising=False)
    return AgentCliHarness(monkeypatch)
