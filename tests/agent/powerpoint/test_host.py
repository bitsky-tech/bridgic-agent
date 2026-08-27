from typing import Any

from src.amphi_agent._powerpoint import PowerPointHost


class _Controller:
    controller_id = "desktop"
    generation = "generation-1"
    cdp_endpoint = "http://127.0.0.1:43101"

    def __init__(self) -> None:
        self.released: list[str] = []

    async def ensure_session(self, session_id: str) -> Any:
        return type("Surface", (), {"target_id": f"target-{session_id}"})()

    async def get_session(self, session_id: str) -> Any:
        return type("Surface", (), {"target_id": f"target-{session_id}"})()

    async def release_session(self, session_id: str) -> None:
        self.released.append(session_id)


class _Client:
    def __init__(self, cdp_endpoint: str) -> None:
        self.cdp_endpoint = cdp_endpoint
        self.connected: tuple[str, str] | None = None
        self.requests: list[dict[str, Any]] = []
        self.live = False

    async def connect(self, target_id: str, session_id: str) -> None:
        self.connected = (target_id, session_id)
        self.live = True

    def is_live(self) -> bool:
        return self.live

    async def dispatch(self, request: dict[str, Any]) -> Any:
        self.requests.append(request)
        return {"method": request["method"]}

    async def disconnect(self) -> None:
        self.live = False


async def test_session_handle_binds_one_electron_target_and_reuses_it() -> None:
    clients: list[_Client] = []

    def factory(cdp_endpoint: str) -> _Client:
        client = _Client(cdp_endpoint)
        clients.append(client)
        return client

    host = PowerPointHost(prepare_playwright=lambda: None, session_factory=factory)  # type: ignore[arg-type]
    controller = _Controller()
    host._controller = controller  # type: ignore[assignment]
    host._connected_generation = controller.generation
    first = host.for_session("session-a")
    assert first is host.for_session("session-a")

    assert await first.list_presentations() == {"method": "list"}
    assert await first.snapshot() == {"method": "snapshot"}
    assert len(clients) == 1
    assert clients[0].connected == ("target-session-a", "session-a")
    assert clients[0].requests == [
        {"method": "list"},
        {"method": "snapshot", "params": None},
    ]

    await host.release_sessions(["session-a"])
    assert controller.released == ["session-a"]
    assert clients[0].live is False
