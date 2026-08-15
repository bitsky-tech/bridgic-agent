"""Shared pytest fixtures for end-to-end tests.

Philosophy: tests drive the **production HTTP / WS API** through an
in-process ASGI transport (HTTP) or a real uvicorn port (WS). They never
import handler classes / services directly; they POST / GET / WS like a
real client would. The only piece replaced is the remote LLM provider —
a :class:`MockLLMServer` running on a random local port answers
``/v1/chat/completions`` so chat tests don't burn API credits.

Fixture overview
----------------

* :func:`temp_db_path`   — fresh SQLite path under pytest's ``tmp_path``
                            (one per test, auto-cleaned).
* :func:`service_app`    — a clean :class:`ServiceApp` instance with
                            **no** AI credentials. Tests that need creds
                            POST to ``/credentials`` themselves, which
                            mirrors how a real client wires up the daemon.
* :func:`client`         — an ``httpx.AsyncClient`` bound to the service
                            app via ASGI transport (no real network).
* :func:`mock_llm`       — function-scoped mock LLM server (uvicorn on a
                            random port). Restarted per test for clean
                            request-log state; cheap enough (~50ms).

Chat E2E tests use real WS — see ``tests/test_ws.py`` for the
``ws_service`` / ``ws_creds`` fixtures that spin up uvicorn on a random
port. The httpx-ASGI ``client`` fixture above still works for every
REST endpoint (``/me``, ``/sessions``, ``/api/gateway/*``), just not
for ``/ws`` itself (httpx ASGI transport doesn't speak WebSocket).
"""

from __future__ import annotations

import asyncio
import os
import socket
from pathlib import Path
from typing import AsyncIterator, Iterator, Tuple

import httpx
import pytest
import uvicorn

from src.amphi_service._app import ServiceApp
from src.amphi_service.server._uvicorn import GracefulServer
from src.amphi_store import Repository, UserRepository

from ._mock_llm import MockLLMServer
from src.amphi_agent.runtime._environment import (
    agent_cli_shim,
    app_command_environment,
    bundled_node_base_runtime,
    bundled_node_runtime,
    bundled_python_runtime,
    bundled_runtime_resources,
    bundled_uv_runtime,
)


collect_ignore: list[str] = []

if os.getenv("AMPHI_RUN_LIVE_TESTS") != "1":
    collect_ignore += ["live_capabilities", "test_google_live.py"]

# Perf baselines seed thousands of rows through the real write path, so they
# take minutes. Opt-in only: `AMPHI_RUN_PERF_TESTS=1 uv run pytest tests/perf -s`.
if os.getenv("AMPHI_RUN_PERF_TESTS") != "1":
    collect_ignore += ["perf"]


@pytest.fixture(autouse=True)
def _isolate_app_command_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> Iterator[None]:
    """Keep tests off real app resources while preserving the strict production default."""
    for name in (
        "AMPHI_BUNDLED_RESOURCES_DIR",
        "AMPHI_BUNDLED_BIN_DIR",
        "AMPHI_BUNDLED_UV_BIN_DIR",
        "AMPHI_BUNDLED_UV_RUNTIME_DIR",
        "AMPHI_BUNDLED_PYTHON_RUNTIME_DIR",
        "AMPHI_BUNDLED_PYTHON",
        "AMPHI_BUNDLED_NODE_RUNTIME_DIR",
        # Same class as the AMPHI_BUNDLED_* vars above, and it was the one
        # missing. `AppCommandEnvironment._build` derives
        # `python_executable` straight from `UV_PYTHON`, so a developer shell
        # — or a CI runner — that exports it hands the suite an app-level
        # Python it was never given. `astral-sh/setup-uv` does exactly that
        # whenever `python-version` is set, which is why
        # test_child_context_exposes_workflow_runtime_but_hides_root_only_capabilities
        # asserted "app-level Python unavailable" successfully on every
        # developer machine and failed on the runner. The fixture exists to
        # keep tests off real app resources; an ambient interpreter is one.
        "UV_PYTHON",
    ):
        monkeypatch.delenv(name, raising=False)

    data_home = tmp_path / "app-data"
    monkeypatch.setattr(agent_cli_shim, "root", data_home / "command-shims")
    monkeypatch.setattr(bundled_runtime_resources, "_source_root", tmp_path)
    monkeypatch.setattr(bundled_uv_runtime, "data_home", data_home)
    monkeypatch.setattr(bundled_python_runtime, "data_home", data_home)
    monkeypatch.setattr(bundled_python_runtime, "root", data_home / "python" / "base")
    monkeypatch.setattr(bundled_node_base_runtime, "data_home", data_home)
    monkeypatch.setattr(bundled_node_base_runtime, "root", data_home / "node" / "base")
    monkeypatch.setattr(bundled_node_base_runtime, "cache", data_home / "node" / "cache")
    bundled_runtime_resources.reset_cache()
    monkeypatch.setattr(app_command_environment, "strict", False)
    app_command_environment.reset()
    yield
    app_command_environment.reset()


