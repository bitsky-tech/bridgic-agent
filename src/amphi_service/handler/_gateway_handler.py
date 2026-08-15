import asyncio
import os
import time

from fastapi import BackgroundTasks, Response
from starlette.requests import Request

from ._base import BaseHandler


# ~300ms is enough for the 202 body to reach the client before shutdown starts.
_SHUTDOWN_DELAY_SECONDS: float = 0.3


class GatewayHealthHandler(BaseHandler):
    """Bind: ``GET /api/gateway/health`` — public liveness probe.

    Public on purpose: clients call this BEFORE they read the bearer
    token from ``runtime.json``. Always 200.
    """

    tags = ["gateway"]

    async def get(self) -> Response:
        meta = self.gateway
        return self.response(
            {
                "status": "ok",
                "version": meta.version,
                "started_at": meta.started_at,
            }
        )


class GatewayInfoHandler(BaseHandler):
    """Bind: ``GET /api/gateway/info`` — daemon snapshot (auth)."""

    tags = ["gateway"]

    async def get(self) -> Response:
        meta = self.gateway
        clients_count = await self.clients.count()
        # The daemon serves requests before the Agent command environment
        # exists, so clients need to tell "still preparing" from "this install
        # cannot run commands at all".
        environment = self.agent_env.status()
        return self.response(
            {
                "pid": os.getpid(),
                "host": meta.bind_host or "127.0.0.1",
                "port": meta.bind_port or 0,
                "version": meta.version,
                "started_at": meta.started_at,
                "uptime_seconds": time.monotonic() - meta.started_at_monotonic,
                "ws_path": meta.ws_path,
                "connected_clients_count": clients_count,
                "agent_env": {
                    "status": environment.state,
                    "error": environment.error,
                },
            }
        )


class GatewayClientsHandler(BaseHandler):
    """Bind: ``GET /api/gateway/clients`` — currently-online clients (auth)."""

    tags = ["gateway"]

    async def get(self) -> Response:
        rows = await self.clients.list()
        return self.response(
            [
                {
                    "client_id": c.client_id,
                    "client_type": c.client_type,
                    "connected_at": c.connected_at,
                    "last_seen": c.last_seen,
                    "user_agent": c.user_agent,
                }
                for c in rows
            ]
        )


class GatewayShutdownHandler(BaseHandler):
    """Bind: ``POST /api/gateway/shutdown`` — graceful daemon stop (auth).

    Returns 202 immediately and schedules a cooperative Uvicorn shutdown via
    :class:`BackgroundTasks`; the foreground runner clears ``runtime.json``
    and releases the instance lock after shutdown.
    """

    tags = ["gateway"]

    async def post(
        self,
        request: Request,
        background_tasks: BackgroundTasks,
    ) -> Response:
        async def _delayed_term() -> None:
            await asyncio.sleep(_SHUTDOWN_DELAY_SECONDS)
            request.app.state.request_shutdown()

        background_tasks.add_task(_delayed_term)
        return self.response(
            {
                "shutting_down": True,
                "delay_seconds": _SHUTDOWN_DELAY_SECONDS,
            },
            status_code=202,
        )


__all__ = [
    "GatewayHealthHandler",
    "GatewayInfoHandler",
    "GatewayClientsHandler",
    "GatewayShutdownHandler",
]
