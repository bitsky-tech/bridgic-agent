import asyncio
import secrets
from dataclasses import dataclass
from typing import Any, ClassVar, Dict, List, Optional, Tuple

from fastapi import (
    APIRouter,
    HTTPException,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..auth import TokenAuth, get_current_user
from ..i18n import DEFAULT_LOCALE, Locale, locale_from_accept_language
from ..protocol import WsHelloMessage, WsMessageError, parse_client_message
from ..server import GatewayMeta
from ..runtime import (
    AgentEnvironmentSupervisor,
    SchedulerService,
    SessionEventBroker,
    SessionService,
    SystemEventBroker,
)
from ...amphi_agent import AgentInvocation, BrowserHost, PowerPointHost
from ..cache import ClientRegistry, LlmCache
from ...amphi_store import (
    SessionRecord,
    SessionRepository,
    User,
)

################################################################################################################
# ServiceState — the state every request
################################################################################################################

@dataclass(frozen=True)
class ServiceState:
    """The service dependencies one request needs, grouped by lifecycle.

    Constructed once by :class:`ServiceApp`, passed to every handler's
    :meth:`BaseHandler.bind`. Immutable container (the referenced objects are
    not). Durable DB access is **not** a slot — the connection lives on the
    :class:`Repository` base (class-level, built at startup via
    :meth:`Repository.connect`).

    * :attr:`llms` / :attr:`invocations` / :attr:`sessions` /
      :attr:`session_events` / :attr:`system_events` — in-process runtime state:
      model cache, Agent lifecycle, Session lifecycle, and event projection.
    * :attr:`auth` — bearer-token holder for ``/api/*`` (:class:`TokenAuth`),
      fresh per startup, mirrored into ``runtime.json`` for local clients.
    * :attr:`clients` — ``X-Client-Id`` tracking (:class:`ClientRegistry`).
    * :attr:`gateway` — startup-constant snapshot (:class:`GatewayMeta`).
    * :attr:`agent_env` — readiness of the Agent command environment, which
      the daemon prepares in the background rather than during startup.

    Handlers reach each via the :class:`BaseHandler` properties and resolve the
    current user through :meth:`BaseHandler.require_user` (never caching a User
    on ``self`` — an HTTP handler instance is shared across every request).
    """

    llms: LlmCache
    invocations: AgentInvocation
    session_events: SessionEventBroker
    system_events: SystemEventBroker
    sessions: SessionService
    browser_host: BrowserHost
    powerpoint_host: PowerPointHost
    auth: TokenAuth
    clients: ClientRegistry
    gateway: GatewayMeta
    scheduler: SchedulerService
    agent_env: AgentEnvironmentSupervisor


################################################################################################################
# BaseHandler — the class-based view base for one URL pattern
################################################################################################################

class BaseHandler:
    """Class-based view base for one URL pattern."""

    # Optional API methods.
    _HTTP_VERBS: ClassVar[Tuple[Tuple[str, str], ...]] = (
        ("get", "GET"),
        ("post", "POST"),
        ("put", "PUT"),
        ("delete", "DELETE"),
        ("patch", "PATCH"),
    )

    # Optional OpenAPI tags.
    tags: ClassVar[Optional[List[str]]] = None

    def __init__(self, state: ServiceState) -> None:
        self.state = state

    @property
    def llms(self) -> LlmCache:
        return self.state.llms

    @property
    def invocations(self) -> AgentInvocation:
        return self.state.invocations

    @property
    def session_events(self) -> SessionEventBroker:
        return self.state.session_events

    @property
    def system_events(self) -> SystemEventBroker:
        return self.state.system_events

    @property
    def sessions(self) -> SessionService:
        return self.state.sessions

    @property
    def auth(self) -> TokenAuth:
        return self.state.auth

    @property
    def clients(self) -> ClientRegistry:
        return self.state.clients

    @property
    def gateway(self) -> GatewayMeta:
        return self.state.gateway

    @property
    def agent_env(self) -> AgentEnvironmentSupervisor:
        return self.state.agent_env

    ############################################################################
    # Core Methods
    ############################################################################
    def response(self, data: Any = None, *, status_code: int = 200) -> Response:
        """Wrap a handler return into the unified Response form.

        Currently a transparent passthrough that preserves the wire protocol's
        existing shape:

        - ``None`` -> empty body at ``status_code`` (typically 204).
        - ``BaseModel`` -> its ``model_dump(mode="json")``.
        - ``list`` -> elementwise (BaseModel items dumped, others as-is).
        - anything else -> serialised directly as JSON.

        Future envelope changes (e.g. ``{ok, data, error}``) land here
        and propagate automatically to every handler.
        """
        if data is None:
            return Response(status_code=status_code)
        if isinstance(data, BaseModel):
            content: Any = data.model_dump(mode="json")
        elif isinstance(data, list):
            content = [
                item.model_dump(mode="json") if isinstance(item, BaseModel) else item
                for item in data
            ]
        else:
            content = data
        return JSONResponse(content=content, status_code=status_code)
    
    @classmethod
    def bind(
        cls,
        router: APIRouter,
        path: str,
        state: ServiceState,
        **route_kwargs: Any,
    ) -> None:
        """Register every HTTP-verb method this class defines on ``path``.

        This is the **default (HTTP) registration**. ``bind`` is the
        single registration entry point for every endpoint; subclasses
        whose transport isn't HTTP-verb-dispatched override it (e.g.
        :class:`WsHandler` registers a WebSocket route instead). The
        caller in ``_app.py`` reaches every endpoint the same way —
        ``Handler.bind(router, path, state)`` — regardless of transport.

        Builds **one** instance per registration (so all verbs on the
        same URL share state and any subclass-level setup) and binds
        each method as a FastAPI route. The bound method has no
        ``self`` in its visible signature, so FastAPI's path/body
        parameter inference works unchanged.

        Extra ``route_kwargs`` are forwarded verbatim to
        :meth:`fastapi.APIRouter.add_api_route` — used by the gateway
        handlers to attach ``dependencies=[Depends(require_bearer_token)]``
        without breaking out of the ``bind`` flow.
        """
        instance = cls(state)
        kwargs: Dict[str, Any] = dict(route_kwargs)
        if cls.tags is not None:
            kwargs.setdefault("tags", list(cls.tags))
        for attr, http_method in cls._HTTP_VERBS:
            method = getattr(instance, attr, None)
            if callable(method):
                router.add_api_route(
                    path, method, methods=[http_method], **kwargs,
                )

    ############################################################################
    # Helper methods
    ############################################################################
    async def require_user(self) -> User:
        """Return the `User` row for the current request.

        Resolves to the single local user, by design rather than by omission:
        the gateway is a local, single-user service (see SECURITY.md), so there
        is exactly one identity to return and no request-scoped credential to
        parse. Authentication of the *caller* is a separate concern and already
        happens at the edge — product REST routes require the daemon's bearer
        token (health and the local OpenAPI docs are deliberately open), and
        WebSocket clients authenticate in their first `hello` frame.

        Every handler needing user scope goes through here, which is what makes
        this the one place to change if the service ever grows real multi-user
        identity. Nothing else reaches for the current user directly.
        """
        return await get_current_user()
    
    def require_ai(self, user: User) -> None:
        """Raise 503 when this user has no AI provider key configured.

        AI provider credentials are **per-user** (stored on the User
        row); call this before any work that resolves an LLM client.
        Non-AI surfaces (``/me/*``, ``/sessions`` CRUD,
        ``/api/gateway/*``) skip this check by design.
        """
        # Codex (protocol='openai-codex') keeps its credentials in ~/.codex,
        # not on the User row — api_key is legitimately None. Treat it as
        # configured; build_llm re-resolves the actual Codex tokens.
        if not user.api_key and user.protocol != "openai-codex":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    f"No AI provider key configured for user {user.id!r}. "
                    "Configure and activate a provider in the product."
                ),
            )

    async def require_session(self, session_id: str, user: User) -> SessionRecord:
        """Load a session row, ownership-gated (404 hides other users' ids)."""
        record = await SessionRepository().load(session_id, user.id)
        if record is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=(
                    f"Session {session_id!r} is not registered. "
                    "Create one with POST /sessions."
                ),
            )
        return record

    def require_no_running_turn(self, session_id: str) -> None:
        """Raise 409 when a turn is in flight for ``session_id``.

        Guards mutators that would race the agent's in-flight writes to
        the same live :class:`Session` aggregate (``reset`` / ``compact``).
        Read-only commands (``diff`` / ``tokens``) skip this — they
        tolerate a concurrent turn. This is a lock-free probe; the
        authoritative serial gate lives in :class:`AgentInvocation`.
        """
        if self.invocations.is_running(session_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"A turn is currently running for session {session_id!r}; "
                    "retry after it completes."
                ),
            )


