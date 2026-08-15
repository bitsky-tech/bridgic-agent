"""``/api/gateway/*`` — auth gating + payload shape + client tracking.

health is public; info / clients / shutdown are bearer-gated. The fixture
builds :class:`ServiceApp` without the outer :class:`UvicornRunner`, so no
instance lock or ``runtime.json`` registration is involved.
"""

from __future__ import annotations

from typing import Dict

import httpx
import pytest

from src import __version__
from src.amphi_service._app import ServiceApp


@pytest.fixture
def auth_header(service_app: ServiceApp) -> Dict[str, str]:
    """Bearer header carrying the daemon's generated token."""
    return {"Authorization": f"Bearer {service_app.state.auth.current_token}"}


async def test_health_is_public_and_token_is_per_app(
    anonymous_client: httpx.AsyncClient, temp_db_path
) -> None:
    """The health probe needs no auth and a bogus token doesn't break it; and
    each ServiceApp init generates a unique bearer token (restart = new token).
    The extra apps build unmanaged (no lifespan), so the DB is never touched.

    Uses ``anonymous_client`` deliberately: the default ``client`` sends a
    valid token, which would make this pass whether or not health is public.
    """
    body = (await anonymous_client.get("/api/gateway/health")).json()
    assert body["status"] == "ok"
    assert body["version"] == __version__
    assert isinstance(body["started_at"], str) and body["started_at"]
    bogus = await anonymous_client.get(
        "/api/gateway/health", headers={"Authorization": "Bearer nope"}
    )
    assert bogus.status_code == 200

    # Fresh token per app: restart yields a new bearer token.
    a = ServiceApp(bind_host=None, bind_port=None)
    b = ServiceApp(bind_host=None, bind_port=None)
    assert a.state.auth.current_token and b.state.auth.current_token
    assert a.state.auth.current_token != b.state.auth.current_token


async def test_info_payload_and_clients_tracking(
    client: httpx.AsyncClient, anonymous_client: httpx.AsyncClient, auth_header
) -> None:
    """Both bearer-gated reads in one flow: /info and /clients 401 (with
    WWW-Authenticate) when unauth'd or wrong-token; with a valid token /info
    returns the gateway payload (initially 0 clients) and /clients is empty;
    X-Client-Id touches auto-register and surface in /clients, and the /info
    count then reflects the touched clients."""
    # Unauthenticated / wrong-token → 401 on both gated endpoints.
    unauth = await anonymous_client.get("/api/gateway/info")
    assert unauth.status_code == 401
    assert unauth.headers.get("WWW-Authenticate") == "Bearer"
    wrong = await anonymous_client.get(
        "/api/gateway/info", headers={"Authorization": "Bearer wrong"}
    )
    assert wrong.status_code == 401
    assert (await anonymous_client.get("/api/gateway/clients")).status_code == 401

    # Valid token: payload + initially-empty client roster.
    body = (await client.get("/api/gateway/info", headers=auth_header)).json()
    assert body["version"] == __version__
    assert body["ws_path"] == "/ws"
    assert body["uptime_seconds"] >= 0
    assert body["connected_clients_count"] == 0
    assert body["host"] == "127.0.0.1" and body["port"] == 0  # unmanaged-mode defaults
    assert "pid" in body and "started_at" in body
    assert (await client.get("/api/gateway/clients", headers=auth_header)).json() == []

    # X-Client-Id touches auto-register and surface in /clients.
    for cid, ctype in [("gui-1", "gui"), ("tray-1", "tray"), ("cli-1", "cli")]:
        await client.get(
            "/api/gateway/health", headers={"X-Client-Id": cid, "X-Client-Type": ctype}
        )
    rows = (await client.get("/api/gateway/clients", headers=auth_header)).json()
    assert {r["client_id"] for r in rows} == {"gui-1", "tray-1", "cli-1"}
    gui = next(r for r in rows if r["client_id"] == "gui-1")
    assert gui["client_type"] == "gui"
    assert isinstance(gui["connected_at"], float) and isinstance(gui["last_seen"], float)

    info = (await client.get("/api/gateway/info", headers=auth_header)).json()
    assert info["connected_clients_count"] == 3


async def test_info_reports_agent_environment_readiness(
    client: httpx.AsyncClient, service_app: ServiceApp, auth_header
) -> None:
    """The daemon answers before its command environment exists, so it says so.

    A client that only knows the daemon is up cannot tell "still preparing"
    from "this install is broken"; both look like an Agent that refuses to
    run. The payload carries the distinction.
    """
    body = (await client.get("/api/gateway/info", headers=auth_header)).json()
    assert set(body["agent_env"]) == {"status", "error"}
    assert body["agent_env"]["status"] in {"preparing", "ready"}

    await service_app.state.invocations.prepare()
    ready = (await client.get("/api/gateway/info", headers=auth_header)).json()
    assert ready["agent_env"] == {"status": "ready", "error": None}


