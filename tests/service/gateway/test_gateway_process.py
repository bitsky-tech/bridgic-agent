import json
from pathlib import Path

import httpx
import pytest
from websockets.asyncio.client import connect

from tests.service.gateway.conftest import GatewayCLI, RunningGateway


@pytest.mark.process
async def test_desktop_cold_start(gateway_cli: GatewayCLI) -> None:
    """Desktop's external startup protocol discovers and connects to a real Gateway.

    Final state:
    {
      "commands": ["status: stopped", "start: ready", "status: running", "stop"],
      "http": {"/api/gateway/info": "authenticated"},
      "websocket": {"client_type": "gui", "state": "ready"},
      "gateway": "stopped"
    }

    Checks:
    1. Desktop begins with a stopped CLI status and no runtime registration.
    2. The real background start publishes a live runtime and creates its service log.
    3. Desktop's HTTP discovery headers authenticate against that registered Gateway.
    4. Desktop's WebSocket hello frame connects and registers the same GUI client.
    5. The real stop command removes both the process and its runtime registration.
    """
    # Check 1: Desktop begins with a stopped CLI status and no runtime registration.
    initial = await gateway_cli.status()
    assert initial == {
        "status": "stopped",
        "runtime_file": str(gateway_cli.runtime_file),
    }
    assert not gateway_cli.runtime_file.exists()

    # Check 2: The real background start publishes a live runtime and creates its service log.
    started = await gateway_cli.start()
    assert started.returncode == 0, started.stderr
    running = await gateway_cli.status()
    assert running["status"] == "running"
    assert running["host"] == "127.0.0.1"
    assert running["port"] == gateway_cli.port
    assert running["pid"] == gateway_cli.owned_pid
    runtime_path = Path(running["runtime_file"])
    assert runtime_path == gateway_cli.runtime_file
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    identity_fields = ("host", "port", "pid", "started_at")
    assert {field: runtime[field] for field in identity_fields} == {
        field: running[field] for field in identity_fields
    }
    assert runtime["token"]
    assert runtime["ws_path"] == "/ws"
    service_log = runtime_path.with_name("server.log")
    assert Path(runtime["log_file"]) == service_log
    assert service_log.is_file()
    assert "[daemon-logging] started" in service_log.read_text(encoding="utf-8")

    client_id = "desktop-cold-start-gui"
    frontend_headers = {
        "Authorization": f"Bearer {runtime['token']}",
        "X-Client-Id": client_id,
        "X-Client-Type": "gui",
    }
    base_url = running["base_url"]
    async with httpx.AsyncClient(base_url=base_url, timeout=3) as client:
        # Check 3: Desktop's HTTP discovery headers authenticate the registered Gateway.
        info = await client.get("/api/gateway/info", headers=frontend_headers)
        assert info.status_code == 200
        metadata = info.json()
        assert {field: metadata[field] for field in identity_fields} == {
            field: runtime[field] for field in identity_fields
        }
        assert metadata["ws_path"] == runtime["ws_path"]
        current = json.loads(runtime_path.read_text(encoding="utf-8"))
        registration_fields = (*identity_fields, "token")
        assert {field: current[field] for field in registration_fields} == {
            field: runtime[field] for field in registration_fields
        }

        # Check 4: Desktop's WebSocket hello connects and registers the same GUI client.
        websocket_url = f"ws://{runtime['host']}:{runtime['port']}{runtime['ws_path']}"
        async with connect(websocket_url, proxy=None) as websocket:
            await websocket.send(json.dumps({
                "type": "hello",
                "token": runtime["token"],
                "client_type": "gui",
                "client_id": client_id,
                "locale": "en",
            }))
            assert json.loads(await websocket.recv()) == {"type": "ready"}
            clients = await client.get("/api/gateway/clients", headers=frontend_headers)
            assert clients.status_code == 200
            assert any(
                item["client_id"] == client_id and item["client_type"] == "gui"
                for item in clients.json()
            )

    # Access traffic must not consume the bounded application diagnostic log.
    assert "GET /api/gateway/info" not in service_log.read_text(encoding="utf-8")

    # Check 5: The real stop command removes the process and its runtime registration.
    stopped = await gateway_cli.stop()
    assert stopped.returncode == 0, stopped.stderr
    assert (await gateway_cli.status())["status"] == "stopped"
    assert not gateway_cli.runtime_file.exists()


@pytest.mark.process
async def test_single_instance(running_gateway: RunningGateway) -> None:
    """A live Gateway keeps sole ownership of its process registration.

    Final state:
    {
      "first_gateway": {"state": "healthy", "pid": "<original>"},
      "second_gateway": {"started": false, "exit_code": 1}
    }

    Checks:
    1. A competing foreground start is rejected by the shared instance lock.
    2. The rejected start does not replace or interrupt the original Gateway.
    """
    # Check 1: A competing foreground start is rejected by the shared instance lock.
    competing = await running_gateway.compete()
    assert competing.returncode == 1
    assert "already owns the server lock" in competing.stdout

    # Check 2: The rejected start does not replace or interrupt the original Gateway.
    assert running_gateway.process.poll() is None
    current = json.loads(running_gateway.runtime_file.read_text(encoding="utf-8"))
    assert current["pid"] == running_gateway.pid
    async with httpx.AsyncClient(base_url=running_gateway.base_url, timeout=3) as client:
        assert (await client.get("/api/gateway/health")).status_code == 200
