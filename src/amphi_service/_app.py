import asyncio
import logging
import os
import signal
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .. import __version__
from .auth import TokenAuth, get_current_user, require_bearer_token, seed_local_user
from .handler import (
    AgentRunHandler,
    AgentStatusHandler,
    BrowserControllerHandler,
    ChatHandler,
    GatewayClientsHandler,
    GatewayHealthHandler,
    GatewayInfoHandler,
    GatewayShutdownHandler,
    InteractionHandledHandler,
    MeActiveModelHandler,
    MeCredentialsHandler,
    MeExecutionModeHandler,
    MeMemoryItemHandler,
    MeMemoryListHandler,
    MeModelHandler,
    MeProfileHandler,
    MeProviderCodexLocalHandler,
    MeProviderItemHandler,
    MeProviderOAuthCancelHandler,
    MeProviderOAuthHandler,
    MeProviderOAuthStatusHandler,
    MeProviderApiKeyHandler,
    MeProviderFetchModelsHandler,
    MeProviderTestHandler,
    MeProviderToggleHandler,
    MeProvidersHandler,
    ProvidersCatalogHandler,
    ReadHandler,
    ResetHandler,
    ServiceState,
    SessionDetailHandler,
    SessionDuplicateHandler,
    SessionListHandler,
    SessionFileHandler,
    SessionMessagesHandler,
    SessionMountListHandler,
    SessionMountUploadHandler,
    SessionMountsHandler,
    SkillItemHandler,
    SkillToggleHandler,
    SkillsHandler,
    SkillsImportCheckHandler,
    SkillsImportExecuteHandler,
    SkillsImportScanHandler,
    StopHandler,
    SubAgentRunHandler,
    TokensHandler,
    WorkflowItemHandler,
    WorkflowRunFileHandler,
    WorkflowRunItemHandler,
    WorkflowRunsHandler,
    WorkflowsHandler,
    ScheduleItemHandler,
    ScheduleKillHandler,
    ScheduleRunNowHandler,
    SchedulesHandler,
)
from .protocol import SystemShutdownEvent
from .server import (
    DEFAULT_WS_PATH,
    GatewayMeta,
)
from .runtime import (
    AgentEnvironmentSupervisor,
    SchedulerService,
    SessionEventBroker,
    SessionService,
    SystemEventBroker,
)
from ..amphi_agent import AGENT_NAME, AgentInvocation, BrowserHost, PowerPointHost
from ..amphi_store import Repository
from .runtime._history_md import render_history_markdown
from .cache import ClientRegistry, LlmCache
from .i18n import locale_from_accept_language, use_locale


# Client identity header constants — clients put ``X-Client-Id`` /
# ``X-Client-Type`` on every request so the gateway can list "who's
# online" without per-client tokens.
HEADER_CLIENT_ID = "X-Client-Id"
HEADER_CLIENT_TYPE = "X-Client-Type"

logger = logging.getLogger(__name__)


################################################################################################################
# ClientIdMiddleware — parse headers + auto-register
################################################################################################################