async def test_browser_controller_registration_is_authenticated_and_secret_safe(
    client: httpx.AsyncClient,
    anonymous_client: httpx.AsyncClient,
    auth_header,
) -> None:
    endpoint = "/api/browser/controller"
    registration = {
        "controller_id": "electron-main",
        "generation": "generation-1",
        "control_url": "http://127.0.0.1:43111",
        "control_token": "controller-token-long-enough",
        "cdp_endpoint": "http://127.0.0.1:43112",
        "owner_pid": 9876,
    }

    # `client` carries the bearer token by default (the router authenticates
    # everything but the health probe), so asserting rejection needs the
    # anonymous one — otherwise this reads as "auth enforced" while proving nothing.
    assert (await anonymous_client.get(endpoint)).status_code == 401
    assert (await anonymous_client.put(endpoint, json=registration)).status_code == 401
    assert (
        await anonymous_client.request(
            "DELETE",
            endpoint,
            json={"controller_id": "electron-main"},
        )
    ).status_code == 401

    assert (await client.get(endpoint, headers=auth_header)).json() == {"available": False}
    registered = await client.put(endpoint, headers=auth_header, json=registration)
    assert registered.status_code == 200
    assert registered.json() == {
        "available": True,
        "controller_id": "electron-main",
        "generation": "generation-1",
        "owner_pid": 9876,
    }
    serialized = registered.text
    assert registration["control_token"] not in serialized
    assert registration["control_url"] not in serialized
    assert registration["cdp_endpoint"] not in serialized

    stale = await client.request(
        "DELETE",
        endpoint,
        headers=auth_header,
        json={"controller_id": "stale-controller"},
    )
    assert stale.json() == {"removed": False}
    assert (await client.get(endpoint, headers=auth_header)).json()["available"] is True

    removed = await client.request(
        "DELETE",
        endpoint,
        headers=auth_header,
        json={"controller_id": "electron-main"},
    )
    assert removed.json() == {"removed": True}
    assert (await client.get(endpoint, headers=auth_header)).json() == {"available": False}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("control_url", "http://example.com:43111"),
        ("cdp_endpoint", "http://192.168.1.20:43112"),
        ("control_url", "http://127.0.0.1:43111?token=leak"),
        ("cdp_endpoint", "http://127.0.0.1:43112/#fragment"),
        ("control_url", "http://user:password@127.0.0.1:43111"),
        ("cdp_endpoint", "http://127.0.0.1:43112/devtools/browser/test"),
    ],
)
async def test_browser_controller_rejects_non_loopback_or_ambiguous_endpoints(
    client: httpx.AsyncClient,
    auth_header,
    field: str,
    value: str,
) -> None:
    registration = {
        "controller_id": "electron-main",
        "generation": "generation-1",
        "control_url": "http://127.0.0.1:43111",
        "control_token": "controller-token-long-enough",
        "cdp_endpoint": "http://127.0.0.1:43112",
        "owner_pid": 9876,
        field: value,
    }

    response = await client.put(
        "/api/browser/controller",
        headers=auth_header,
        json=registration,
    )

    assert response.status_code == 422
    assert (await client.get("/api/browser/controller", headers=auth_header)).json() == {
        "available": False,
    }


async def test_shutdown(
    client: httpx.AsyncClient,
    anonymous_client: httpx.AsyncClient,
    auth_header,
    monkeypatch,
) -> None:
    """Standalone apps fall back to SIGTERM after the authenticated 202."""
    import asyncio
    import os
    import signal

    # Neutralise os.kill BEFORE any request can reach the shutdown route.
    # This handler really does SIGTERM the current process, which is the
    # pytest process here — if a request slips through unstubbed, the whole
    # run dies with 143 and no failure report.
    captured: list = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: captured.append((pid, sig)))

    assert (await anonymous_client.post("/api/gateway/shutdown")).status_code == 401

    resp = await client.post("/api/gateway/shutdown", headers=auth_header)
    assert resp.status_code == 202
    body = resp.json()
    assert body["shutting_down"] is True and body["delay_seconds"] > 0

    await asyncio.sleep(body["delay_seconds"] + 0.2)  # let the background task fire
    assert captured == [(os.getpid(), signal.SIGTERM)]


async def test_state_changing_routes_reject_anonymous_callers(
    anonymous_client: httpx.AsyncClient,
) -> None:
    """Every step of the documented attack chain now needs a bearer token.

    Each call below succeeded with no credential at all before the router-level
    dependency landed, which let any web page in the user's browser drive the
    daemon (fixed loopback port, so no discovery needed). ``/me/execution-mode``
    is the worst of them: it is the master switch for the permission engine, so
    flipping it to ``full`` makes every later tool call auto-approve.
    """
    chain = [
        ("post", "/me/execution-mode", {"mode": "full"}),
        ("post", "/sessions", {}),
        ("post", "/schedules", {"description": "x", "cron": "* * * * *"}),
    ]
    for method, path, payload in chain:
        resp = await getattr(anonymous_client, method)(path, json=payload)
        assert resp.status_code == 401, f"{method.upper()} {path} was reachable"
        assert resp.headers.get("WWW-Authenticate") == "Bearer"

    assert (await anonymous_client.get("/me/providers")).status_code == 401


async def test_foreign_host_header_is_refused(
    anonymous_client: httpx.AsyncClient,
) -> None:
    """DNS-rebinding guard: an attacker-controlled Host never reaches a route.

    A domain that resolves to 127.0.0.1 would make the browser treat the daemon
    as same-origin — defeating CORS — but the Host header still names the
    attacker's domain, and TrustedHostMiddleware rejects it before dispatch.
    """
    resp = await anonymous_client.get(
        "/api/gateway/health", headers={"Host": "amphi.evil.example"}
    )
    assert resp.status_code == 400


async def test_cors_does_not_echo_foreign_origins(
    anonymous_client: httpx.AsyncClient,
) -> None:
    """A page on another origin can't read our responses."""
    evil = await anonymous_client.get(
        "/api/gateway/health", headers={"Origin": "https://evil.example"}
    )
    assert "access-control-allow-origin" not in evil.headers

    # The packaged renderer runs from file://, which sends `Origin: null`.
    ours = await anonymous_client.get(
        "/api/gateway/health", headers={"Origin": "null"}
    )
    assert ours.headers.get("access-control-allow-origin") == "null"