@pytest.fixture(autouse=True)
def _reset_bundled_runtimes() -> None:
    """Keep process-wide packaged-runtime discovery isolated between tests."""
    bundled_uv_runtime.reset_cache()
    bundled_python_runtime.reset()
    bundled_node_runtime.reset_cache()
    bundled_node_base_runtime.reset()


def _find_free_port() -> int:
    """Bind a random free localhost port and return its number."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ----------------------------------------------------------------------
# DB path — fresh per test, lives under pytest's tmp_path
# ----------------------------------------------------------------------
@pytest.fixture
def temp_db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Yield a tmp DB path AND wire it into the DB connection via env var.

    ``Repository.connect()`` reads ``$BRIDGIC_AGENT_STATE_DB`` as a
    fallback before ``DEFAULT_PATH``. Setting it here means any
    ``ServiceApp()`` constructed by the test lands on the tmp file,
    so we don't need a ``persistence=`` ctor kwarg on ``ServiceApp``.
    """
    path = tmp_path / "test.db"
    monkeypatch.setenv("BRIDGIC_AGENT_STATE_DB", str(path))
    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setenv(
        "BRIDGIC_AGENT_ATTACHMENTS_ROOT",
        str(tmp_path / "attachments"),
    )
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "runs"))
    monkeypatch.setenv("BRIDGIC_AGENT_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    return path


# ----------------------------------------------------------------------
# Connected repository — for unit tests that assemble prompts directly
# ----------------------------------------------------------------------
@pytest.fixture
async def connected_repo(tmp_path: Path) -> AsyncIterator[None]:
    """Connect a throwaway SQLite repository without starting the HTTP app."""
    Repository.connect(tmp_path / "assembly.db")
    await Repository.init_schema()
    try:
        yield
    finally:
        await Repository.close()


# ----------------------------------------------------------------------
# ServiceApp — clean state, no AI credentials wired
# ----------------------------------------------------------------------
@pytest.fixture
async def service_app(temp_db_path: Path) -> AsyncIterator[ServiceApp]:
    """A fresh :class:`ServiceApp` with an empty-credentials baseline.

    Model credentials are product-managed, so startup never imports the
    developer's real ``.env`` keys. Tests that need creds POST them through
    the product API.

    The DB path comes from ``BRIDGIC_AGENT_STATE_DB`` (set by the
    ``temp_db_path`` fixture this depends on), not from a ctor kwarg.
    """
    app = ServiceApp(bind_host=None, bind_port=None)
    # Drive the FastAPI lifespan so init_schema + seed_local_user run.
    async with app.app.router.lifespan_context(app.app):
        await UserRepository().set_model("local", "mock-model")
        yield app


# ----------------------------------------------------------------------
# httpx async client bound via ASGI transport
# ----------------------------------------------------------------------
@pytest.fixture
async def client(service_app: ServiceApp) -> AsyncIterator[httpx.AsyncClient]:
    """An authenticated client — every route but the health probe needs one.

    The bearer header is attached here rather than in each test because the
    router authenticates by default (see ``ServiceApp._build_router``); a
    client without it can only reach ``/api/gateway/health``. Use
    :func:`anonymous_client` to assert that a route rejects callers.
    """
    transport = httpx.ASGITransport(app=service_app.app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://127.0.0.1",
        headers={"Authorization": f"Bearer {service_app.state.auth.current_token}"},
    ) as c:
        yield c


@pytest.fixture
async def anonymous_client(service_app: ServiceApp) -> AsyncIterator[httpx.AsyncClient]:
    """A client with no bearer token, for asserting that auth is enforced."""
    transport = httpx.ASGITransport(app=service_app.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
        yield c


def live_client(base: str, token: str) -> httpx.AsyncClient:
    """An authenticated client for the real-network (``ws_service``) fixtures.

    The ASGI-transport :func:`client` fixture can't reach a uvicorn-backed
    daemon, so those tests build their own client against ``base``. This
    helper keeps the bearer header on them — every REST route requires one.
    """
    return httpx.AsyncClient(
        base_url=base, headers={"Authorization": f"Bearer {token}"}
    )


# ----------------------------------------------------------------------
# Mock LLM — real HTTP on a random local port
# ----------------------------------------------------------------------
@pytest.fixture
async def mock_llm() -> AsyncIterator[MockLLMServer]:
    server = MockLLMServer()
    await server.start()
    yield server
    await server.stop()


# ----------------------------------------------------------------------
# WS service — real uvicorn (GracefulServer) on a random local port
# ----------------------------------------------------------------------
@pytest.fixture
async def ws_service(temp_db_path: Path) -> AsyncIterator[Tuple[ServiceApp, str, str]]:
    """Yield ``(app, ws_url, base_http)`` for a live uvicorn-backed daemon.

    httpx's ASGI transport doesn't speak WebSocket, so any test that
    actually opens a ``/ws`` connection needs a real network endpoint.
    The fixture does not use :class:`UvicornRunner`, so it does not acquire
    the instance lock or publish runtime.json; uvicorn does the network listen.
    We use :class:`GracefulServer` so the shutdown broadcast path is
    exercised exactly like production.
    """
    # ``temp_db_path`` has already set ``$BRIDGIC_AGENT_STATE_DB`` via
    # monkeypatch; ``ServiceApp()`` calls ``Repository.connect()``
    # internally and picks up the env var.
    _ = temp_db_path  # keep the dependency explicit for the reader
    app = ServiceApp(bind_host=None, bind_port=None)

    port = _find_free_port()
    uconfig = uvicorn.Config(
        app.app, host="127.0.0.1", port=port, log_level="error",
    )
    server = GracefulServer(uconfig, pre_shutdown=app.pre_shutdown_hook)
    task = asyncio.create_task(server.serve())

    deadline = asyncio.get_event_loop().time() + 5.0
    while not server.started and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.02)
    if not server.started:
        task.cancel()
        raise RuntimeError("uvicorn didn't start within 5s")
    await UserRepository().set_model("local", "mock-model")

    base = f"http://127.0.0.1:{port}"
    ws_url = f"ws://127.0.0.1:{port}/ws"
    try:
        yield app, ws_url, base
    finally:
        # Cooperative shutdown first; cancel + drain if it stalls.
        # Draining the cancelled task is important: a still-running
        # uvicorn coroutine on the loop would interfere with the next
        # test (sockets, signal handlers).
        server.should_exit = True
        try:
            await asyncio.wait_for(task, timeout=10.0)
        except asyncio.TimeoutError:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, BaseException):  # noqa: BLE001
                pass


@pytest.fixture
async def ws_creds(ws_service, mock_llm) -> AsyncIterator[Tuple[str, str]]:
    """Pre-wire mock LLM credentials so chat works; yield ``(ws_url, token)``."""
    app, ws_url, base = ws_service
    token = app.state.auth.current_token
    async with httpx.AsyncClient(
        base_url=base, headers={"Authorization": f"Bearer {token}"}
    ) as http:
        resp = await http.post(
            "/me/credentials",
            json={"api_key": "test-key", "base_url": mock_llm.base_url},
        )
        assert resp.status_code == 200
    yield ws_url, token
