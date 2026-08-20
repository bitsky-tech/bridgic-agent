"""Foreground Uvicorn hosting for the Bridgic Agent service."""

from __future__ import annotations

import copy
import inspect
import os
import sys
from typing import Any, Awaitable, Callable, Optional, TYPE_CHECKING

import uvicorn

if TYPE_CHECKING:
    from ._manager import (
        ServerInstance,
        ServerInstanceLock,
        ServerOptions,
        ServerRegistration,
    )


LifecycleHook = Callable[[], Optional[Awaitable[None]]]


def log_config() -> dict[str, Any]:
    """Uvicorn's default logging, timestamped so field reports can be dated."""
    config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    for formatter in config["formatters"].values():
        formatter["fmt"] = f"%(asctime)s {formatter['fmt']}"
        formatter["datefmt"] = "%Y-%m-%d %H:%M:%S"
    return config


def reconfigure_streams() -> None:
    """Make the console streams UTF-8 and line buffered.

    Redirected output is block buffered, so a crashing process loses the tail
    of its own log, and a non-UTF-8 Windows console mojibakes OS error strings.
    Both turn a log file into a guessing game when it is the only evidence.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (OSError, ValueError):
            continue


class GracefulServer(uvicorn.Server):
    """Run hooks after socket startup and before connection shutdown."""

    def __init__(
        self,
        config: uvicorn.Config,
        *,
        post_startup: Optional[LifecycleHook] = None,
        pre_shutdown: Optional[LifecycleHook] = None,
    ) -> None:
        super().__init__(config)
        self._post_startup = post_startup
        self._pre_shutdown = pre_shutdown

    async def startup(self, sockets: Any = None) -> None:
        await super().startup(sockets=sockets)
        if not self.should_exit:
            await self._run_hook(self._post_startup, swallow=False)

    async def shutdown(self, sockets: Any = None) -> None:
        await self._run_hook(self._pre_shutdown, swallow=True)
        await super().shutdown(sockets=sockets)

    @staticmethod
    async def _run_hook(
        hook: Optional[LifecycleHook],
        *,
        swallow: bool,
    ) -> None:
        if hook is None:
            return
        try:
            result = hook()
            if inspect.isawaitable(result):
                await result
        except Exception as exc:  # noqa: BLE001 - shutdown must continue
            if not swallow:
                raise
            print(
                f"[GracefulServer] lifecycle hook failed: {exc}",
                file=sys.stderr,
            )


class UvicornRunner:
    """Own one managed foreground process from lock acquisition to cleanup."""

    def __init__(
        self,
        *,
        registration: ServerRegistration,
        instance_lock: ServerInstanceLock,
    ) -> None:
        self.registration = registration
        self.instance_lock = instance_lock

    def run(self, options: ServerOptions) -> None:
        """Run Uvicorn in the foreground using ``options``."""
        reconfigure_streams()
        if options.reload:
            self._run_reload(options)
            return

        self.instance_lock.acquire()
        published: Optional[ServerInstance] = None
        try:
            from .._app import ServiceApp

            service = ServiceApp(
                bind_host=options.host,
                bind_port=options.port,
            )

            def publish_registration() -> None:
                nonlocal published
                gateway = service.state.gateway
                published = self.registration.write(
                    instance_lock=self.instance_lock,
                    host=options.host,
                    port=options.port,
                    pid=os.getpid(),
                    started_at=gateway.started_at,
                    token=service.state.auth.current_token,
                    lock_file=self.instance_lock.path,
                    ws_path=gateway.ws_path,
                    version=gateway.version,
                )

            config = uvicorn.Config(
                service.app,
                host=options.host,
                port=options.port,
                log_level=options.log_level,
                log_config=log_config(),
                ws="websockets-sansio",
            )
            server = GracefulServer(
                config,
                post_startup=publish_registration,
                pre_shutdown=service.pre_shutdown_hook,
            )
            service.bind_shutdown(lambda: setattr(server, "should_exit", True))
            server.run()
        finally:
            if published is not None:
                self.registration.clear(
                    published,
                    instance_lock=self.instance_lock,
                )
            self.instance_lock.release()

    @staticmethod
    def _run_reload(options: ServerOptions) -> None:
        """Run an unmanaged development reloader."""
        uvicorn.run(
            "src.amphi_service.server._uvicorn:create_reload_app",
            factory=True,
            host=options.host,
            port=options.port,
            log_level=options.log_level,
            log_config=log_config(),
            reload=True,
            ws="websockets-sansio",
        )


def create_reload_app() -> Any:
    """Create the unmanaged ASGI application used by Uvicorn reload workers."""
    from .._app import ServiceApp

    return ServiceApp(bind_host=None, bind_port=None).app


__all__ = [
    "GracefulServer",
    "LifecycleHook",
    "UvicornRunner",
    "log_config",
    "reconfigure_streams",
]
