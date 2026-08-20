import asyncio
import os
import socket
import sys
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, cast

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import connect

from src.amphi_store import Repository, UserRepository
from tests._support.sandbox import IsolatedPaths

from tests.service.flows._scripted_llm import FLOW_MODEL, ScriptedLlm
from tests.service.flows._websocket import WebSocketRecorder

if TYPE_CHECKING:
    from src.amphi_service._app import ServiceApp


@dataclass(frozen=True, slots=True)
class FlowServer:
    """The real local socket boundary for one Flow test."""

    ws_url: str
    token: str


@pytest.fixture
def scripted_llm() -> Iterator[ScriptedLlm]:
    """Provide one strict model script and verify that the Agent consumed it."""
    llm = ScriptedLlm(model=FLOW_MODEL)
    yield llm
    llm.assert_finished()


@pytest.fixture
async def flow_app(test_sandbox: IsolatedPaths, scripted_llm: ScriptedLlm, monkeypatch: pytest.MonkeyPatch):
    """Run the real Service lifespan with only the external model scripted."""
    from src.amphi_agent.runtime._environment import (
        AppCommandEnvironmentSnapshot,
        app_command_environment,
    )
    from src.amphi_service._app import ServiceApp
    from src.amphi_service.auth import LOCAL_USER_ID

    command_environment = {
        **test_sandbox.process_environment(),
        "PATH": os.environ.get("PATH", ""),
    }
    command_snapshot = AppCommandEnvironmentSnapshot(
        environment=MappingProxyType(command_environment),
        managed_environment=MappingProxyType(dict(command_environment)),
        uv_executable=None,
        uv_version=None,
        python_executable=Path(sys.executable),
        python_version=sys.version.split()[0],
        node_executable=None,
        node_version=None,
    )
    monkeypatch.setattr(app_command_environment, "snapshot", lambda: command_snapshot)

    await Repository.close()
    service = ServiceApp(bind_host="127.0.0.1", bind_port=0)
    service.bind_shutdown(lambda: None)
    await service.state.llms.set((LOCAL_USER_ID, FLOW_MODEL), cast(Any, scripted_llm))
    async with service.app.router.lifespan_context(service.app):
        await UserRepository().set_active_provider(
            LOCAL_USER_ID,
            api_key="flow-test-key",
            base_url="http://model.invalid/v1",
            protocol="openai",
            model=FLOW_MODEL,
        )
        yield service


@pytest.fixture
async def flow_client(flow_app: "ServiceApp") -> AsyncIterator[httpx.AsyncClient]:
    """Call the isolated Flow Service through its authenticated HTTP boundary."""
    transport = httpx.ASGITransport(app=flow_app.app, raise_app_exceptions=False)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://127.0.0.1",
        headers={
            "Authorization": f"Bearer {flow_app.state.auth.current_token}",
            "Accept-Language": "en",
        },
    ) as client:
        yield client


@pytest.fixture
async def flow_server(flow_app: "ServiceApp") -> AsyncIterator[FlowServer]:
    """Serve the isolated App on a real socket without entering its lifespan."""
    class ReadyServer(uvicorn.Server):
        def __init__(self, config: uvicorn.Config) -> None:
            super().__init__(config)
            self.ready = asyncio.Event()

        async def startup(self, sockets: list[socket.socket] | None = None) -> None:
            await super().startup(sockets=sockets)
            self.ready.set()

    config = uvicorn.Config(flow_app.app, host="127.0.0.1", port=0, lifespan="off", log_level="warning")
    server = ReadyServer(config)
    bound_socket = config.bind_socket()
    port = bound_socket.getsockname()[1]
    task = asyncio.create_task(server.serve(sockets=[bound_socket]))
    try:
        await asyncio.wait_for(server.ready.wait(), timeout=3)
        yield FlowServer(
            ws_url=f"ws://127.0.0.1:{port}/ws",
            token=flow_app.state.auth.current_token,
        )
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(task, timeout=3)
        except TimeoutError:
            server.force_exit = True
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        finally:
            bound_socket.close()


@pytest.fixture
async def flow_socket(flow_server: FlowServer) -> AsyncIterator[WebSocketRecorder]:
    """Open and authenticate one real WebSocket connection to the Flow Service."""
    async with connect(flow_server.ws_url, proxy=None) as connection:
        recorder = WebSocketRecorder(connection)
        await recorder.send({
            "type": "hello",
            "token": flow_server.token,
            "client_id": "flow-test-client",
            "client_type": "gui",
            "locale": "en",
        })
        assert await recorder.receive() == {"type": "ready"}
        yield recorder
