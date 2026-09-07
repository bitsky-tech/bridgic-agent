from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .runtime._environment import bundled_node_runtime
from .tools.browser.session import (
    EmbeddedBrowserUnavailableError,
    SessionBrowser,
    SessionBrowserState,
    _EmbeddedBrowserController,
    _SessionBrowserClient,
    _embedded_browser_unavailable,
)

logger = logging.getLogger(__name__)


class BrowserHost:
    """Connect Agent Sessions to the Electron-owned embedded browser.

    Parameters
    ----------
    prepare_playwright : callable, optional
        Inject the bundled Node-backed Playwright environment before CDP attach.
    session_factory : callable, optional
        Injectable client factory used by focused lifecycle tests.
    """

    def __init__(
        self,
        *,
        prepare_playwright: Optional[Callable[[], None]] = None,
        session_factory: Callable[..., _SessionBrowserClient] = _SessionBrowserClient,
    ) -> None:
        self._prepare_playwright = (
            prepare_playwright or bundled_node_runtime.apply_playwright_env
        )
        self._session_factory = session_factory
        self._lock = asyncio.Lock()
        self._connection_lock = asyncio.Lock()
        self._sessions: dict[str, SessionBrowser] = {}
        self._controller: Optional[_EmbeddedBrowserController] = None
        self._connected_controller_generation: Optional[str] = None
        self._owner_generation = 0
        self._shutdown = False

    def for_session(
        self,
        session_id: str,
        *,
        tool_result_dir: Optional[Path] = None,
    ) -> SessionBrowser:
        """Return the stable lazy browser handle for one exact Session."""
        key = str(session_id or "").strip()
        if not key:
            raise ValueError("session_id is required to open a browser")
        if self._shutdown:
            raise RuntimeError("The browser service has shut down")
        handle = self._sessions.get(key)
        if handle is None:
            handle = SessionBrowser(self, key, tool_result_dir=tool_result_dir)
            self._sessions[key] = handle
        elif tool_result_dir is not None:
            handle.bind_tool_result_dir(tool_result_dir)
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
        """Publish the Electron browser controller preferred by future sessions."""
        controller = _EmbeddedBrowserController(
            controller_id=controller_id,
            generation=generation,
            control_url=control_url,
            control_token=control_token,
            cdp_endpoint=cdp_endpoint,
            owner_pid=owner_pid,
        )
        async with self._lock:
            previous = self._controller
            if previous == controller:
                return
            self._controller = controller
            self._connected_controller_generation = None
            self._owner_generation += 1

    async def unregister_controller(self, controller_id: str) -> bool:
        """Remove one matching Electron controller without touching a replacement."""
        async with self._lock:
            controller = self._controller
            if controller is None or controller.controller_id != controller_id:
                return False
            self._controller = None
            self._connected_controller_generation = None
            self._owner_generation += 1
            return True

    def controller_status(self) -> dict[str, Any]:
        """Return the non-secret controller projection for service diagnostics."""
        controller = self._controller
        return controller.public_status() if controller is not None else {"available": False}

    async def release_sessions(self, session_ids: Iterable[str]) -> None:
        """Release selected Session surfaces without affecting siblings or login state."""
        released: set[str] = set()
        for session_id in session_ids:
            key = str(session_id)
            if key in released:
                continue
            released.add(key)
            handle = self._sessions.get(key)
            if handle is not None:
                await self._release_handle(handle, discard=True)
            else:
                await self._release_controller_surface(
                    key,
                    known_controller=None,
                    best_effort=True,
                )

    async def shutdown(self) -> None:
        """Drain Session surfaces without owning or closing Electron Chromium."""
        async with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
            handles = tuple(self._sessions.values())
            self._sessions.clear()
        for handle in handles:
            await self._release_handle(handle, discard=True)

    async def _client_for(self, handle: SessionBrowser) -> _SessionBrowserClient:
        while True:
            async with self._lock:
                if self._shutdown:
                    raise RuntimeError("The browser service has shut down")
                if self._sessions.get(handle.session_id) is not handle:
                    raise RuntimeError("The browser connection has been released")
                current = handle._client
                if current is not None and handle._client_is_live(current):
                    return current
                if current is not None:
                    handle._client = None
                    handle._owner_generation = None
                    handle._embedded_controller = None

            if current is not None:
                await self._disconnect_stale_client(current, handle.session_id)

            controller = await self._ensure_controller()
            async with self._lock:
                if self._controller is not controller:
                    continue
                generation = self._owner_generation
            client: Optional[_SessionBrowserClient] = None
            committed = False
            try:
                try:
                    client = await self._create_client(handle, controller)
                except EmbeddedBrowserUnavailableError:
                    await self._invalidate_controller(controller)
                    raise

                async with self._lock:
                    if (
                        not self._shutdown
                        and self._sessions.get(handle.session_id) is handle
                        and self._controller is controller
                        and self._owner_generation == generation
                    ):
                        handle._client = client
                        handle._owner_generation = generation
                        handle._embedded_controller = controller
                        committed = True
                        return client
            finally:
                if client is not None and not committed:
                    await self._disconnect_stale_client(client, handle.session_id)

            async with self._lock:
                if self._shutdown:
                    raise RuntimeError("The browser service has shut down")
                if self._sessions.get(handle.session_id) is not handle:
                    raise RuntimeError("The browser connection has been released")

    async def _state_for(self, handle: SessionBrowser) -> Optional[SessionBrowserState]:
        """Read one Session surface without entering the browser owner lifecycle."""
        async with self._lock:
            if self._shutdown or self._sessions.get(handle.session_id) is not handle:
                return None
            controller = self._controller
        if controller is None:
            return None
        try:
            inventory = await controller.list_tabs(handle.session_id)
        except EmbeddedBrowserUnavailableError:
            await self._invalidate_controller(controller)
            return None
        except Exception:
            logger.debug(
                "Could not read embedded browser state for Session %s",
                handle.session_id,
                exc_info=True,
            )
            return None
        async with self._lock:
            if (
                self._shutdown
                or self._sessions.get(handle.session_id) is not handle
                or self._controller is not controller
            ):
                return None
        return inventory.state

    async def _discard_stale_client(
        self,
        handle: SessionBrowser,
        client: _SessionBrowserClient,
    ) -> None:
        """Forget one local client while preserving its Electron Session surface."""
        async with self._lock:
            if handle._client is client:
                handle._client = None
                handle._owner_generation = None
        await self._disconnect_stale_client(client, handle.session_id)

    @staticmethod
    async def _disconnect_stale_client(client: _SessionBrowserClient, session_id: str) -> None:
        try:
            await client.disconnect_embedded()
        except Exception:
            logger.warning(
                "Failed to disconnect stale browser client for Session %s",
                session_id,
                exc_info=True,
            )

    async def _release_handle(self, handle: SessionBrowser, *, discard: bool) -> bool:
        async with handle._operation_lock:
            async with self._lock:
                client = handle._client
                known_controller = handle._embedded_controller
                handle._client = None
                handle._owner_generation = None
                handle._embedded_controller = None
                if discard and self._sessions.get(handle.session_id) is handle:
                    self._sessions.pop(handle.session_id, None)
            client_closed = False
            if client is not None:
                try:
                    await client.close()
                    client_closed = True
                except Exception:
                    if not discard:
                        raise
                    logger.warning(
                        "Failed to close browser surface for Session %s",
                        handle.session_id,
                        exc_info=True,
                    )
            controller_released = await self._release_controller_surface(
                handle.session_id,
                known_controller=known_controller,
                best_effort=discard,
            )
        return client_closed or controller_released

    async def _release_controller_surface(
        self,
        session_id: str,
        *,
        known_controller: Optional[_EmbeddedBrowserController],
        best_effort: bool,
    ) -> bool:
        """Release an existing Electron surface without ensuring one exists."""
        released = False
        for _attempt in range(2):
            async with self._lock:
                current = self._controller
            controller = current or known_controller
            if controller is None:
                return released

            known_surface = self._same_controller_surface(controller, known_controller)
            if not known_surface:
                try:
                    inventory = await controller.list_tabs(session_id)
                except EmbeddedBrowserUnavailableError:
                    await self._invalidate_controller(controller)
                    if not best_effort:
                        raise
                    return released
                except Exception:
                    async with self._lock:
                        if current is not self._controller:
                            continue
                    if not best_effort:
                        raise
                    logger.warning(
                        "Could not inspect browser surface before closing Session %s",
                        session_id,
                        exc_info=True,
                    )
                    return released
                if inventory.state is None and not inventory.target_ids:
                    async with self._lock:
                        if current is not self._controller:
                            continue
                    return released
                async with self._lock:
                    if current is not self._controller:
                        continue

            try:
                await controller.release_session(session_id)
            except EmbeddedBrowserUnavailableError:
                await self._invalidate_controller(controller)
                if not best_effort:
                    raise
                return released
            except Exception:
                async with self._lock:
                    if current is not self._controller:
                        known_controller = None
                        continue
                if not best_effort:
                    raise
                logger.warning(
                    "Could not release browser surface for Session %s",
                    session_id,
                    exc_info=True,
                )
                return released
            released = True
            async with self._lock:
                if current is self._controller:
                    return True
                known_controller = None
        return released

    @staticmethod
    def _same_controller_surface(
        left: _EmbeddedBrowserController,
        right: Optional[_EmbeddedBrowserController],
    ) -> bool:
        if right is None:
            return False
        if left is right:
            return True
        return (
            left.controller_id == right.controller_id
            and left.generation == right.generation
        )

    async def _create_client(
        self,
        handle: SessionBrowser,
        controller: _EmbeddedBrowserController,
    ) -> _SessionBrowserClient:
        session_id = handle.session_id
        client: Optional[_SessionBrowserClient] = None
        try:
            tabs = await controller.ensure_session(session_id)
            handle._embedded_controller = controller
            target_id = tabs.active_target_id
            if target_id is None:
                raise RuntimeError("Electron browser Session has no active tab")
            client = self._session_factory(
                cdp=controller.cdp_endpoint,
                headless=False,
                auto_follow_popups=True,
                stealth=False,
                snapshot_output_dir=handle.tool_result_dir,
                embedded_controller=controller,
                embedded_session_id=session_id,
            )
            await client.start_and_bind_embedded(target_id)
            return client
        except BaseException:
            if client is not None:
                with suppress(Exception):
                    await client.disconnect_embedded()
            logger.warning(
                "Embedded browser attach failed; the Session may retry",
                exc_info=True,
            )
            raise

    async def _ensure_controller(self) -> _EmbeddedBrowserController:
        """Health-check and prepare one registered Electron controller generation."""
        async with self._connection_lock:
            while True:
                async with self._lock:
                    if self._shutdown:
                        raise RuntimeError("The browser service has shut down")
                    controller = self._controller
                    if controller is None:
                        raise _embedded_browser_unavailable()
                    if self._connected_controller_generation == controller.generation:
                        return controller

                try:
                    await controller.health()
                except EmbeddedBrowserUnavailableError:
                    await self._invalidate_controller(controller)
                    raise
                except Exception as exc:
                    await self._invalidate_controller(controller)
                    raise _embedded_browser_unavailable(exc) from exc

                await asyncio.to_thread(self._prepare_playwright)
                async with self._lock:
                    if self._shutdown:
                        raise RuntimeError("The browser service has shut down")
                    if self._controller is not controller:
                        continue
                    self._connected_controller_generation = controller.generation
                    return controller

    async def _invalidate_controller(
        self,
        controller: Optional[_EmbeddedBrowserController],
    ) -> None:
        if controller is None:
            return
        async with self._lock:
            if self._controller is controller:
                self._connected_controller_generation = None
                self._owner_generation += 1



__all__ = ["BrowserHost"]
