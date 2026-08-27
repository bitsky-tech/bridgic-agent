from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

from playwright.async_api import Browser as PlaywrightBrowser
from playwright.async_api import BrowserContext, Page, Playwright, async_playwright

from .runtime._environment import bundled_node_runtime

logger = logging.getLogger(__name__)

_CONTROLLER_TIMEOUT_SECONDS = 3.0
_ATTACH_TIMEOUT_SECONDS = 15.0
_BRIDGE_TIMEOUT_MS = 10_000


class PowerPointUnavailableError(RuntimeError):
    """Raised when the desktop App cannot provide a PowerPoint renderer."""


class PowerPointOperationError(ValueError):
    """Raised when the renderer rejects a structured PowerPoint operation."""


def _powerpoint_unavailable(cause: Optional[BaseException] = None) -> PowerPointUnavailableError:
    error = PowerPointUnavailableError(
        "PowerPoint is unavailable because the desktop app is not running or its "
        "PowerPoint connection was interrupted. Open the desktop app and retry."
    )
    if cause is not None:
        error.__cause__ = cause
    return error


@dataclass(frozen=True)
class _PowerPointSurface:
    session_id: str
    target_id: Optional[str]


@dataclass(frozen=True)
class _PowerPointController:
    """Authenticated Electron controller shared with the embedded browser."""

    controller_id: str
    generation: str
    control_url: str
    control_token: str
    cdp_endpoint: str
    owner_pid: int

    async def health(self) -> None:
        await asyncio.to_thread(self._request, "GET", "/v1/health", None)

    async def ensure_session(self, session_id: str) -> _PowerPointSurface:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/powerpoint/sessions/ensure",
            {"session_id": session_id},
        )
        return self._surface(response, session_id)

    async def get_session(self, session_id: str) -> _PowerPointSurface:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/powerpoint/sessions/get",
            {"session_id": session_id},
        )
        return self._surface(response, session_id)

    async def release_session(self, session_id: str) -> None:
        await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/powerpoint/sessions/release",
            {"session_id": session_id},
        )

    def public_status(self) -> dict[str, Any]:
        return {
            "available": True,
            "controller_id": self.controller_id,
            "generation": self.generation,
            "owner_pid": self.owner_pid,
        }

    @staticmethod
    def _surface(response: dict[str, Any], expected_session_id: str) -> _PowerPointSurface:
        if response.get("session_id") != expected_session_id:
            raise RuntimeError("Electron PowerPoint controller returned the wrong Session")
        target_id = response.get("target_id")
        if target_id is not None and (not isinstance(target_id, str) or not target_id):
            raise RuntimeError("Electron PowerPoint controller returned an invalid target")
        return _PowerPointSurface(session_id=expected_session_id, target_id=target_id)

    def _request(self, method: str, path: str, body: Optional[dict[str, Any]]) -> dict[str, Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.control_url.rstrip('/')}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.control_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=_CONTROLLER_TIMEOUT_SECONDS) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 401 or exc.code >= 500:
                raise _powerpoint_unavailable(exc)
            try:
                parsed_error = json.loads(exc.read().decode("utf-8"))
                detail = parsed_error.get("error") if isinstance(parsed_error, dict) else None
            except (OSError, UnicodeError, json.JSONDecodeError):
                detail = None
            suffix = f": {detail.strip()}" if isinstance(detail, str) and detail.strip() else ""
            raise RuntimeError(
                f"Electron PowerPoint controller rejected the request (HTTP {exc.code}){suffix}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise _powerpoint_unavailable(exc)
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("Electron PowerPoint controller returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("Electron PowerPoint controller returned an invalid response")
        return parsed


class _SessionPowerPointClient:
    """One Playwright connection bound to one Electron-owned PPT target."""

    def __init__(self, cdp_endpoint: str) -> None:
        self._cdp_endpoint = cdp_endpoint
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[PlaywrightBrowser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None

    def is_live(self) -> bool:
        return self._browser is not None and self._browser.is_connected() and self._page is not None and not self._page.is_closed()

    async def connect(self, target_id: str, session_id: str) -> None:
        if self._playwright is not None:
            raise RuntimeError("The PowerPoint client is already connected")
        try:
            async with asyncio.timeout(_ATTACH_TIMEOUT_SECONDS):
                self._playwright = await async_playwright().start()
                self._browser = await self._playwright.chromium.connect_over_cdp(self._cdp_endpoint)
                self._context, self._page = await self._wait_for_target(target_id)
                await self._page.wait_for_function(
                    "expected => window.__bridgicPowerPoint?.protocolVersion === 1 "
                    "&& window.__bridgicPowerPoint?.sessionId === expected",
                    arg=session_id,
                    timeout=_BRIDGE_TIMEOUT_MS,
                )
        except BaseException:
            await self.disconnect()
            raise

    async def dispatch(self, request: dict[str, Any]) -> Any:
        page = self._page
        if page is None or page.is_closed():
            raise RuntimeError("The PowerPoint target is closed")
        response = await page.evaluate(
            "request => window.__bridgicPowerPoint.dispatch(request)",
            request,
        )
        if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
            raise RuntimeError("The PowerPoint renderer returned an invalid response")
        if response["ok"]:
            return response.get("value")
        message = response.get("error")
        raise PowerPointOperationError(
            message if isinstance(message, str) and message else "PowerPoint operation rejected"
        )

    async def disconnect(self) -> None:
        browser = self._browser
        playwright = self._playwright
        self._page = None
        self._context = None
        self._browser = None
        self._playwright = None
        if browser is not None:
            with suppress(Exception):
                await browser.close()
        if playwright is not None:
            with suppress(Exception):
                await playwright.stop()

    async def _wait_for_target(self, target_id: str) -> tuple[BrowserContext, Page]:
        browser = self._browser
        if browser is None:
            raise RuntimeError("The PowerPoint CDP connection is not active")
        deadline = time.monotonic() + _ATTACH_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            for context in browser.contexts:
                for page in context.pages:
                    if not page.is_closed() and await self._target_id(context, page) == target_id:
                        return context, page
            await asyncio.sleep(0.02)
        raise TimeoutError(f"Electron PowerPoint target {target_id!r} did not attach")

    @staticmethod
    async def _target_id(context: BrowserContext, page: Page) -> str:
        session = await context.new_cdp_session(page)
        try:
            result = await session.send("Target.getTargetInfo")
            return str(result["targetInfo"]["targetId"])
        finally:
            with suppress(Exception):
                await session.detach()


class SessionPowerPoint:
    """Stable, lazy PowerPoint handle for one exact Agent Session."""

    def __init__(self, host: "PowerPointHost", session_id: str) -> None:
        self._host = host
        self.session_id = session_id
        self._operation_lock = asyncio.Lock()
        self._client: Optional[_SessionPowerPointClient] = None
        self._owner_generation: Optional[int] = None
        self._controller: Optional[_PowerPointController] = None

    async def list_presentations(self) -> Any:
        return await self._invoke({"method": "list"})

    async def snapshot(self, document_id: Optional[str] = None) -> Any:
        params = {"document_id": document_id} if document_id else None
        return await self._invoke({"method": "snapshot", "params": params})

    async def apply(self, operations: list[dict[str, Any]]) -> Any:
        if not operations:
            raise ValueError("operations must not be empty")
        return await self._invoke({"method": "apply", "params": {"operations": operations}})

    async def add_animation(
        self,
        element_id: str,
        effect: str,
        *,
        slide_id: Optional[str] = None,
        start: str = "onClick",
        duration: float = 0.5,
        delay: float = 0.0,
    ) -> Any:
        operation: dict[str, Any] = {
            "type": "add_animation",
            "element_id": element_id,
            "effect": effect,
            "start": start,
            "duration": duration,
            "delay": delay,
        }
        if slide_id:
            operation["slide_id"] = slide_id
        return await self.apply([operation])

    async def close(self) -> bool:
        return await self._host._release_handle(self, discard=False)

    async def _invoke(self, request: dict[str, Any]) -> Any:
        async with self._operation_lock:
            for attempt in range(2):
                client = await self._host._client_for(self)
                try:
                    return await client.dispatch(request)
                except PowerPointOperationError:
                    raise
                except Exception:
                    if attempt > 0:
                        raise
                    await self._host._discard_client(self, client)
            raise RuntimeError("PowerPoint request failed")


class PowerPointHost:
    """Connect Agent Sessions to Electron-owned PowerPoint renderers."""

    def __init__(self, *, prepare_playwright: Optional[Callable[[], None]] = None, session_factory: Callable[[str], _SessionPowerPointClient] = _SessionPowerPointClient) -> None:
        self._prepare_playwright = prepare_playwright or bundled_node_runtime.apply_playwright_env
        self._session_factory = session_factory
        self._lock = asyncio.Lock()
        self._connection_lock = asyncio.Lock()
        self._sessions: dict[str, SessionPowerPoint] = {}
        self._controller: Optional[_PowerPointController] = None
        self._connected_generation: Optional[str] = None
        self._owner_generation = 0
        self._shutdown = False

    def for_session(self, session_id: str) -> SessionPowerPoint:
        key = str(session_id or "").strip()
        if not key:
            raise ValueError("session_id is required to open PowerPoint")
        if self._shutdown:
            raise RuntimeError("The PowerPoint service has shut down")
        handle = self._sessions.get(key)
        if handle is None:
            handle = SessionPowerPoint(self, key)
            self._sessions[key] = handle
        return handle

    async def register_controller(
        self,
        *,
        controller_id: str,
        generation: str,
        control_url: str,
        control_token: str,
        cdp_endpoint: str,
        owner_pid: int,
    ) -> None:
        controller = _PowerPointController(
            controller_id=controller_id,
            generation=generation,
            control_url=control_url,
            control_token=control_token,
            cdp_endpoint=cdp_endpoint,
            owner_pid=owner_pid,
        )
        async with self._lock:
            if self._controller == controller:
                return
            self._controller = controller
            self._connected_generation = None
            self._owner_generation += 1

    async def unregister_controller(self, controller_id: str) -> bool:
        async with self._lock:
            if self._controller is None or self._controller.controller_id != controller_id:
                return False
            self._controller = None
            self._connected_generation = None
            self._owner_generation += 1
            return True

    def controller_status(self) -> dict[str, Any]:
        controller = self._controller
        return controller.public_status() if controller is not None else {"available": False}

    async def release_sessions(self, session_ids: Iterable[str]) -> None:
        for session_id in dict.fromkeys(str(item) for item in session_ids):
            handle = self._sessions.get(session_id)
            if handle is not None:
                await self._release_handle(handle, discard=True)
                continue
            controller = self._controller
            if controller is not None:
                with suppress(Exception):
                    await controller.release_session(session_id)

    async def shutdown(self) -> None:
        async with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
            handles = tuple(self._sessions.values())
        for handle in handles:
            await self._release_handle(handle, discard=True)

    async def _client_for(self, handle: SessionPowerPoint) -> _SessionPowerPointClient:
        async with self._lock:
            if self._shutdown or self._sessions.get(handle.session_id) is not handle:
                raise RuntimeError("The PowerPoint connection has been released")
            current = handle._client
            if current is not None and current.is_live() and handle._owner_generation == self._owner_generation:
                return current
        if current is not None:
            await self._discard_client(handle, current)

        controller = await self._ensure_controller()
        surface = await controller.ensure_session(handle.session_id)
        if surface.target_id is None:
            raise RuntimeError("Electron PowerPoint Session has no CDP target")
        client = self._session_factory(controller.cdp_endpoint)
        try:
            await client.connect(surface.target_id, handle.session_id)
        except BaseException:
            await client.disconnect()
            raise
        async with self._lock:
            if self._shutdown or self._controller is not controller:
                await client.disconnect()
                raise RuntimeError("The PowerPoint controller changed during attach")
            handle._client = client
            handle._owner_generation = self._owner_generation
            handle._controller = controller
            return client

    async def _ensure_controller(self) -> _PowerPointController:
        async with self._connection_lock:
            async with self._lock:
                controller = self._controller
                if self._shutdown:
                    raise RuntimeError("The PowerPoint service has shut down")
                if controller is None:
                    raise _powerpoint_unavailable()
                if self._connected_generation == controller.generation:
                    return controller
            try:
                await controller.health()
            except Exception as exc:
                async with self._lock:
                    if self._controller is controller:
                        self._connected_generation = None
                        self._owner_generation += 1
                raise _powerpoint_unavailable(exc) from exc
            await asyncio.to_thread(self._prepare_playwright)
            async with self._lock:
                if self._controller is not controller:
                    raise _powerpoint_unavailable()
                self._connected_generation = controller.generation
                return controller

    async def _discard_client(self, handle: SessionPowerPoint, client: _SessionPowerPointClient) -> None:
        async with self._lock:
            if handle._client is client:
                handle._client = None
                handle._owner_generation = None
        await client.disconnect()

    async def _release_handle(self, handle: SessionPowerPoint, *, discard: bool) -> bool:
        async with handle._operation_lock:
            async with self._lock:
                client = handle._client
                controller = self._controller or handle._controller
                handle._client = None
                handle._owner_generation = None
                handle._controller = None
                if discard and self._sessions.get(handle.session_id) is handle:
                    self._sessions.pop(handle.session_id, None)
            if client is not None:
                await client.disconnect()
            if controller is None:
                return client is not None
            try:
                await controller.release_session(handle.session_id)
                return True
            except Exception:
                if not discard:
                    raise
                logger.warning(
                    "Could not release PowerPoint surface for Session %s",
                    handle.session_id,
                    exc_info=True,
                )
                return client is not None


__all__ = [
    "PowerPointHost",
    "PowerPointOperationError",
    "PowerPointUnavailableError",
    "SessionPowerPoint",
]