################################################################################################################
# WsHandler — the WebSocket transport base (technical, not business)
################################################################################################################

# WebSocket close codes used by the WS transport. Standard close codes
# 1000-2999 are reserved by the WS RFC; 4000-4999 is the "application
# private" range. We pick 4401 (Bearer-style 401) for auth-fail.
_WS_CLOSE_AUTH_FAIL = 4401
_WS_CLOSE_PROTOCOL = 1002  # standard "protocol error" code


class WsHandler(BaseHandler):
    """Transport base for a WebSocket endpoint — *technical*, not business.

    Sibling to the HTTP-verb dispatch the default :meth:`BaseHandler.bind`
    provides: where that registers HTTP-verb routes, this base registers
    one WebSocket route and runs the per-connection lifecycle. It owns
    three transport concerns and nothing domain-specific:

    * **registration** — :meth:`bind` via ``add_api_websocket_route``
      (overrides the verb-dispatch default);
    * **connection lifecycle** — :meth:`endpoint`: accept, the ``hello``
      + bearer-token handshake, the one-message-at-a-time receive loop, and
      relay-task cancellation on disconnect;
    * **event relays** — :meth:`_relay_session` / :meth:`_relay_system`: pump a
      Session topic or the process-wide
      :class:`SystemEventBroker` onto the socket — the WS analogue of
      :meth:`BaseHandler.response` ("what goes on the wire"). *Which* topic
      maps to which relay is the business subclass's concern.

    What message *types* the endpoint speaks, and what they do, is the
    business subclass's concern: :meth:`_dispatch` is an abstract hook a
    subclass (e.g. ``ChatHandler``) overrides to parse + route inbound
    messages.

    One handler instance is built **per connection** (see :meth:`bind`), so the
    per-connection state lives on ``self`` without two concurrent connections
    clobbering each other: the live socket (:attr:`websocket`) and the relay
    registry (:attr:`relay_tasks`). Only ``client_id`` stays a :meth:`endpoint`
    local.
    """

    def __init__(self, state: ServiceState) -> None:
        super().__init__(state)
        self.websocket: Optional[WebSocket] = None
        self.relay_tasks: Dict[str, "asyncio.Task[None]"] = {}
        self.locale: Locale = DEFAULT_LOCALE
        # Set from the hello frame; tags this connection's system-bus
        # subscription so publish_counting() can tell gui from cli.
        self.client_type: str = "unknown"

    ############################################################################
    # Core Methods
    ############################################################################
    @classmethod
    def bind(cls, router: APIRouter, path: str, state: ServiceState, **route_kwargs: Any) -> None:
        """Register a single WebSocket endpoint on ``path``.

        Overrides the HTTP verb-dispatch :meth:`BaseHandler.bind`: a
        WebSocket route is registered through
        :meth:`fastapi.APIRouter.add_api_websocket_route`, not as a set
        of HTTP-verb routes.

        Unlike the HTTP base (one instance shared across all requests),
        this builds a **fresh instance per connection**: the route holds a
        thin ``_endpoint`` closure that does ``cls(state).endpoint(ws)`` on
        each accept. That per-connection isolation is what lets a connection
        stash its live socket on ``self`` (:attr:`websocket`) — a single
        shared instance would let concurrent sockets overwrite each other's.
        """
        async def _endpoint(websocket: WebSocket) -> None:
            await cls(state).endpoint(websocket)

        router.add_api_websocket_route(path, _endpoint, **route_kwargs)

    async def endpoint(self, websocket: WebSocket) -> None:
        """Accept + auth + dispatch loop + cleanup. ASGI-compliant.

        The receive loop hands each inbound message to :meth:`_dispatch`,
        which the business subclass implements; this method stays
        domain-agnostic.
        """
        self.websocket = websocket
        # Only a starting point: a GUI cannot set this header (the browser WebSocket API
        # forbids it), so its handshake carries whatever Chromium derived from the OS
        # language. The hello frame below overrides it with the language the user actually
        # picked; clients that *can* set headers (CLI / tray) keep working unchanged.
        self.locale = locale_from_accept_language(websocket.headers.get("Accept-Language"))
        await self.websocket.accept()

        # Bind up-front: the ``finally`` cleanup reads ``client_id``, but every
        # early handshake return below (disconnect / bad frame / non-hello /
        # auth fail) happens BEFORE the ``client_id = msg.client_id`` assignment.
        # Without this, those paths raise ``UnboundLocalError`` in ``finally`` —
        # a benign early disconnect turns into a logged 500 traceback.
        client_id: Optional[str] = None

        try:
            # Step 1: handshake — first message MUST be ``hello`` w/ valid token
            try:
                raw = await self.websocket.receive_json()
            except WebSocketDisconnect:
                return
            try:
                msg = parse_client_message(raw)
            except WsMessageError as exc:
                await self.websocket.close(code=_WS_CLOSE_PROTOCOL, reason=str(exc)[:120])
                return
            
            if not isinstance(msg, WsHelloMessage):
                await self.websocket.close(code=_WS_CLOSE_AUTH_FAIL, reason="First message must be 'hello'.")
                return
            if not self._token_matches(self.auth, msg.token):
                await self.websocket.close(code=_WS_CLOSE_AUTH_FAIL, reason="Invalid bearer token.")
                return
            
            if msg.locale:
                self.locale = locale_from_accept_language(msg.locale)

            client_id = msg.client_id
            self.client_type = msg.client_type
            if client_id is not None:
                await self.clients.touch(
                    client_id=client_id,
                    client_type=msg.client_type,
                    user_agent=None,
                )
            await self.websocket.send_json({"type": "ready"})

            # Step 2: dispatch loop — one message at a time per connection
            while True:
                try:
                    raw = await self.websocket.receive_json()
                except WebSocketDisconnect:
                    return
                await self._dispatch(raw)
        finally:
            # Cancel every relay task this connection started. We don't await
            # them (would block disconnect on slow tasks); a fire-and-forget
            # cancel is enough — the relay loops check for cancellation at
            # every ``await``.
            for t in self.relay_tasks.values():
                if not t.done():
                    t.cancel()
            if client_id is not None:
                # Best-effort: remove the client from the registry.
                # If the same client_id reconnects later, ``touch`` adds
                # it back; this just avoids stale "online" entries.
                try:
                    await self.clients.unregister(client_id)
                except Exception:  # noqa: BLE001
                    pass

    async def _dispatch(self, message: Dict[str, Any]) -> None:
        """Route one inbound message — implemented by the business subclass.

        :meth:`endpoint` owns the connection (accept + auth + receive
        loop + cleanup) and the relay mechanism; *which* messages this WS
        speaks and what they do is the subclass's concern. A subclass
        (e.g. ``ChatHandler``) overrides this to parse ``message`` and route
        to its own handlers.
        """
        raise NotImplementedError

    ############################################################################
    # Helper methods
    ############################################################################
    async def _relay_session(self, session_id: str) -> None:
        """Forward one Session topic to this socket across Agent attempts."""
        try:
            async for event in self.session_events.subscribe(session_id):
                await self.websocket.send_json({
                    "type": event.name,
                    "session_id": session_id,
                    **event.payload(),
                })
        except (asyncio.CancelledError, WebSocketDisconnect):
            return
        except Exception as exc:
            try:
                await self.websocket.send_json({
                    "type": "cmd_error",
                    "for": "relay",
                    "session_id": session_id,
                    "message": f"{type(exc).__name__}: {exc}",
                })
            except Exception:
                pass

    async def _relay_system(self) -> None:
        """Forward every :class:`SystemEvent` to the WebSocket.

        The system bus never terminates — it stays open for the daemon's
        lifetime — so this iterator only exits via cancel / disconnect.
        System frames carry no ``session_id`` field; clients route on
        ``type`` (e.g. ``"system.shutdown"``) alone.
        """
        try:
            async for event in self.system_events.subscribe(tag=self.client_type):
                await self.websocket.send_json({
                    "type": event.name,
                    **event.payload(),
                })
        except (asyncio.CancelledError, WebSocketDisconnect):
            return
        except Exception as exc:
            try:
                await self.websocket.send_json({
                    "type": "cmd_error",
                    "for": "relay",
                    "message": f"{type(exc).__name__}: {exc}",
                })
            except Exception:
                pass

    @staticmethod
    def _token_matches(auth: TokenAuth, presented: str) -> bool:
        """Constant-time-equivalent token compare (length-aware)."""
        expected = auth.current_token
        if expected is None or not presented:
            return False
        return secrets.compare_digest(presented, expected)


__all__ = ["BaseHandler", "ServiceState", "WsHandler"]
