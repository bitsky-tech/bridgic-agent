from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .runtime._environment import bundled_node_runtime
from .tools.powerpoint.session import (
    SessionPowerPoint,
    _PowerPointController,
    _SessionPowerPointClient,
    _powerpoint_unavailable,
)

logger = logging.getLogger(__name__)


class PowerPointHost:
    """Global owner that exposes one PPT state object per Agent Session."""

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

    def for_session(self, session_id: str, workspace_root: Optional[Path] = None) -> SessionPowerPoint:
        key = str(session_id or "").strip()
        if not key:
            raise ValueError("session_id is required to use PowerPoint")
        if self._shutdown:
            raise RuntimeError("The PowerPoint service has shut down")
        ppt = self._sessions.get(key)
        if ppt is None:
            ppt = SessionPowerPoint(self, key, workspace_root)
            self._sessions[key] = ppt
        elif workspace_root is not None:
            ppt.set_workspace_root(workspace_root)
        return ppt

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
            ppt = self._sessions.get(session_id)
            if ppt is not None:
                await self._release_handle(ppt, discard=True)
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
            ppts = tuple(self._sessions.values())
        for ppt in ppts:
            await self._release_handle(ppt, discard=True)

    async def _client_for(self, ppt: SessionPowerPoint) -> _SessionPowerPointClient:
        async with ppt._connection_lock:
            async with self._lock:
                if self._shutdown or self._sessions.get(ppt.session_id) is not ppt:
                    raise RuntimeError("The PowerPoint connection has been released")
                current = ppt._client
                if (
                    current is not None
                    and current.is_live()
                    and ppt._owner_generation == self._owner_generation
                ):
                    return current
            if current is not None:
                await self._discard_client(ppt, current)

            controller = await self._ensure_controller()
            surface = await controller.ensure_session(ppt.session_id)
            if surface.target_id is None:
                raise RuntimeError("Electron PowerPoint Session has no CDP target")
            client = self._session_factory(controller.cdp_endpoint)
            try:
                await client.connect(surface.target_id, ppt.session_id)
            except BaseException:
                await client.disconnect()
                raise
            async with self._lock:
                if self._shutdown or self._controller is not controller:
                    await client.disconnect()
                    raise RuntimeError("The PowerPoint controller changed during attach")
                ppt._client = client
                ppt._owner_generation = self._owner_generation
                ppt._controller = controller
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

    async def _discard_client(self, ppt: SessionPowerPoint, client: _SessionPowerPointClient) -> None:
        async with self._lock:
            if ppt._client is client:
                ppt._client = None
                ppt._owner_generation = None
        await client.disconnect()

    async def _release_handle(self, ppt: SessionPowerPoint, *, discard: bool) -> bool:
        async with ppt._connection_lock:
            async with self._lock:
                client = ppt._client
                controller = self._controller or ppt._controller
                ppt._client = None
                ppt._owner_generation = None
                ppt._controller = None
                if discard and self._sessions.get(ppt.session_id) is ppt:
                    self._sessions.pop(ppt.session_id, None)
            if client is not None:
                await client.disconnect()
            await ppt._clear()
            if controller is None:
                return client is not None
            try:
                await controller.release_session(ppt.session_id)
                return True
            except Exception:
                if not discard:
                    raise
                logger.warning(
                    "Could not release PowerPoint surface for Session %s",
                    ppt.session_id,
                    exc_info=True,
                )
                return client is not None



__all__ = ["PowerPointHost"]