class ClientIdMiddleware(BaseHTTPMiddleware):
    """Read ``X-Client-Id`` / ``X-Client-Type``, touch the registry, and bind
    the request's ``Accept-Language`` preference.

    If ``X-Client-Id`` is present, ``await``\\ s :meth:`ClientRegistry.touch`
    so the client shows up in ``GET /api/gateway/clients`` and refreshes
    ``last_seen``.

    Touching on EVERY request (not just ``/api/*``) is deliberate: any
    request from a known client should refresh ``last_seen`` no
    matter which endpoint they hit. Requests without ``X-Client-Id``
    (for example ad-hoc curl calls) are silently skipped — no junk entries.

    Locale binding lives here rather than in its own middleware on purpose:
    ``BaseHTTPMiddleware`` spawns a task and pumps the response body through a
    memory stream per layer, so a second layer taxed every request (and every
    streamed chunk) just to read one header and set a contextvar.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        client_id = request.headers.get(HEADER_CLIENT_ID)
        client_type = request.headers.get(HEADER_CLIENT_TYPE) or "unknown"

        if client_id:
            clients: Optional[ClientRegistry] = getattr(
                request.app.state, "clients", None,
            )
            if clients is not None:
                await clients.touch(
                    client_id=client_id,
                    client_type=client_type,
                    user_agent=request.headers.get("User-Agent"),
                )

        locale = locale_from_accept_language(request.headers.get("Accept-Language"))
        with use_locale(locale):
            return await call_next(request)


################################################################################################################
# Server Application
################################################################################################################


class ServiceApp:
    def __init__(
        self,
        *,
        bind_host: Optional[str] = None,
        bind_port: Optional[int] = None,
    ) -> None:
        self._shutdown_callback: Optional[Callable[[], None]] = None
        self._load_environment()

        # Build the lifecycle-grouped ServiceState:
        #   persistence — durable (SQLite), bound to the Repository base
        #   llms / invocations / event buses — runtime peers
        #   auth        — bearer-token holder for /api/* (fresh per startup)
        #   clients     — X-Client-Id observability registry
        #   gateway     — startup-constant snapshot for /api/gateway/info
        # The one process-wide DB connection lives on the Repository base
        # (built once here); every (arg-less) repository reaches it. The
        # lifespan drives init_schema / close via the classmethods.
        Repository.connect()
        llms = LlmCache()
        session_events = SessionEventBroker()
        system_events = SystemEventBroker()
        sessions = SessionService()
        browser_host = BrowserHost()
        powerpoint_host = PowerPointHost()
        invocations = AgentInvocation(
            llms,
            session_events,
            system_events,
            browser_host=browser_host,
            powerpoint_host=powerpoint_host,
            history_renderer=render_history_markdown,
        )
        scheduler = SchedulerService(invocations, sessions, system_events=system_events)
        # Let schedule-deleting agent tools cancel an in-flight run (parity with
        # the REST DELETE). Bound post-construction: the scheduler holds the
        # invocation, so this closes the loop without a service import cycle.
        invocations.bind_schedule_killer(scheduler.kill)
        # Preparing the shared Python/Node bases is the one startup step that
        # can fail for reasons that clear on their own, so it runs beside the
        # daemon rather than in front of it.
        agent_env = AgentEnvironmentSupervisor(
            invocations.prepare,
            invocations.environment_status,
        )
        gateway = GatewayMeta(
            bind_host=bind_host,
            bind_port=bind_port,
            version=__version__,
            started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            started_at_monotonic=time.monotonic(),
            ws_path=DEFAULT_WS_PATH,
        )

        self.state = ServiceState(
            auth=TokenAuth(token=TokenAuth.generate()),
            clients=ClientRegistry(),
            llms=llms,
            invocations=invocations,
            session_events=session_events,
            system_events=system_events,
            sessions=sessions,
            browser_host=browser_host,
            powerpoint_host=powerpoint_host,
            gateway=gateway,
            scheduler=scheduler,
            agent_env=agent_env,
        )

        # Grace window between broadcasting SystemShutdownEvent and tearing down the rest of the service.
        self._shutdown_grace_seconds: float = 0.5

        # Build the FastAPI app.
        self.app = self._build()
        self.app.state.clients = self.state.clients
        self.app.state.auth = self.state.auth
        self.app.state.request_shutdown = self.request_shutdown

    ############################################################################
    # FastAPI build
    ############################################################################
    def _build(self) -> FastAPI:
        app = FastAPI(
            title=f"{AGENT_NAME} Gateway",
            version=__version__,
            description=(f"Service gateway for {AGENT_NAME}."),
            lifespan=self._lifespan,
        )

        # Reject requests whose Host header isn't a loopback name. This is the
        # DNS-rebinding guard: an attacker domain that resolves to 127.0.0.1
        # makes the browser treat this daemon as same-origin, which defeats
        # CORS entirely — but the Host header still carries the attacker's
        # domain, so checking it closes that path. The middleware strips the
        # port before comparing, so the configurable bind port needs no entry.
        app.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=["127.0.0.1", "localhost"],
        )

        # CORS. Narrowed from `allow_origins=["*"]`, which let any web page
        # read our responses. The allowed set is what the desktop client
        # actually presents:
        #   * packaged app  — renderer is loaded with `loadFile()`, i.e.
        #     `file://`, and Chromium sends `Origin: null`
        #   * dev           — Vite on `http://localhost:<port>`, where the
        #     port is configurable (APP_VITE_PORT), hence the regex
        # A literal allow-list of ports would break the moment a developer
        # moves the dev server, so match the host and leave the port open.
        #
        # Note this is defense in depth, not the boundary: the boundary is the
        # bearer token on every route (see `_build_router`). `Origin: null` is
        # forgeable from a sandboxed iframe, so CORS alone would not stop the
        # attack it used to be the only thing standing against.
        app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=r"^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
            allow_methods=["*"],
            allow_headers=["*"],
            allow_credentials=False,
        )
        # X-Client-Id parse + auto-register. Starlette runs middlewares
        # in reverse-registration order; this still fires before route
        # dispatch.
        app.add_middleware(ClientIdMiddleware)

        # Route bindings. The public router is registered first so its
        # unauthenticated routes match before the authenticated ones.
        app.include_router(self._build_public_router())
        app.include_router(self._build_router())

        return app

    @asynccontextmanager
    async def _lifespan(self, _app: FastAPI):
        try:
            # Startup step 1 — Agent resources prepare beside startup, never in
            # front of it. Nothing below needs them, and a transient
            # filesystem failure here used to reach uvicorn as "Application
            # startup failed. Exiting.": the daemon died with nothing left to
            # retry it, so the app never opened again on its own.
            self.state.agent_env.start()

            # Startup step 2 — DB ready before any handler can run.
            await Repository.init_schema()
            await seed_local_user()

            # Startup step 3 — pre-warm the LLM client for the current user
            user = await get_current_user()
            from ..amphi_agent._skills import SkillLibrary

            await SkillLibrary(user.id).sync_builtins()
            if user.api_key:
                try:
                    await self.state.llms.resolve(user, user.current_model)
                except Exception as exc:  # noqa: BLE001 — best-effort pre-warm
                    logger.warning("[lifespan] LLM pre-warm skipped: %s", exc)

            await self.state.invocations.recover()
            await self.state.scheduler.start()

            yield
        finally:
            # NOTE: the ``system.shutdown`` broadcast does NOT happen
            # here — it would run AFTER uvicorn has already closed every
            # WS connection (uvicorn order: ``connection.shutdown()`` →
            # await drain → ``lifespan.shutdown()``). The broadcast is
            # in :meth:`pre_shutdown_hook` instead, wired into
            # :class:`GracefulServer` so it fires while WS connections
            # are still fully open.
            #
            # The environment task can be parked on a retry backoff or inside
            # a worker thread, so it is cancelled first and awaited: a task
            # left running here outlives the loop it was scheduled on.
            try:
                await self.state.agent_env.stop()
            finally:
                try:
                    await self.state.scheduler.stop()
                finally:
                    try:
                        await self.state.invocations.shutdown()
                    finally:
                        try:
                            await self.state.browser_host.shutdown()
                        finally:
                            try:
                                await self.state.powerpoint_host.shutdown()
                            finally:
                                await Repository.close()

    @staticmethod
    def _load_environment() -> None:
        """Load the nearest ``.env`` without overriding the process environment."""
        try:
            from dotenv import load_dotenv
        except ImportError:
            return

        env_path = Path(".env")
        if not env_path.exists():
            current = Path.cwd()
            home = Path.home()
            while current != home and current != current.parent:
                candidate = current / ".env"
                if candidate.exists():
                    env_path = candidate
                    break
                current = current.parent
        load_dotenv(env_path, override=False)

    async def pre_shutdown_hook(self) -> None:
        """Broadcast ``system.shutdown`` to live WS subscribers.

        Called by :class:`GracefulServer` BEFORE uvicorn closes any
        connection — i.e. while ``system``-topic relay tasks can still
        ``send_json`` the frame across the wire. After the publish, the
        method sleeps :attr:`_shutdown_grace_seconds` so relay tasks
        get cooperative-scheduling time to drain their queues before
        uvicorn proceeds.

        Best-effort throughout: a failed publish must not stop daemon
        shutdown, so exceptions are logged + swallowed.
        """
        grace = self._shutdown_grace_seconds
        try:
            await self.state.system_events.publish(
                SystemShutdownEvent(
                    reason="server shutting down",
                    grace_seconds=grace,
                ),
            )
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.warning("[ServiceApp] system.shutdown broadcast failed: %s", exc)
        if grace > 0:
            await asyncio.sleep(grace)

    def bind_shutdown(self, callback: Callable[[], None]) -> None:
        """Bind the foreground server's cooperative shutdown request."""
        self._shutdown_callback = callback

    def request_shutdown(self) -> None:
        """Request cooperative shutdown, with a standalone-process fallback."""
        if self._shutdown_callback is not None:
            self._shutdown_callback()
            return
        os.kill(os.getpid(), signal.SIGTERM)

    def _build_public_router(self) -> APIRouter:
        """Bind the routes that must stay reachable without a bearer token.

        Deliberately tiny. Everything not listed here is authenticated by
        :meth:`_build_router`; adding a route to this router removes the
        only thing standing between it and any web page the user visits
        (the daemon listens on a fixed loopback port, which browsers can
        reach — see SECURITY.md).

        ``/api/gateway/health`` is the liveness probe used by supervisors
        and by clients that have not yet read ``runtime.json``, so it
        cannot itself require the token from that file.

        ``/ws`` is unauthenticated **at the transport layer only**. It
        authenticates in the application layer instead: ``WsHandler.endpoint``
        requires the first frame to be ``hello`` carrying a valid token and
        closes with ``_WS_CLOSE_AUTH_FAIL`` otherwise, before any subscribe
        or chat frame is dispatched. That split is forced by the browser
        WebSocket API, which cannot set an ``Authorization`` header on the
        handshake — a router-level bearer dependency here would lock the GUI
        out of chat entirely, with no client-side workaround.
        """
        r = APIRouter()
        GatewayHealthHandler.bind(r, "/api/gateway/health", self.state)
        ChatHandler.bind(r, "/ws", self.state)
        return r

    def _build_router(self) -> APIRouter:
        """Bind every URL to its handler class.

        Order matters: FastAPI matches routes in registration order, so
        any static path that could be eaten by a parameterised sibling
        must be registered first.

        Every route here requires a valid bearer token: the dependency is
        attached to the router itself rather than to individual routes, so
        a newly bound handler is authenticated by default. Opting out is a
        deliberate act — move the route to :meth:`_build_public_router`.
        This replaced a per-route ``dependencies=`` list that covered 5 of
        54 routes and left the rest, including the execution-mode switch,
        open to any origin.
        """
        r = APIRouter(dependencies=[Depends(require_bearer_token)])
        state = self.state

        # User API
        MeProfileHandler.bind(r, "/me", state)
        MeCredentialsHandler.bind(r, "/me/credentials", state)
        MeModelHandler.bind(r, "/me/model", state)
        MeExecutionModeHandler.bind(r, "/me/execution-mode", state)
        MeMemoryListHandler.bind(r, "/me/memories", state)
        MeMemoryItemHandler.bind(r, "/me/memories/{memory_id}", state)
        ProvidersCatalogHandler.bind(r, "/providers", state)
        MeProvidersHandler.bind(r, "/me/providers", state)
        MeActiveModelHandler.bind(r, "/me/active-model", state)
        # Phase 2.5 connectivity probe — must be bound before the catch-all
        # `/me/providers/{provider_id}` route, otherwise FastAPI matches
        # "test" as the path param. Same constraint for "fetch-models".
        MeProviderTestHandler.bind(r, "/me/providers/test", state)
        MeProviderFetchModelsHandler.bind(r, "/me/providers/fetch-models", state)
        MeProviderToggleHandler.bind(r, "/me/providers/{provider_id}/toggle", state)
        MeProviderApiKeyHandler.bind(r, "/me/providers/{provider_id}/api-key", state)
        MeProviderCodexLocalHandler.bind(r, "/me/providers/{provider_id}/codex/local", state)
        MeProviderOAuthHandler.bind(r, "/me/providers/{provider_id}/oauth/start", state)
        MeProviderOAuthStatusHandler.bind(r, "/me/providers/{provider_id}/oauth/status", state)
        MeProviderOAuthCancelHandler.bind(r, "/me/providers/{provider_id}/oauth/cancel", state)
        MeProviderItemHandler.bind(r, "/me/providers/{provider_id}", state)
        # Session API
        SessionListHandler.bind(r, "/sessions", state)
        SessionDuplicateHandler.bind(r, "/sessions/{session_id}/duplicate", state)
        SessionDetailHandler.bind(r, "/sessions/{session_id}", state)
        SessionMessagesHandler.bind(r, "/sessions/{session_id}/messages", state)
        SessionFileHandler.bind(r, "/sessions/{session_id}/files", state)
        ResetHandler.bind(r, "/sessions/{session_id}/reset", state)
        TokensHandler.bind(r, "/sessions/{session_id}/tokens", state)
        SessionMountUploadHandler.bind(r, "/sessions/{session_id}/mounts/upload", state)
        SessionMountsHandler.bind(r, "/sessions/{session_id}/mounts", state)
        StopHandler.bind(r, "/sessions/{session_id}/stop", state)
        ReadHandler.bind(r, "/sessions/{session_id}/read", state)
        InteractionHandledHandler.bind(r, "/sessions/{session_id}/answered", state)

        # Gateway API. `/api/gateway/health` is bound on the public router;
        # the per-route `dependencies=bearer` these used to carry is now
        # redundant with the router-level dependency and was removed so the
        # list does not read as "only these are protected".
        GatewayInfoHandler.bind(r, "/api/gateway/info", state)
        GatewayClientsHandler.bind(r, "/api/gateway/clients", state)
        GatewayShutdownHandler.bind(r, "/api/gateway/shutdown", state)
        BrowserControllerHandler.bind(r, "/api/browser/controller", state)
        AgentStatusHandler.bind(r, "/api/agent/status", state)
        AgentRunHandler.bind(r, "/api/agent/sessions/{session_id}/run", state)
        SubAgentRunHandler.bind(r, "/api/agent/sessions/{session_id}/subagents", state)
        SessionMountListHandler.bind(r, "/mounts", state)

        # Skills API
        SkillsImportScanHandler.bind(r, "/skills/import/scan", state)
        SkillsImportCheckHandler.bind(r, "/skills/import/check", state)
        SkillsImportExecuteHandler.bind(r, "/skills/import", state)
        SkillsHandler.bind(r, "/skills", state)
        # Static "toggle" sub-path must precede the parameterised /skill/{skill_id}.
        SkillToggleHandler.bind(r, "/skill/{skill_id}/toggle", state)
        SkillItemHandler.bind(r, "/skill/{skill_id}", state)

        # Workflows API
        WorkflowsHandler.bind(r, "/workflows", state)
        WorkflowRunsHandler.bind(r, "/workflow-runs", state)
        WorkflowRunFileHandler.bind(r, "/workflow-runs/{run_id}/file", state)
        WorkflowRunItemHandler.bind(r, "/workflow-runs/{run_id}", state)
        WorkflowItemHandler.bind(r, "/workflows/{workflow_id}", state)

        # Schedules API — static sub-paths before the parameterised item route.
        SchedulesHandler.bind(r, "/schedules", state)
        ScheduleRunNowHandler.bind(r, "/schedules/{schedule_id}/run-now", state)
        ScheduleKillHandler.bind(r, "/schedules/{schedule_id}/kill", state)
        ScheduleItemHandler.bind(r, "/schedules/{schedule_id}", state)

        # Chat API (WebSocket) is bound on the public router — it authenticates
        # in its own `hello` handshake. See _build_public_router.

        return r


__all__ = ["ServiceApp", "HEADER_CLIENT_ID", "HEADER_CLIENT_TYPE"]
